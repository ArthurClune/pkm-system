"""Guarded ALTERs in db._ensure_schema_migrations must upgrade a database
predating the assets description columns in place."""
import sqlite3

from pkm.server.db import init_db, open_db
from pkm.server.sync_meta import plain_space_title_canonicalization_active

OLD_ASSETS_DDL = """
CREATE TABLE assets(
  sha256      TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER
);
"""


def test_existing_assets_table_gains_description_columns(tmp_path):
    db_path = tmp_path / "pkm.sqlite3"
    con = sqlite3.connect(db_path)
    con.executescript(OLD_ASSETS_DDL)
    con.execute("INSERT INTO assets VALUES ('ab'*32, 'a.png', 'image/png', 3, NULL)")
    con.commit()
    con.close()

    init_db(db_path)  # IF-NOT-EXISTS DDL skips the table; migration must ALTER it

    con = open_db(db_path)
    cols = {r[1] for r in con.execute("PRAGMA table_info(assets)")}
    assert {"description", "described_at", "describe_error"} <= cols
    row = con.execute("SELECT description, described_at, describe_error"
                      " FROM assets").fetchone()
    assert tuple(row) == (None, None, None)
    con.close()


def test_fresh_db_has_description_columns(tmp_path):
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)
    con = open_db(db_path)
    cols = {r[1] for r in con.execute("PRAGMA table_info(assets)")}
    assert {"description", "described_at", "describe_error"} <= cols
    con.close()


def test_existing_db_gains_plain_space_title_canonicalization_metadata(tmp_path):
    db_path = tmp_path / "pkm.sqlite3"
    con = sqlite3.connect(db_path)
    con.executescript(OLD_ASSETS_DDL)
    con.commit()
    con.close()

    init_db(db_path)

    con = open_db(db_path)
    row = con.execute(
        "SELECT value FROM sync_meta WHERE key = 'plain_space_title_canonicalization'"
    ).fetchone()
    assert row is not None
    assert row["value"] == "0"
    assert plain_space_title_canonicalization_active(con) is False
    con.close()


def test_block_refs_backfill_fills_historical_rows(tmp_path):
    from pkm.server.db import init_db, open_db
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)
    con = open_db(db_path)
    con.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed) VALUES ('uid_src01', 1, NULL, 0,"
        " 'see ((uid_tgt01))', NULL, 0)")
    # simulate a database predating block_refs: rows exist but no index, no
    # marker
    con.execute("DELETE FROM sync_meta WHERE key = 'block_refs_backfilled'")
    con.commit()
    con.close()

    init_db(db_path)  # idempotent second run performs the catch-up
    con = open_db(db_path)
    rows = {tuple(r) for r in con.execute(
        "SELECT src_block_uid, target_block_uid FROM block_refs")}
    marker = con.execute(
        "SELECT value FROM sync_meta WHERE key = 'block_refs_backfilled'"
    ).fetchone()[0]
    con.close()
    assert rows == {("uid_src01", "uid_tgt01")}
    assert marker == "1"


def test_block_refs_backfill_is_guarded(tmp_path):
    from pkm.server.db import init_db, open_db
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)  # empty graph: marker set, table legitimately empty
    con = open_db(db_path)
    con.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed) VALUES ('uid_src02', 1, NULL, 0,"
        " 'see ((uid_tgt02))', NULL, 0)")
    con.commit()
    con.close()

    init_db(db_path)  # marker present: must NOT re-scan
    con = open_db(db_path)
    rows = list(con.execute("SELECT * FROM block_refs"))
    con.close()
    assert rows == []  # write path owns post-marker rows, not startup


# The journal as it stood before block tombstones recorded their page.
OLD_CHANGES_DDL = """
CREATE TABLE changes(
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK(kind IN ('block','page','sidebar')),
  entity_id  TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER blocks_chg_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO changes(kind, entity_id, deleted) VALUES ('block', old.uid, 1);
END;
"""


def _old_journal_db(db_path):
    from pkm.schema import BASE_DDL
    con = sqlite3.connect(db_path)
    con.executescript(BASE_DDL + OLD_CHANGES_DDL)
    con.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed) VALUES ('uid_old01', 1, NULL, 0, 'a', NULL, 0)")
    con.execute("DELETE FROM blocks WHERE uid = 'uid_old01'")
    con.commit()
    con.close()


def _delete_one(db_path, uid, page_id):
    con = open_db(db_path)
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed) VALUES (?, ?, NULL, 0, 'b', NULL, 0)",
        (uid, page_id))
    con.execute("DELETE FROM blocks WHERE uid = ?", (uid,))
    con.commit()
    rows = [tuple(r) for r in con.execute(
        "SELECT kind, entity_id, deleted, page_id FROM changes"
        " WHERE entity_id = ? ORDER BY seq", (uid,))]
    con.close()
    return rows


def test_existing_journal_gains_the_tombstone_page_and_its_trigger(tmp_path):
    db_path = tmp_path / "pkm.sqlite3"
    _old_journal_db(db_path)

    init_db(db_path)  # IF-NOT-EXISTS DDL skips table and trigger
    init_db(db_path)  # and a second startup changes nothing

    con = open_db(db_path)
    assert "page_id" in {r[1] for r in con.execute("PRAGMA table_info(changes)")}
    old = con.execute("SELECT deleted, page_id FROM changes"
                      " WHERE entity_id = 'uid_old01' AND deleted = 1").fetchone()
    assert tuple(old) == (1, None)
    assert con.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'"
        " AND name = 'blocks_chg_ad'").fetchone()[0] == 1
    con.close()
    assert _delete_one(db_path, "uid_new01", 1) == [
        ("block", "uid_new01", 0, None), ("block", "uid_new01", 1, 1)]


def test_fresh_journal_records_a_deleted_blocks_page(tmp_path):
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)
    con = open_db(db_path)
    con.execute("INSERT INTO pages VALUES (7, 'P', NULL, NULL)")
    con.commit()
    con.close()
    assert _delete_one(db_path, "uid_new02", 7) == [
        ("block", "uid_new02", 0, None), ("block", "uid_new02", 1, 7)]

