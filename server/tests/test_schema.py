import sqlite3

import pytest

from pkm.schema import DDL


@pytest.fixture()
def db():
    con = sqlite3.connect(":memory:")
    con.executescript(DDL)
    yield con
    con.close()


def test_tables_exist(db):
    names = {r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
    assert {"pages", "blocks", "refs", "assets",
            "blocks_fts", "pages_fts", "sidebar_entries"} <= names


def test_sidebar_entries_title_is_unique(db):
    db.execute("INSERT INTO sidebar_entries(title, order_idx) VALUES ('AI', 0)")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO sidebar_entries(title, order_idx) VALUES ('AI', 1)")


def test_fts_triggers_track_blocks(db):
    db.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    db.execute("INSERT INTO blocks VALUES ('u1', 1, NULL, 0,"
               " 'hello attention world', NULL, 0, NULL, NULL)")
    hit = db.execute("SELECT rowid FROM blocks_fts WHERE blocks_fts"
                     " MATCH 'attention'").fetchall()
    assert len(hit) == 1
    db.execute("UPDATE blocks SET text = 'goodbye' WHERE uid = 'u1'")
    assert db.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH 'attention'").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH 'goodbye'").fetchone()[0] == 1
    db.execute("DELETE FROM blocks WHERE uid = 'u1'")
    assert db.execute("SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH 'goodbye'").fetchone()[0] == 0


def test_pages_fts_tracks_titles(db):
    db.execute("INSERT INTO pages VALUES (1, 'Machine Learning', NULL, NULL)")
    assert db.execute("SELECT count(*) FROM pages_fts WHERE pages_fts"
                      " MATCH 'machine'").fetchone()[0] == 1


def test_refs_kind_constraint(db):
    db.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    db.execute("INSERT INTO blocks VALUES ('u1', 1, NULL, 0, 'x',"
               " NULL, 0, NULL, NULL)")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO refs VALUES ('u1', 1, 'bogus')")
