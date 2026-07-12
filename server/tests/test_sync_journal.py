"""Journal triggers: every row change lands in `changes`, including rows
changed as side effects of an op (sibling shifts, subtree moves, cascade
deletes, implicit page creation)."""
import pytest

from pkm.server.db import init_db, open_db


@pytest.fixture()
def db(tmp_path):
    path = tmp_path / "t.sqlite3"
    init_db(path)
    con = open_db(path)
    yield con
    con.close()


def _changed(db, kind):
    return {r["entity_id"] for r in db.execute(
        "SELECT entity_id FROM changes WHERE kind = ?", (kind,))}


def _seed_page_with_blocks(db):
    db.execute("INSERT INTO pages(id, title) VALUES (1, 'P')")
    db.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
        " VALUES (?,1,?,?,?)",
        [("uid_aa1", None, 0, "first"),
         ("uid_aa2", None, 1, "second"),
         ("uid_aa3", "uid_aa2", 0, "child of second")])
    db.commit()


def test_insert_update_delete_journal_block_rows(db):
    _seed_page_with_blocks(db)
    assert {"uid_aa1", "uid_aa2", "uid_aa3"} <= _changed(db, "block")
    db.execute("UPDATE blocks SET collapsed = 1 WHERE uid = 'uid_aa1'")
    db.commit()
    assert db.execute(
        "SELECT COUNT(*) FROM changes WHERE kind='block'"
        " AND entity_id='uid_aa1'").fetchone()[0] == 2


def test_sibling_shift_journals_every_shifted_row(db):
    _seed_page_with_blocks(db)
    before = db.execute("SELECT MAX(seq) FROM changes").fetchone()[0]
    # what ShiftSiblings does: bump order_idx of top-level blocks
    db.execute("UPDATE blocks SET order_idx = order_idx + 1"
               " WHERE page_id = 1 AND parent_uid IS NULL")
    db.commit()
    shifted = {r["entity_id"] for r in db.execute(
        "SELECT entity_id FROM changes WHERE kind='block' AND seq > ?",
        (before,))}
    assert shifted == {"uid_aa1", "uid_aa2"}


def test_cascade_delete_journals_descendant_tombstones(db):
    _seed_page_with_blocks(db)
    db.execute("DELETE FROM pages WHERE id = 1")
    db.commit()
    tombs = {r["entity_id"] for r in db.execute(
        "SELECT entity_id FROM changes WHERE kind='block' AND deleted=1")}
    # ON DELETE CASCADE removed all three blocks: all must be journaled
    assert tombs == {"uid_aa1", "uid_aa2", "uid_aa3"}
    assert "1" in {r["entity_id"] for r in db.execute(
        "SELECT entity_id FROM changes WHERE kind='page' AND deleted=1")}


def test_page_and_sidebar_writes_journal(db):
    db.execute("INSERT INTO pages(id, title) VALUES (7, 'Implicit')")
    db.execute("INSERT INTO sidebar_entries(id, title, order_idx)"
               " VALUES (3, 'Implicit', 0)")
    db.commit()
    assert "7" in _changed(db, "page")
    assert "3" in _changed(db, "sidebar")
    db.execute("DELETE FROM sidebar_entries WHERE id = 3")
    db.commit()
    assert db.execute(
        "SELECT deleted FROM changes WHERE kind='sidebar' AND entity_id='3'"
        " ORDER BY seq DESC LIMIT 1").fetchone()[0] == 1


def test_base_ddl_contains_no_server_tables():
    from pkm.schema import BASE_DDL
    assert "changes" not in BASE_DDL
    assert "applied_batches" not in BASE_DDL
