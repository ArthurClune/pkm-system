"""Guarded ALTERs in db._ensure_schema_migrations must upgrade a
pre-pkm-zc0c database (assets without description columns) in place."""
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
    # simulate a pre-pkm-d31f database: rows exist but no index, no marker
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
