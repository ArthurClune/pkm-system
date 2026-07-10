import pytest
from fastapi.testclient import TestClient

from pkm.schema import DDL
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db, open_db

TEST_PASSWORD = "test-pw"
TEST_SALT = bytes.fromhex("00" * 16)

SEED_PAGES = [
    (1, "Machine Learning", 1000, 2000),
    (2, "AI", None, None),
    (3, "July 7th, 2026", None, None),
    (4, "Paper", None, None),
    (5, "Attention Is All You Need", None, None),
]
SEED_BLOCKS = [
    ("uid_b1", 1, None, 0, "Tags:: #AI", None, 0, None, None),
    ("uid_b2", 1, None, 1, "Papers", 2, 0, None, None),
    ("uid_b3", 1, "uid_b2", 0, "[[Attention Is All You Need]] is a [[Paper]]",
     None, 0, None, None),
    ("uid_b4", 3, None, 0, "Studying [[Machine Learning]] today", None, 0, None, None),
    ("uid_b5", 3, None, 1, "See ((uid_b3)) for details", None, 0, None, None),
    ("uid_b6", 2, None, 0, "AI overview mentions Machine Learning in plain text",
     None, 0, None, None),
]
SEED_REFS = [
    ("uid_b1", 2, "tag"),
    ("uid_b3", 5, "link"),
    ("uid_b3", 4, "link"),
    ("uid_b4", 1, "link"),
]


@pytest.fixture()
def seeded_config(tmp_path) -> Config:
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)  # WAL + migrations, once, before any open_db() call
    con = open_db(db_path)
    con.executescript(DDL)
    con.executemany("INSERT INTO pages VALUES (?,?,?,?)", SEED_PAGES)
    con.executemany("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?)", SEED_BLOCKS)
    con.executemany("INSERT INTO refs VALUES (?,?,?)", SEED_REFS)
    con.commit()
    con.close()
    (tmp_path / "assets").mkdir()
    return Config(
        db_path=db_path,
        assets_dir=tmp_path / "assets",
        password_salt=TEST_SALT.hex(),
        password_hash=hash_password(TEST_PASSWORD, TEST_SALT),
        session_secret="cd" * 32,
        cookie_secure=False,
    )


@pytest.fixture()
def anon_client(seeded_config) -> TestClient:
    return TestClient(create_app(seeded_config))


@pytest.fixture()
def client(anon_client) -> TestClient:
    r = anon_client.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    return anon_client
