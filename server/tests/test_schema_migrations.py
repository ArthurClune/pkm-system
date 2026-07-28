"""Guarded ALTERs in db._ensure_schema_migrations must upgrade a
pre-pkm-zc0c database (assets without description columns) in place."""
import sqlite3

from pkm.server.db import init_db, open_db

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
