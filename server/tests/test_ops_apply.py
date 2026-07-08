import pytest

from pkm.server.db import open_db
from pkm.server.ops_apply import apply_batch
from pkm.server.ops_core import OpBatch, OpError

NOW = 1_800_000_000_000


@pytest.fixture()
def db(seeded_config):
    con = open_db(seeded_config.db_path)
    yield con
    con.close()


def _batch(*ops) -> OpBatch:
    return OpBatch(client_id="t", ops=list(ops))


def test_create_inserts_shifts_and_derives_refs(db):
    apply_batch(db, _batch(
        {"op": "create", "uid": "newuid1", "page_title": "Machine Learning",
         "parent_uid": None, "order_idx": 0, "text": "see [[Brand New]] #AI"},
    ), NOW)
    db.commit()
    rows = db.execute(
        "SELECT uid, order_idx FROM blocks WHERE page_id = 1"
        "  AND parent_uid IS NULL ORDER BY order_idx").fetchall()
    assert [(r["uid"], r["order_idx"]) for r in rows] == \
        [("newuid1", 0), ("uid_b1", 1), ("uid_b2", 2)]
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
