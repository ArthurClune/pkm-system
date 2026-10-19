import sqlite3

import pytest

from rawread import read
from pkm.database import connect
from pkm.schema import DDL
from pkm.server.sync_meta import (database_generation,
                                  plain_space_title_canonicalization_active,
                                  rotate_database_generation,
                                  set_plain_space_title_canonicalization)


@pytest.fixture()
def db():
    con = connect(":memory:")
    con.executescript(DDL)
    yield con
    con.close()


def test_tables_exist(db):
    names = {r[0] for r in read(db,
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
    assert {"pages", "blocks", "refs", "assets",
            "blocks_fts", "pages_fts", "sidebar_entries"} <= names


def test_blocks_have_constrained_view_type(db):
    columns = {r[1] for r in read(db, "PRAGMA table_info(blocks)")}
    assert "view_type" in columns
    db.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    db.execute(
        "INSERT INTO blocks(uid, page_id, order_idx, text, view_type) "
        "VALUES ('u1', 1, 0, 'x', 'numbered')")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO blocks(uid, page_id, order_idx, text, view_type) "
            "VALUES ('u2', 1, 1, 'x', 'table')")


def test_sidebar_entries_title_is_unique(db):
    db.execute("INSERT INTO sidebar_entries(title, order_idx) VALUES ('AI', 0)")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO sidebar_entries(title, order_idx) VALUES ('AI', 1)")


def test_fts_triggers_track_blocks(db):
    db.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    db.execute("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
               " heading, collapsed, created_at, updated_at) VALUES ('u1', 1, NULL, 0,"
               " 'hello attention world', NULL, 0, NULL, NULL)")
    hit = read(db, "SELECT rowid FROM blocks_fts WHERE blocks_fts"
                     " MATCH 'attention'").fetchall()
    assert len(hit) == 1
    db.execute("UPDATE blocks SET text = 'goodbye' WHERE uid = 'u1'")
    assert read(db, "SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH 'attention'").fetchone()[0] == 0
    assert read(db, "SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH 'goodbye'").fetchone()[0] == 1
    db.execute("DELETE FROM blocks WHERE uid = 'u1'")
    assert read(db, "SELECT count(*) FROM blocks_fts WHERE blocks_fts"
                      " MATCH 'goodbye'").fetchone()[0] == 0


def test_pages_fts_tracks_titles(db):
    db.execute("INSERT INTO pages VALUES (1, 'Machine Learning', NULL, NULL)")
    assert read(db, "SELECT count(*) FROM pages_fts WHERE pages_fts"
                      " MATCH 'machine'").fetchone()[0] == 1


def test_refs_kind_constraint(db):
    db.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    db.execute("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
               " heading, collapsed, created_at, updated_at) VALUES ('u1', 1, NULL, 0, 'x',"
               " NULL, 0, NULL, NULL)")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("INSERT INTO refs VALUES ('u1', 1, 'bogus')")


def test_db_generation_token_created_and_stable(db):
    """A random generation token is minted when the DDL first runs and
    survives re-running the (idempotent) DDL."""
    row = read(db,
        "SELECT value FROM sync_meta WHERE key = 'db_generation'").fetchone()
    assert row is not None
    token = row[0]
    assert len(token) == 32 and all(c in "0123456789abcdef" for c in token)
    db.executescript(DDL)  # idempotent replay must not rotate the token
    again = read(db,
        "SELECT value FROM sync_meta WHERE key = 'db_generation'").fetchone()[0]
    assert again == token


def test_db_generation_token_differs_between_databases():
    """A rebuilt database (importer swap) must mint a different token."""
    tokens = set()
    for _ in range(2):
        con = connect(":memory:")
        con.executescript(DDL)
        tokens.add(read(con,
            "SELECT value FROM sync_meta WHERE key = 'db_generation'"
        ).fetchone()[0])
        con.close()
    assert len(tokens) == 2


def test_plain_space_title_canonicalization_defaults_false_and_replay_keeps_true(db):
    meta = dict(read(db, "SELECT key, value FROM sync_meta"))
    assert meta["plain_space_title_canonicalization"] == "0"
    assert plain_space_title_canonicalization_active(db) is False

    set_plain_space_title_canonicalization(db, active=True)

    assert dict(read(db, "SELECT key, value FROM sync_meta"))[
        "plain_space_title_canonicalization"
    ] == "1"
    assert plain_space_title_canonicalization_active(db) is True

    db.executescript(DDL)

    assert dict(read(db, "SELECT key, value FROM sync_meta"))[
        "plain_space_title_canonicalization"
    ] == "1"
    assert plain_space_title_canonicalization_active(db) is True


def test_block_refs_table_exists(tmp_path):
    from pkm.server.db import init_db, open_db
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)
    con = open_db(db_path)
    cols = [r[1] for r in read(con, "PRAGMA table_info(block_refs)")]
    assert cols == ["src_block_uid", "target_block_uid"]
    indexes = {r["name"] for r in read(
        con, "SELECT name FROM pragma_index_list('block_refs')")}
    assert "idx_block_refs_target" in indexes
    con.close()


def test_rotate_database_generation_changes_only_generation(db):
    before = dict(read(db, "SELECT key, value FROM sync_meta"))

    rotated = rotate_database_generation(db)

    after = dict(read(db, "SELECT key, value FROM sync_meta"))
    assert rotated == database_generation(db)
    assert rotated != before["db_generation"]
    assert after.keys() == before.keys()
    assert after["plain_space_title_canonicalization"] == before[
        "plain_space_title_canonicalization"
    ]
