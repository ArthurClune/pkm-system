import pytest
from fastapi.testclient import TestClient

from pkm.schema import DDL
from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import open_db

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
    ("b1", 1, None, 0, "Tags:: #AI", None, 0, None, None),
    ("b2", 1, None, 1, "Papers", 2, 0, None, None),
    ("b3", 1, "b2", 0, "[[Attention Is All You Need]] is a [[Paper]]",
     None, 0, None, None),
    ("b4", 3, None, 0, "Studying [[Machine Learning]] today", None, 0, None, None),
    ("b5", 3, None, 1, "See ((b3)) for details", None, 0, None, None),
    ("b6", 2, None, 0, "AI overview mentions Machine Learning in plain text",
     None, 0, None, None),
]
SEED_REFS = [
    ("b1", 2, "tag"),
    ("b3", 5, "link"),
    ("b3", 4, "link"),
    ("b4", 1, "link"),
]


@pytest.fixture()
def seeded_config(tmp_path) -> Config:
    db_path = tmp_path / "pkm.sqlite3"
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
