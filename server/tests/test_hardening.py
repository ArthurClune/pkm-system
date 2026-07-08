import sqlite3

from pkm.schema import DDL
from pkm.server.auth_core import YEAR_MS, sign_session, verify_session
from pkm.server.db import open_db
from pkm.server.store import fetch_page, get_or_create_page

SECRET = b"s" * 32
NOW = 1_700_000_000_000


def test_session_expiry_and_skew():
    token = sign_session(SECRET, NOW)
    assert verify_session(SECRET, token, now_ms=NOW + 1000)
    assert verify_session(SECRET, token, now_ms=NOW + YEAR_MS)          # boundary ok
    assert not verify_session(SECRET, token, now_ms=NOW + YEAR_MS + 1)  # expired
    assert not verify_session(SECRET, token, now_ms=NOW - 6 * 60 * 1000)  # future
    assert verify_session(SECRET, token, now_ms=NOW - 4 * 60 * 1000)      # skew ok
    bad = f"v1.notanumber.{token.split('.')[2]}"
    assert not verify_session(SECRET, bad, now_ms=NOW)


def _db(tmp_path) -> sqlite3.Connection:
    con = open_db(tmp_path / "t.sqlite3")
    con.executescript(DDL)
    return con


def test_get_or_create_page(tmp_path):
    db = _db(tmp_path)
    page = get_or_create_page(db, "New Page", 123)
    assert page["title"] == "New Page" and page["created_at"] == 123
    again = get_or_create_page(db, "New Page", 456)
    assert again["id"] == page["id"] and again["created_at"] == 123
    assert db.in_transaction  # helper must NOT have committed
    db.rollback()
    assert fetch_page(db, "New Page") is None  # rollback undid the create
    db.close()


def test_ancestor_depth_cap_survives_cycle(client, seeded_config):
    # Manufacture a parent cycle directly (ops will forbid these, but reads
    # must not hang if one ever appears).
    con = sqlite3.connect(seeded_config.db_path)
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("UPDATE blocks SET parent_uid = 'uid_b3' WHERE uid = 'uid_b2'")
    con.commit(); con.close()
    r = client.get("/api/page/Paper")   # backlinks of Paper walk uid_b3's ancestors
    assert r.status_code == 200
