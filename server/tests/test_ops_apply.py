import pytest

from pkm.contracts.ops import OpBatch, text_hash
from pkm.server import ops_apply
from pkm.server.db import open_db
from pkm.server.ops_apply import _parent_chain, _subtree_deepest_first, apply_batch
from pkm.server.ops_core import OpError

NOW = 1_800_000_000_000


@pytest.fixture()
def db(seeded_config):
    con = open_db(seeded_config.db_path)
    yield con
    con.close()


_batch_counter = 0

def _batch(*ops) -> OpBatch:
    global _batch_counter
    _batch_counter += 1
    return OpBatch(client_id="t", batch_id=f"test_batch_{_batch_counter:08d}",
                   ops=list(ops))


def _linear_chain(page_title: str, depth: int, prefix: str = "level"):
    """CreateOps for a straight-line hierarchy of `depth` blocks, each
    nested one under the previous: prefix0 (top-level) .. prefix{depth-1}
    (deepest leaf)."""
    ops = []
    parent = None
    for i in range(depth):
        uid = f"{prefix}{i}"
        ops.append({"op": "create", "uid": uid, "page_title": page_title,
                    "parent_uid": parent, "order_idx": 0, "text": f"n{i}"})
        parent = uid
    return ops


def test_create_inserts_shifts_and_derives_refs(db):
    apply_batch(db, _batch(
        {"op": "create", "uid": "newuid1", "page_title": "Machine Learning",
         "parent_uid": None, "order_idx": 0, "text": "see [[Brand New]] #AI",
         "view_type": "numbered"},
    ), NOW)
    db.commit()
    rows = db.execute(
        "SELECT uid, order_idx FROM blocks WHERE page_id = 1"
        "  AND parent_uid IS NULL ORDER BY order_idx").fetchall()
    assert [(r["uid"], r["order_idx"]) for r in rows] == \
        [("newuid1", 0), ("uid_b1", 1), ("uid_b2", 2)]
    assert db.execute(
        "SELECT view_type FROM blocks WHERE uid = 'newuid1'"
    ).fetchone()[0] == "numbered"
    # implicit page creation + refs
    new_page = db.execute(
        "SELECT id FROM pages WHERE title = 'Brand New'").fetchone()
    assert new_page is not None
    kinds = {(r["target_page_id"], r["kind"]) for r in db.execute(
        "SELECT target_page_id, kind FROM refs WHERE src_block_uid='newuid1'")}
    assert kinds == {(new_page["id"], "link"), (2, "tag")}
    # FTS row exists (triggers)
    hit = db.execute("SELECT rowid FROM blocks_fts WHERE blocks_fts"
                     " MATCH '\"Brand\"'").fetchall()
    assert len(hit) == 1
    # page touched
    assert db.execute("SELECT updated_at FROM pages WHERE id=1"
                      ).fetchone()[0] == NOW


def test_update_text_rederives_refs_and_fts(db):
    apply_batch(db, _batch(
        {"op": "update_text", "uid": "uid_b4", "text": "now [[Paper]] only"},
    ), NOW)
    db.commit()
    refs = db.execute("SELECT target_page_id, kind FROM refs"
                      " WHERE src_block_uid='uid_b4'").fetchall()
    assert [(r[0], r[1]) for r in refs] == [(4, "link")]  # ML link gone
    assert db.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH '\"Studying\"'").fetchone()[0] == 0


def test_delete_removes_subtree_and_fts(db):
    apply_batch(db, _batch({"op": "delete", "uid": "uid_b2"}), NOW)
    db.commit()
    left = {r[0] for r in db.execute(
        "SELECT uid FROM blocks WHERE page_id = 1")}
    assert left == {"uid_b1"}          # uid_b2 and child uid_b3 gone
    assert db.execute("SELECT count(*) FROM refs WHERE src_block_uid='uid_b3'"
                      ).fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH '\"Papers\"'").fetchone()[0] == 0


def test_move_reparents_and_shifts(db):
    apply_batch(db, _batch(
        {"op": "move", "uid": "uid_b3", "parent_uid": None, "order_idx": 0},
    ), NOW)
    db.commit()
    row = db.execute("SELECT parent_uid, order_idx FROM blocks"
                     " WHERE uid='uid_b3'").fetchone()
    assert row["parent_uid"] is None and row["order_idx"] == 0
    # uid_b1/uid_b2 shifted to make room
    assert db.execute("SELECT order_idx FROM blocks WHERE uid='uid_b1'"
                      ).fetchone()[0] == 1


def test_move_cycle_against_db_chain(db):
    # child of uid_b2 is uid_b3; moving uid_b2 under uid_b3 must fail
    with pytest.raises(OpError, match="cycle"):
        apply_batch(db, _batch(
            {"op": "move", "uid": "uid_b2", "parent_uid": "uid_b3",
             "order_idx": 0}), NOW)
    db.rollback()


@pytest.mark.parametrize("depth", [100, 101, 102, 150])
def test_move_root_under_own_descendant_always_raises_cycle(db, depth):
    # A move that would nest a hierarchy under its own descendant must be
    # rejected at every depth, not just within the old 100-level cap: ancestry
    # traversal has to see the full chain to notice op.uid reappearing in it.
    apply_batch(db, _batch(*_linear_chain("Machine Learning", depth)), NOW)
    db.commit()
    deepest = f"level{depth - 1}"
    with pytest.raises(OpError, match="cycle"):
        apply_batch(db, _batch(
            {"op": "move", "uid": "level0", "parent_uid": deepest,
             "order_idx": 0}), NOW)
    db.rollback()


@pytest.mark.parametrize("depth", [100, 101, 102, 150])
def test_cross_page_move_updates_every_descendant(db, depth):
    # SetPageId must cover the whole subtree: a descendant left behind on the
    # source page after a cross-page move is silent corruption (its parent is
    # now on a different page than it is).
    apply_batch(db, _batch(*_linear_chain("Machine Learning", depth)), NOW)
    db.commit()
    apply_batch(db, _batch(
        {"op": "move", "uid": "level0", "parent_uid": None, "order_idx": 0,
         "page_title": "AI"}), NOW)
    db.commit()
    ai_page_id = db.execute(
        "SELECT id FROM pages WHERE title='AI'").fetchone()[0]
    uids = [f"level{i}" for i in range(depth)]
    placeholders = ",".join("?" * depth)
    rows = db.execute(
        f"SELECT uid, page_id FROM blocks WHERE uid IN ({placeholders})",
        uids).fetchall()
    assert len(rows) == depth
    stranded = [r["uid"] for r in rows if r["page_id"] != ai_page_id]
    assert stranded == []


@pytest.mark.parametrize("depth", [100, 101, 102, 150])
def test_delete_removes_entire_deep_subtree(db, depth):
    # Subtree enumeration for delete must not silently truncate: anything
    # left behind past the old cap is an orphaned block nobody can reach.
    apply_batch(db, _batch(*_linear_chain("Machine Learning", depth)), NOW)
    db.commit()
    apply_batch(db, _batch({"op": "delete", "uid": "level0"}), NOW)
    db.commit()
    remaining = db.execute(
        "SELECT count(*) FROM blocks WHERE uid LIKE 'level%'").fetchone()[0]
    assert remaining == 0


def test_parent_chain_and_subtree_terminate_on_preexisting_cycle(db):
    # ops rejects any move that would CREATE a cycle, but a corrupted DB
    # could already contain one (e.g. from before this fix, or manual
    # tampering). The traversal guard must be what stops recursion in that
    # case, not the depth cap this bug removed -- an unguarded recursive CTE
    # over a real cycle never terminates on its own. Exercised directly on
    # the two traversal functions so a regressed guard fails this test
    # (finite-but-wrong, or a hang) rather than being masked by any caller.
    apply_batch(db, _batch(*_linear_chain("Machine Learning", 5, prefix="cycle")),
               NOW)
    db.commit()
    # Close the chain into a cycle by hand: ops_core's plan_op would refuse
    # this via a MoveOp, so go straight to SQL to manufacture the corruption.
    db.execute("UPDATE blocks SET parent_uid = 'cycle4' WHERE uid = 'cycle0'")
    db.commit()
    expected = {"cycle0", "cycle1", "cycle2", "cycle3", "cycle4"}

    chain = _parent_chain(db, "cycle4")
    assert set(chain) == expected
    assert len(chain) == len(expected)          # no duplicate re-walks

    subtree = _subtree_deepest_first(db, "cycle0")
    assert set(subtree) == expected
    assert len(subtree) == len(expected)


def test_set_heading_updates_and_clears(db):
    apply_batch(db, _batch(
        {"op": "set_heading", "uid": "uid_b2", "heading": 1},
    ), NOW)
    db.commit()
    assert db.execute("SELECT heading FROM blocks WHERE uid='uid_b2'"
                      ).fetchone()[0] == 1
    apply_batch(db, _batch(
        {"op": "set_heading", "uid": "uid_b2", "heading": None},
    ), NOW)
    db.commit()
    assert db.execute("SELECT heading FROM blocks WHERE uid='uid_b2'"
                      ).fetchone()[0] is None


def test_set_view_type_updates_metadata_without_changing_block_state(db):
    before = db.execute(
        "SELECT text, parent_uid, order_idx, collapsed FROM blocks"
        " WHERE uid='uid_b2'").fetchone()
    apply_batch(db, _batch(
        {"op": "set_view_type", "uid": "uid_b2", "view_type": "numbered"},
    ), NOW)
    db.commit()
    row = db.execute(
        "SELECT text, parent_uid, order_idx, collapsed, view_type FROM blocks"
        " WHERE uid='uid_b2'").fetchone()
    assert tuple(row[:4]) == tuple(before)
    assert row["view_type"] == "numbered"


def test_conflict_sibling_uid_retries_until_alphanumeric_first_char(
        db, monkeypatch):
    # The server mints a fresh uid for the conflict-copy sibling the same
    # way the CLI mints uids for new blocks; a leading '-' or '_' would make
    # that sibling unaddressable via a bare CLI argument (pkm-y5yv).
    candidates = iter(["-leadingdash1", "goodstart123"])
    monkeypatch.setattr(ops_apply.secrets, "token_urlsafe",
                        lambda n: next(candidates))
    apply_batch(db, _batch(
        {"op": "update_text", "uid": "uid_b1", "text": "offline edit",
         "base_text_hash": text_hash("some stale base")},
    ), NOW)
    db.commit()
    row = db.execute(
        "SELECT uid FROM blocks WHERE text = '[[conflict]] Tags:: #AI'"
    ).fetchone()
    assert row["uid"] == "goodstart123"


def test_op_error_index_reports_failing_op(db):
    with pytest.raises(OpError) as e:
        apply_batch(db, _batch(
            {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True},
            {"op": "delete", "uid": "ghost99"},
        ), NOW)
    assert e.value.index == 1
    db.rollback()
    assert db.execute("SELECT collapsed FROM blocks WHERE uid='uid_b2'"
                      ).fetchone()[0] == 0  # rollback undid op 0
