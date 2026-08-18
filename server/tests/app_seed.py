# pattern: Imperative Shell
"""Shared logged-in TestClient seeder (same convention as fake_engine.py):
for test files that build their own from-scratch graph -- nested/cyclic
refs, query blocks -- rather than the shared conftest fixture other test
files rely on."""
from collections.abc import Iterable
from pathlib import Path

from fastapi.testclient import TestClient

from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db, open_db

# Own copy of the credentials rather than importing conftest's constants:
# pytest resolves that import fine via rootdir insertion, but pyrefly's
# module resolution does not.
_TEST_PASSWORD = "test-pw"
_TEST_SALT = bytes.fromhex("00" * 16)


def seeded_client(
    tmp_path: Path,
    pages: Iterable[tuple],
    blocks: Iterable[tuple],
    refs: Iterable[tuple] = (),
) -> TestClient:
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)
    con = open_db(db_path)
    con.executemany("INSERT INTO pages VALUES (?,?,?,?)", pages)
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", blocks)
    con.executemany("INSERT INTO refs VALUES (?,?,?)", refs)
    con.commit()
    con.close()
    (tmp_path / "assets").mkdir()
    config = Config(
        db_path=db_path,
        assets_dir=tmp_path / "assets",
        password_salt=_TEST_SALT.hex(),
        password_hash=hash_password(_TEST_PASSWORD, _TEST_SALT),
        session_secret="cd" * 32,
        cookie_secure=False,
    )
    tc = TestClient(create_app(config))
    r = tc.post("/api/login", json={"password": _TEST_PASSWORD})
    assert r.status_code == 200
    return tc
