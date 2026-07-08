import json
import sqlite3

from fastapi.testclient import TestClient

from pkm.server.app import create_app
from pkm.server.config import Config, load_config
from pkm.server.db import open_db


def _config(tmp_path, **over):
    defaults = dict(
        db_path=tmp_path / "pkm.sqlite3",
        assets_dir=tmp_path / "assets",
        password_salt="00" * 16,
        password_hash="ab" * 32,
        session_secret="cd" * 32,
        cookie_secure=False,
    )
    defaults.update(over)
    return Config(**defaults)


def test_healthz_needs_no_auth(tmp_path):
    client = TestClient(create_app(_config(tmp_path)))
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_load_config_resolves_paths_relative_to_file(tmp_path):
    cfg_file = tmp_path / "config.json"
    cfg_file.write_text(json.dumps({
        "db_file": "pkm.sqlite3", "assets_dir": "assets",
        "password_salt": "00" * 16, "password_hash": "ab" * 32,
        "session_secret": "cd" * 32, "cookie_secure": False,
    }))
    cfg = load_config(cfg_file)
    assert cfg.db_path == tmp_path / "pkm.sqlite3"
    assert cfg.assets_dir == tmp_path / "assets"
    assert cfg.cookie_secure is False


def test_open_db_sets_pragmas(tmp_path):
    con = open_db(tmp_path / "t.sqlite3")
    assert con.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    con.execute("CREATE TABLE t(a)")
    con.execute("INSERT INTO t VALUES (1)")
    assert con.execute("SELECT a FROM t").fetchone()["a"] == 1  # Row factory
    con.close()
