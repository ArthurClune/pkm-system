from datetime import date
from typing import get_args

import pytest

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import (BlockUid, OpBatch, Sha256Hex, subtree_hash,
                               text_hash)
from pkm.server import ops_apply, ops_core
from pkm.server.db import open_db
from pkm.server.ops_apply import (_parent_chain, _subtree_deepest_first,
                                  _subtree_rows, apply_batch)
from pkm.server.ops_core import OpError, SubtreeRow

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


def test_set_collapsed_does_not_bump_block_or_page_updated_at(db):
    # Give the block and page a known "before" so unchanged-ness is
    # provable, not just "still NULL".
    db.execute("UPDATE blocks SET updated_at = ? WHERE uid = 'uid_b2'", (1_000,))
    db.execute("UPDATE pages SET updated_at = ? WHERE id = 1", (1_000,))
    db.commit()

    apply_batch(db, _batch(
        {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True},
    ), NOW)
    db.commit()

    row = db.execute("SELECT collapsed, updated_at FROM blocks"
                     " WHERE uid='uid_b2'").fetchone()
    assert row["collapsed"] == 1                # the toggle did apply...
    assert row["updated_at"] == 1_000            # ...but not a "real" change
    assert db.execute("SELECT updated_at FROM pages WHERE id=1"
                      ).fetchone()[0] == 1_000

    # contrast: a real edit on the same block/page DOES bump both.
    apply_batch(db, _batch(
        {"op": "update_text", "uid": "uid_b2", "text": "Papers (renamed)"},
    ), NOW)
    db.commit()
    assert db.execute("SELECT updated_at FROM blocks WHERE uid='uid_b2'"
                      ).fetchone()[0] == NOW
    assert db.execute("SELECT updated_at FROM pages WHERE id=1"
                      ).fetchone()[0] == NOW


def test_set_collapsed_still_journals_a_change_but_no_page_touch(db):
    # The AFTER UPDATE trigger fires on every column change regardless of
    # whether updated_at moved, so collapse-only batches still sync -- but
    # unlike update_text (test above), no page row is touched either.
    before = db.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
    apply_batch(db, _batch(
        {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True},
    ), NOW)
    db.commit()
    rows = db.execute("SELECT kind, entity_id FROM changes WHERE seq > ?",
                      (before,)).fetchall()
    assert ("block", "uid_b2") in {(r["kind"], r["entity_id"]) for r in rows}
    assert not any(r["kind"] == "page" for r in rows)


def test_create_broadcast_uses_the_stored_page_title(db):
    title = "Paper/Levels of AGI:\nthe Path to AGI"
    broadcast = apply_batch(db, _batch(
        {"op": "create", "uid": "titlecast1", "page_title": title,
         "parent_uid": None, "order_idx": 0, "text": "body text"},
    ), NOW).broadcast_ops

    assert broadcast == [{
        "op": "create",
        "uid": "titlecast1",
        "page_title": "Paper/Levels of AGI: the Path to AGI",
        "parent_uid": None,
        "order_idx": 0,
        "text": "body text",
        "heading": None,
        "view_type": None,
    }]


def test_create_page_broadcast_uses_the_stored_page_title(db):
    broadcast = apply_batch(db, _batch(
        {"op": "create_page", "page_title": "Paper/Levels of AGI:\nthe Path to AGI"},
    ), NOW).broadcast_ops

    assert broadcast == [{
        "op": "create_page",
        "page_title": "Paper/Levels of AGI: the Path to AGI",
    }]


def test_move_broadcast_uses_the_destination_page_title_after_apply(db):
    broadcast = apply_batch(db, _batch(
        {"op": "move", "uid": "uid_b4", "parent_uid": None,
         "order_idx": 0, "page_title": "Paper/Levels of AGI:\nthe Path to AGI"},
    ), NOW).broadcast_ops

    assert broadcast == [{
        "op": "move",
        "uid": "uid_b4",
        "parent_uid": None,
        "order_idx": 0,
        "page_title": "Paper/Levels of AGI: the Path to AGI",
    }]


@pytest.mark.parametrize(
    "op",
    [
        {
            "op": "create",
            "uid": "missingtitle1",
            "page_title": "Caller Create Spelling",
            "parent_uid": None,
            "order_idx": 0,
            "text": "body",
        },
        {"op": "create_page", "page_title": "Caller Page Spelling"},
        {
            "op": "move",
            "uid": "uid_b4",
            "parent_uid": None,
            "order_idx": 0,
            "page_title": "Caller Move Spelling",
        },
    ],
    ids=["create", "create_page", "resolved_move"],
)
def test_applied_page_broadcast_fails_closed_when_authoritative_title_is_missing(
        db, monkeypatch, op):
    """Mutation caught: fall back to op.model_dump() caller spelling."""
    monkeypatch.setattr(ops_apply, "_page_title", lambda *_args: None)

    with pytest.raises(AssertionError, match="authoritative page title"):
        apply_batch(db, _batch(op), NOW)


def test_same_page_move_broadcast_keeps_page_title_null(db):
    broadcast = apply_batch(db, _batch(
        {"op": "move", "uid": "uid_b3", "parent_uid": None, "order_idx": 0},
    ), NOW).broadcast_ops

    assert broadcast == [{
        "op": "move",
        "uid": "uid_b3",
        "parent_uid": None,
        "order_idx": 0,
        "page_title": None,
    }]


def test_move_cycle_against_db_chain(db):
    # child of uid_b2 is uid_b3; moving uid_b2 under uid_b3 is skipped
    result = apply_batch(db, _batch(
        {"op": "move", "uid": "uid_b2", "parent_uid": "uid_b3",
         "order_idx": 0}), NOW)
    assert [s["reason"] for s in result.skipped] == ["cycle"]
    assert result.broadcast_ops == []
    row = db.execute("SELECT parent_uid, order_idx FROM blocks"
                     " WHERE uid = 'uid_b2'").fetchone()
    assert (row["parent_uid"], row["order_idx"]) == (None, 1)


@pytest.mark.parametrize("depth", [100, 101, 102, 150])
def test_move_root_under_own_descendant_is_always_a_cycle(db, depth):
    # A move that would nest a hierarchy under its own descendant must be
    # caught at every depth, not just within the old 100-level cap: ancestry
    # traversal has to see the full chain to notice op.uid reappearing in it.
    apply_batch(db, _batch(*_linear_chain("Machine Learning", depth)), NOW)
    db.commit()
    deepest = f"level{depth - 1}"
    result = apply_batch(db, _batch(
        {"op": "move", "uid": "level0", "parent_uid": deepest,
         "order_idx": 0}), NOW)
    assert [s["reason"] for s in result.skipped] == ["cycle"]
    assert db.execute("SELECT parent_uid FROM blocks WHERE uid = 'level0'"
                      ).fetchone()[0] is None


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
    # ops skips any move that would CREATE a cycle, but a corrupted DB
    # could already contain one (e.g. from before this fix, or manual
    # tampering). The traversal guard must be what stops recursion in that
    # case, not the depth cap this bug removed -- an unguarded recursive CTE
    # over a real cycle never terminates on its own. Exercised directly on
    # the two traversal functions so a regressed guard fails this test
    # (finite-but-wrong, or a hang) rather than being masked by any caller.
    apply_batch(db, _batch(*_linear_chain("Machine Learning", 5, prefix="cycle")),
               NOW)
    db.commit()
    # Close the chain into a cycle by hand: ops_core's plan_op would skip
    # this as a MoveOp, so go straight to SQL to manufacture the corruption.
    db.execute("UPDATE blocks SET parent_uid = 'cycle4' WHERE uid = 'cycle0'")
    db.commit()
    expected = {"cycle0", "cycle1", "cycle2", "cycle3", "cycle4"}

    chain = _parent_chain(db, "cycle4")
    assert set(chain) == expected
    assert len(chain) == len(expected)          # no duplicate re-walks

    subtree = _subtree_deepest_first(db, "cycle0")
    assert set(subtree) == expected
    assert len(subtree) == len(expected)


def test_subtree_rows_is_deepest_first_with_columns(db):
    # One query reads what both the hash and the conflict copies need:
    # every block of the subtree with its parent, position and text,
    # children before parents like _subtree_deepest_first.
    apply_batch(db, _batch(
        {"op": "create", "uid": "rows_c1", "page_title": "Machine Learning",
         "parent_uid": "uid_b2", "order_idx": 1, "text": "second child"},
        {"op": "create", "uid": "rows_g1", "page_title": "Machine Learning",
         "parent_uid": "uid_b3", "order_idx": 0, "text": "grandchild"},
    ), NOW)
    db.commit()
    rows = _subtree_rows(db, "uid_b2")
    assert rows[0] == SubtreeRow(BlockUid("rows_g1"), BlockUid("uid_b3"), 0,
                                 "grandchild")
    assert set(rows[1:3]) == {
        SubtreeRow(BlockUid("uid_b3"), BlockUid("uid_b2"), 0,
                   "[[Attention Is All You Need]] is a [[Paper]]"),
        SubtreeRow(BlockUid("rows_c1"), BlockUid("uid_b2"), 1,
                   "second child")}
    assert rows[3] == SubtreeRow(BlockUid("uid_b2"), None, 1, "Papers")
    assert (sorted(r.uid for r in rows)
            == sorted(_subtree_deepest_first(db, "uid_b2")))
    assert _subtree_rows(db, "no_such_uid") == ()


def test_subtree_rows_terminates_on_preexisting_cycle(db):
    apply_batch(db, _batch(*_linear_chain("Machine Learning", 5, prefix="cycrow")),
                NOW)
    db.commit()
    db.execute("UPDATE blocks SET parent_uid = 'cycrow4' WHERE uid = 'cycrow0'")
    db.commit()
    rows = _subtree_rows(db, "cycrow0")
    assert sorted(r.uid for r in rows) == [f"cycrow{i}" for i in range(5)]


def test_diverged_delete_of_a_preexisting_cycle_copies_each_block_once(db):
    # corrupted data must not turn a guarded delete into a crash or a
    # runaway walk: the root is the walk's start, never its own descendant
    apply_batch(db, _batch(*_linear_chain("Machine Learning", 3, prefix="cycdel")),
                NOW)
    db.commit()
    db.execute("UPDATE blocks SET parent_uid = 'cycdel2' WHERE uid = 'cycdel0'")
    db.commit()
    apply_batch(db, _batch({"op": "delete", "uid": "cycdel0",
                            "base_subtree_hash": Sha256Hex("0" * 64)}), NOW)
    db.commit()
    assert db.execute("SELECT count(*) FROM blocks WHERE uid LIKE 'cycdel%'"
                      ).fetchone()[0] == 0
    copies = db.execute(
        "SELECT b.text FROM blocks b JOIN pages p ON p.id = b.page_id"
        " WHERE p.title = ? AND b.text IN ('n0', 'n1', 'n2')",
        (title_for_date(date.today()),)).fetchall()
    assert sorted(r["text"] for r in copies) == ["n0", "n1", "n2"]


def test_diverged_delete_mints_header_then_root_then_descendants(
        db, monkeypatch):
    # header and root entry come from _conflict_landing (header first, as
    # every conflict path mints them); one uid per descendant follows, in
    # the deepest-first order of the subtree's rows
    apply_batch(db, _batch(
        {"op": "create", "uid": "mint_c2", "page_title": "Machine Learning",
         "parent_uid": "uid_b2", "order_idx": 1, "text": "second child"},
    ), NOW)
    db.commit()
    minted = iter(["hdrmint00001", "rootmint0001", "descmint0001",
                   "descmint0002"])
    monkeypatch.setattr(ops_apply.secrets, "token_urlsafe",
                        lambda n: next(minted))
    op = OpBatch.model_validate({"client_id": "t", "batch_id": "mint_order",
        "ops": [{"op": "delete", "uid": "uid_b2",
                 "base_subtree_hash": "0" * 64}]}).ops[0]
    ctx = ops_apply._context_for(db, op, NOW)
    assert isinstance(ctx, ops_core.DeleteConflictContext)
    assert isinstance(ctx.landing.header, ops_core.FreshHeader)
    assert ctx.landing.header.uid == "hdrmint00001"
    assert ctx.landing.entry_uid == "rootmint0001"
    non_root = [r.uid for r in ctx.rows if r.uid != "uid_b2"]
    assert dict(ctx.copy_uids) == dict(zip(
        non_root, ["descmint0001", "descmint0002"], strict=True))


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


def test_conflict_uids_retry_until_alphanumeric_first_char(db, monkeypatch):
    # The server mints fresh uids for the conflict header and its child the
    # same way the CLI mints uids for new blocks; a leading '-' or '_' would
    # make either unaddressable via a bare CLI argument.
    candidates = iter(["-leadingdash1", "goodheader12",
                       "_underscore12", "goodchild123"])
    monkeypatch.setattr(ops_apply.secrets, "token_urlsafe",
                        lambda n: next(candidates))
    apply_batch(db, _batch(
        {"op": "update_text", "uid": "uid_b1", "text": "offline edit",
         "base_text_hash": text_hash("some stale base")},
    ), NOW)
    db.commit()
    child = db.execute(
        "SELECT b.uid, b.parent_uid FROM blocks b JOIN pages p"
        " ON p.id = b.page_id WHERE b.text = 'Tags:: #AI' AND p.title = ?",
        (title_for_date(date.today()),)).fetchone()
    assert (child["uid"], child["parent_uid"]) == ("goodchild123",
                                                   "goodheader12")


@pytest.mark.parametrize(
    ("op", "source", "title"),
    [
        (
            {"op": "create_page", "page_title": "New #Old"},
            "page_title",
            "New #Old",
        ),
        (
            {"op": "create", "uid": "syntax01", "page_title": "New #Old",
             "parent_uid": None, "order_idx": 0, "text": "plain"},
            "page_title",
            "New #Old",
        ),
        (
            {"op": "move", "uid": "uid_b4", "parent_uid": None,
             "order_idx": 0, "page_title": "New #Old"},
            "page_title",
            "New #Old",
        ),
        (
            {"op": "create", "uid": "syntax02", "page_title": "AI",
             "parent_uid": None, "order_idx": 0,
             "text": "[[Safe Ref]] then [[New #Old]]"},
            "reference",
            "New #Old",
        ),
        (
            {"op": "update_text", "uid": "uid_b4",
             "text": "[[Safe Ref]] then [[New #Old]]"},
            "reference",
            "New #Old",
        ),
    ],
    ids=["create_page", "create", "move", "create_ref", "update_ref"],
)
def test_find_op_title_violation_covers_every_title_source(op, source, title):
    violation = ops_core.find_op_title_violation(_batch(op).ops)

    assert violation is not None
    assert (
        violation.op_index,
        violation.source,
        violation.title,
        violation.reason,
    ) == (0, source, title, "forbidden_syntax")


def test_find_op_title_violation_checks_explicit_title_before_text_refs():
    violation = ops_core.find_op_title_violation(_batch(
        {"op": "create", "uid": "syntax03", "page_title": "Bad #Page",
         "parent_uid": None, "order_idx": 0, "text": "[[Bad #Ref]]"},
    ).ops)

    assert violation is not None
    assert (violation.source, violation.title) == ("page_title", "Bad #Page")


def test_find_op_title_violation_rejects_outer_nested_ref_first():
    violation = ops_core.find_op_title_violation(_batch(
        {"op": "create", "uid": "syntax04", "page_title": "AI",
         "parent_uid": None, "order_idx": 0,
         "text": "[[Outer [[New #Old]]]]"},
    ).ops)

    assert violation is not None
    assert (violation.source, violation.title) == (
        "reference",
        "Outer [[New #Old]]",
    )


def test_apply_batch_preflights_every_op_before_context_or_mutation(db):
    before = {
        "pages": db.execute("SELECT * FROM pages ORDER BY id").fetchall(),
        "blocks": db.execute("SELECT * FROM blocks ORDER BY uid").fetchall(),
        "refs": db.execute(
            "SELECT * FROM refs ORDER BY src_block_uid, target_page_id, kind"
        ).fetchall(),
        "changes": db.execute("SELECT * FROM changes ORDER BY seq").fetchall(),
    }

    with pytest.raises(OpError) as exc:
        apply_batch(db, _batch(
            {"op": "create", "uid": "atomicgood1",
             "page_title": "Atomic First Page", "parent_uid": None,
             "order_idx": 0, "text": "[[Atomic Safe Ref]]"},
            {"op": "update_text", "uid": "uid_b4",
             "text": "[[New #Old]]"},
        ), NOW)

    assert (exc.value.index, exc.value.reason) == (
        1,
        "unsupported reference title syntax: 'New #Old'",
    )
    after = {
        "pages": db.execute("SELECT * FROM pages ORDER BY id").fetchall(),
        "blocks": db.execute("SELECT * FROM blocks ORDER BY uid").fetchall(),
        "refs": db.execute(
            "SELECT * FROM refs ORDER BY src_block_uid, target_page_id, kind"
        ).fetchall(),
        "changes": db.execute("SELECT * FROM changes ORDER BY seq").fetchall(),
    }
    assert after == before


def test_op_error_index_reports_failing_op(db):
    with pytest.raises(OpError) as e:
        apply_batch(db, _batch(
            {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True},
            {"op": "create", "uid": "uid_b1", "page_title": "AI",
             "order_idx": 0, "text": "dup"},  # uid exists
        ), NOW)
    assert e.value.index == 1
    db.rollback()
    assert db.execute("SELECT collapsed FROM blocks WHERE uid='uid_b2'"
                      ).fetchone()[0] == 0  # rollback undid op 0


# --- replaying recorded rename/merge rewrites ------------------------------


def _rewrite_chain(steps: int) -> tuple[ops_core.BlockRewrite, ...]:
    """Records for `steps` successive renames of one block's only ref:
    "[[T0]]" -> "[[T1]]" -> ... Newest first, as the shell orders them."""
    records = []
    text = "[[T0]]"
    for i in range(steps):
        after = f"[[T{i + 1}]]"
        records.append(ops_core.BlockRewrite(
            base_hash=text_hash(text), after_hash=text_hash(after),
            old_title=f"T{i}", new_title=f"T{i + 1}"))
        text = after
    return tuple(reversed(records))


def test_replay_follows_a_chain_of_records_up_to_the_cap():
    text, base = ops_core.replay_title_rewrites(
        "[[T0]] edited", text_hash("[[T0]]"), _rewrite_chain(12))

    cap = ops_core.MAX_REPLAYED_REWRITES
    assert text == f"[[T{cap}]] edited"
    assert base == text_hash(f"[[T{cap}]]")


def test_replay_leaves_an_unrecorded_base_hash_untouched():
    stale = text_hash("never rewritten")

    assert ops_core.replay_title_rewrites(
        "[[T0]] edited", stale, _rewrite_chain(3)) == ("[[T0]] edited", stale)
    assert ops_core.replay_title_rewrites(
        "[[T0]] edited", stale, ()) == ("[[T0]] edited", stale)


def test_clean_edit_with_block_rewrites_does_not_create_daily_page(db):
    # A block with recorded rename rewrites still applies cleanly when the
    # replayed edit matches the live text's hash -- having block_rewrites at
    # all must not force paying for today's daily page.
    t0, t1 = "see [[Old]] page", "see [[New]] page"
    db.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,0,?,?)",
        ("rew_uid1", 1, None, 99, t1, None, NOW, NOW))
    db.execute(
        "INSERT INTO block_rewrites(uid, base_hash, after_hash, old_title,"
        " new_title, created_at) VALUES (?,?,?,?,?,?)",
        ("rew_uid1", text_hash(t0), text_hash(t1), "Old", "New", NOW))
    db.commit()

    apply_batch(db, _batch(
        {"op": "update_text", "uid": "rew_uid1",
         "text": "see [[Old]] page plus extra",
         "base_text_hash": text_hash(t0)},
    ), NOW)
    db.commit()

    assert db.execute("SELECT text FROM blocks WHERE uid='rew_uid1'"
                      ).fetchone()[0] == "see [[New]] page plus extra"
    day = title_for_date(date.today())
    assert db.execute("SELECT id FROM pages WHERE title = ?",
                      (day,)).fetchone() is None


def test_stale_hash_identical_text_does_not_create_daily_page(db):
    # Device 2 pushes text device 1 already synced, under a stale base
    # hash -- check 2 (identical), never a conflict, so no daily page gets
    # created for it.
    apply_batch(db, _batch(
        {"op": "update_text", "uid": "uid_b1", "text": "Tags:: #AI",
         "base_text_hash": text_hash("something else entirely")},
    ), NOW)
    db.commit()

    assert db.execute("SELECT text FROM blocks WHERE uid='uid_b1'"
                      ).fetchone()[0] == "Tags:: #AI"
    day = title_for_date(date.today())
    assert db.execute("SELECT id FROM pages WHERE title = ?",
                      (day,)).fetchone() is None


def test_second_conflict_same_day_reuses_header_and_mints_no_stray_conflict_uid(
        db, monkeypatch):
    # A real conflict still lands exactly as before (header + child under
    # today's daily page); a second conflict on the same block the same day
    # must append under the *existing* header rather than minting another
    # one, and must not mint a conflict_uid it never uses.
    uids = iter(["headerabc123", "childabc1234", "childdef5678",
                "unusedghij12"])
    monkeypatch.setattr(ops_apply.secrets, "token_urlsafe",
                        lambda n: next(uids))

    apply_batch(db, _batch(
        {"op": "update_text", "uid": "uid_b1", "text": "offline edit 1",
         "base_text_hash": text_hash("stale base 1")},
    ), NOW)
    db.commit()
    apply_batch(db, _batch(
        {"op": "update_text", "uid": "uid_b1", "text": "offline edit 2",
         "base_text_hash": text_hash("stale base 2")},
    ), NOW)
    db.commit()

    # exactly 3 uids consumed: a header + child for the first conflict, a
    # child only for the second -- the 4th candidate is never drawn.
    assert next(uids) == "unusedghij12"

    header_uid = db.execute(
        "SELECT header_uid FROM conflict_headers WHERE target_uid='uid_b1'"
    ).fetchone()["header_uid"]
    assert header_uid == "headerabc123"
    children = db.execute(
        "SELECT text FROM blocks WHERE parent_uid = ? ORDER BY order_idx",
        (header_uid,)).fetchall()
    assert [r["text"] for r in children] == ["Tags:: #AI", "offline edit 1"]
    assert db.execute("SELECT text FROM blocks WHERE uid='uid_b1'"
                      ).fetchone()[0] == "offline edit 2"


def test_replay_applies_one_multi_title_rewrite_as_a_single_step():
    """The title migration rewrites several titles in one block at once, so
    its records share before/after hashes and must be replayed as one map --
    applied one at a time, the second would no longer match."""
    before, after = "[[A]] and [[B]]", "[[A2]] and [[B2]]"
    records = tuple(
        ops_core.BlockRewrite(text_hash(before), text_hash(after), old, new)
        for old, new in (("A", "A2"), ("B", "B2")))

    assert ops_core.replay_title_rewrites(
        "[[A]] and [[B]] edited", text_hash(before), records) == (
            "[[A2]] and [[B2]] edited", text_hash(after))


# --- ops on missing blocks ---------------------------------------------------


def _journal_rows_since(db, seq):
    return [(r["entity_id"], r["deleted"]) for r in db.execute(
        "SELECT entity_id, deleted FROM changes WHERE seq > ? AND kind = 'block'"
        " ORDER BY seq", (seq,))]


def _max_seq(db):
    return db.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]


def test_skipped_ops_are_not_broadcast_as_applied(db):
    result = apply_batch(db, _batch(
        {"op": "set_collapsed", "uid": "ghost_bc1", "collapsed": True},
        {"op": "move", "uid": "ghost_bc1", "parent_uid": None,
         "order_idx": 0},
        {"op": "update_text", "uid": "ghost_bc1", "text": "lost"},
        {"op": "create", "uid": "ghost_bc2", "page_title": "AI",
         "parent_uid": "ghost_bc1", "order_idx": 0, "text": "child"},
        {"op": "move", "uid": "uid_b3", "parent_uid": "ghost_bc1",
         "order_idx": 0},
        {"op": "set_collapsed", "uid": "uid_b2", "collapsed": True},
    ), NOW)
    # only the op that actually applied reaches other tabs; they pick up
    # the daily-note entries through the changes feed
    assert result.broadcast_ops == [{"op": "set_collapsed", "uid": "uid_b2",
                                     "collapsed": True}]
    assert [(s["index"], s["op"], s["uid"], s["reason"])
            for s in result.skipped] == [
        (0, "set_collapsed", "ghost_bc1", "block_not_found"),
        (1, "move", "ghost_bc1", "block_not_found"),
        (2, "update_text", "ghost_bc1", "block_not_found"),
        (3, "create", "ghost_bc2", "parent_not_found"),
        (4, "move", "uid_b3", "parent_not_found")]


def test_noop_batch_journals_the_ghost_without_a_daily_page(db):
    before = _max_seq(db)
    apply_batch(db, _batch(
        {"op": "set_collapsed", "uid": "ghost_nb1", "collapsed": True},
        {"op": "delete", "uid": "ghost_nb2"},
    ), NOW)
    db.commit()
    assert _journal_rows_since(db, before) == [("ghost_nb1", 1)]
    day = title_for_date(date.today())
    assert db.execute("SELECT id FROM pages WHERE title = ?",
                      (day,)).fetchone() is None


def test_move_to_missing_parent_journals_the_live_block_and_the_parent(db):
    before = _max_seq(db)
    apply_batch(db, _batch(
        {"op": "move", "uid": "uid_b3", "parent_uid": "ghost_mp1",
         "order_idx": 0},
    ), NOW)
    db.commit()
    rows = _journal_rows_since(db, before)
    assert rows[0] == ("ghost_mp1", 1)   # the tombstone leads
    assert rows[-1] == ("uid_b3", 0)
    row = db.execute("SELECT parent_uid, order_idx FROM blocks"
                     " WHERE uid = 'uid_b3'").fetchone()
    assert (row["parent_uid"], row["order_idx"]) == ("uid_b2", 0)


# --- concurrent structure edits ---------------------------------------------
#
# Another device reshaped the tree after these ops were queued. A create or
# move under a live parent follows the parent to its current page; a move
# that would nest a block under its own descendant is skipped with a note.

def _page_id(db, title):
    row = db.execute("SELECT id FROM pages WHERE title = ?",
                     (title,)).fetchone()
    return row["id"] if row is not None else None


def test_create_under_a_parent_on_another_page_follows_the_parent(db):
    before = _max_seq(db)
    result = apply_batch(db, _batch(
        # uid_b6 lives on AI (page 2); the create was queued for a page the
        # parent has since left, which does not exist here any more
        {"op": "create", "uid": "follow_c1", "page_title": "Stale Page",
         "parent_uid": "uid_b6", "order_idx": 0, "text": "typed child"},
    ), NOW)
    db.commit()
    row = db.execute("SELECT page_id, parent_uid FROM blocks"
                     " WHERE uid = 'follow_c1'").fetchone()
    assert (row["page_id"], row["parent_uid"]) == (2, "uid_b6")
    assert result.skipped == []
    # other tabs place it by the page it really landed on
    assert result.broadcast_ops[0]["page_title"] == "AI"
    # the stale title resolves nothing: no page is created for it
    assert _page_id(db, "Stale Page") is None
    # the insert trigger journals the block, so the feed ships its real row
    assert ("follow_c1", 0) in _journal_rows_since(db, before)


def test_move_with_a_stale_page_title_follows_the_parent(db):
    result = apply_batch(db, _batch(
        # uid_b4 is on page 3; uid_b6 is on AI (page 2), not "Stale Page"
        {"op": "move", "uid": "uid_b4", "parent_uid": "uid_b6",
         "order_idx": 0, "page_title": "Stale Page"},
    ), NOW)
    db.commit()
    row = db.execute("SELECT page_id, parent_uid FROM blocks"
                     " WHERE uid = 'uid_b4'").fetchone()
    assert (row["page_id"], row["parent_uid"]) == (2, "uid_b6")
    assert result.skipped == []
    assert result.broadcast_ops[0]["page_title"] == "AI"
    assert _page_id(db, "Stale Page") is None


def test_cycle_move_journals_the_moved_subtree_and_creates_no_page(db):
    before = _max_seq(db)
    result = apply_batch(db, _batch(
        {"op": "move", "uid": "uid_b2", "parent_uid": "uid_b3",
         "order_idx": 0, "page_title": "Stale Page"},
        {"op": "set_collapsed", "uid": "uid_b1", "collapsed": True},
    ), NOW)
    db.commit()
    # the rest of the batch applies and is the only op broadcast
    assert result.broadcast_ops == [{"op": "set_collapsed", "uid": "uid_b1",
                                     "collapsed": True}]
    assert result.skipped == [{
        "index": 0, "op": "move", "uid": "uid_b2", "reason": "cycle",
        "note_page": title_for_date(date.today())}]
    rows = _journal_rows_since(db, before)
    # every row of the moved subtree ships live, root first; nothing is
    # tombstoned, since nothing is gone
    assert rows.index(("uid_b2", 0)) < rows.index(("uid_b3", 0))
    assert all(deleted == 0 for _, deleted in rows)
    assert _page_id(db, "Stale Page") is None


_B6_TEXT = "AI overview mentions Machine Learning in plain text"
_B2_SUBTREE_HASH = subtree_hash([
    ("uid_b2", "Papers"),
    ("uid_b3", "[[Attention Is All You Need]] is a [[Paper]]")])
_GHOST = "ghost99"


def _edit(uid, text, base=None):
    op = {"op": "update_text", "uid": uid, "text": text}
    if base is not None:
        op["base_text_hash"] = text_hash(base)
    return op


@pytest.mark.parametrize("op, context, detail", [
    ({"op": "create_page", "page_title": "Fresh"}, "PageContext", None),
    ({"op": "create", "uid": "new_u1", "page_title": "AI", "order_idx": 0,
      "text": "t"}, "CreateContext", False),
    ({"op": "create", "uid": "new_u1", "page_title": "AI",
      "parent_uid": "uid_b2", "order_idx": 0, "text": "t"},
     "CreateContext", False),
    ({"op": "create", "uid": "uid_b1", "page_title": "AI",
      "parent_uid": "ghost_p1", "order_idx": 0, "text": "t"},
     "CreateContext", True),
    ({"op": "create", "uid": "new_u1", "page_title": "AI",
      "parent_uid": "ghost_p1", "order_idx": 0, "text": "t"},
     "LandedSkipContext", "diverted_create"),
    ({"op": "create", "uid": "new_u1", "page_title": "AI",
      "parent_uid": "ghost_p1", "order_idx": 0, "text": " "},
     "SkipContext", "diverted_create"),
    ({"op": "move", "uid": "uid_b3", "parent_uid": None, "order_idx": 0},
     "MoveContext", None),
    ({"op": "move", "uid": "uid_b3", "parent_uid": "uid_b6", "order_idx": 0},
     "MoveContext", None),
    ({"op": "move", "uid": "uid_b2", "parent_uid": "uid_b3", "order_idx": 0},
     "StuckMoveContext", "move_cycle"),
    ({"op": "move", "uid": "uid_b2", "parent_uid": "ghost_p1", "order_idx": 0},
     "StuckMoveContext", "move_parent_missing"),
    ({"op": "move", "uid": _GHOST, "parent_uid": None, "order_idx": 0},
     "LandedSkipContext", "orphan_structural"),
    ({"op": "delete", "uid": "uid_b2"}, "DeleteContext", None),
    ({"op": "delete", "uid": "uid_b2", "base_subtree_hash": _B2_SUBTREE_HASH},
     "DeleteContext", None),
    ({"op": "delete", "uid": "uid_b2", "base_subtree_hash": "0" * 64},
     "DeleteConflictContext", None),
    ({"op": "delete", "uid": _GHOST}, "SkipContext", "noop"),
    ({"op": "set_collapsed", "uid": "uid_b2", "collapsed": True},
     "BlockContext", None),
    ({"op": "set_collapsed", "uid": _GHOST, "collapsed": True},
     "SkipContext", "noop"),
    ({"op": "set_heading", "uid": "uid_b2", "heading": 1},
     "BlockContext", None),
    ({"op": "set_heading", "uid": _GHOST, "heading": 1},
     "LandedSkipContext", "orphan_structural"),
    ({"op": "set_view_type", "uid": _GHOST, "view_type": "numbered"},
     "LandedSkipContext", "orphan_structural"),
    (_edit("uid_b6", "plain"), "BlockContext", None),
    (_edit("uid_b6", "clean", base=_B6_TEXT), "TextEditContext", "clean"),
    (_edit("uid_b6", _B6_TEXT, base="stale"), "TextEditContext", "identical"),
    (_edit("uid_b6", "mine", base="stale"), "TextConflictContext", None),
    (_edit(_GHOST, "lost"), "LandedSkipContext", "orphan_edit"),
    (_edit(_GHOST, " "), "SkipContext", "orphan_edit"),
])
def test_context_for_picks_the_context_its_classification_calls_for(
        db, op, context, detail):
    # The planner trusts the context type; this pins the shell's choice of
    # it for every way an op can plan. `detail` is the skip kind, the text
    # edit outcome, or whether a create's uid is taken.
    parsed = OpBatch.model_validate(
        {"client_id": "t", "batch_id": "ctx_types", "ops": [op]}).ops[0]
    ctx = ops_apply._context_for(db, parsed, NOW)
    assert type(ctx).__name__ == context
    if isinstance(ctx, ops_core.SKIPPED_CONTEXTS):
        assert ctx.skip.kind == detail
    elif isinstance(ctx, ops_core.TextEditContext):
        assert ctx.outcome.kind == detail
    elif isinstance(ctx, ops_core.CreateContext):
        assert ctx.uid_taken is detail


def test_skipped_contexts_are_exactly_the_skipped_context_union():
    # apply_batch reports an op as skipped by isinstance against this tuple;
    # a Union member missing from it would be broadcast as applied instead
    assert set(ops_core.SKIPPED_CONTEXTS) == set(get_args(ops_core.SkippedContext))
