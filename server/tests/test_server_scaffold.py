import json
import sqlite3
from typing import Any

from fastapi.testclient import TestClient

from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config, load_config
from pkm.server.db import BUSY_TIMEOUT_MS, init_db, open_db


def _config(tmp_path, **over):
    defaults: dict[str, Any] = dict(
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


def test_init_db_sets_wal_mode(tmp_path):
    path = tmp_path / "t.sqlite3"
    init_db(path)
    con = sqlite3.connect(path)
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    con.close()


def test_create_app_initializes_db_without_an_explicit_init_db_call(tmp_path):
    # pkm-2939: create_app() must run init_db() itself, so a future
    # entrypoint (or a direct create_app(config) call) that forgets the
    # by-convention init_db()-before-serve step still gets WAL mode and
    # migrations rather than silently serving against a raw/legacy db.
    config = _config(tmp_path)
    assert not config.db_path.exists()
    create_app(config)
    con = sqlite3.connect(config.db_path)
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    names = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "sidebar_entries" in names
    con.close()


def test_open_db_sets_connection_local_pragmas_only(tmp_path):
    # open_db() must not touch WAL/DDL (see test_db_concurrency.py for
    # why) - it only sets pragmas scoped to this connection.
    con = open_db(tmp_path / "t.sqlite3")
    assert con.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert con.execute("PRAGMA busy_timeout").fetchone()[0] == BUSY_TIMEOUT_MS
    con.execute("CREATE TABLE t(a)")
    con.execute("INSERT INTO t VALUES (1)")
    assert con.execute("SELECT a FROM t").fetchone()["a"] == 1  # Row factory
    con.close()


def test_fresh_data_dir_serves_journal_without_an_import(tmp_path):
    # pkm-cqu2: create_app() against a brand-new data dir (the README setup
    # path: pkm.server.setup then pkm.server.run, no Roam import) must not
    # 500 on the very first page route -- init_db() has to lay down the
    # base schema (pages, blocks, ...) itself, not rely on an importer run
    # having built the database first.
    tmp_path.mkdir(exist_ok=True)
    (tmp_path / "assets").mkdir(exist_ok=True)
    password = "hunter2"
    salt = bytes.fromhex("11" * 16)
    config = _config(
        tmp_path,
        password_salt=salt.hex(),
        password_hash=hash_password(password, salt),
    )
    assert not config.db_path.exists()

    client = TestClient(create_app(config))
    r = client.post("/api/login", json={"password": password})
    assert r.status_code == 200

    r = client.get("/api/journal")
    assert r.status_code == 200


def test_init_db_backfills_sidebar_entries_on_legacy_db(tmp_path):
    # Simulate a database created before sidebar_entries existed: run only
    # the original tables' DDL, without sidebar_entries.
    path = tmp_path / "legacy.sqlite3"
    legacy = sqlite3.connect(path)
    legacy.execute("CREATE TABLE pages(id INTEGER PRIMARY KEY, title TEXT)")
    legacy.commit()
    legacy.close()

    init_db(path)
    con = sqlite3.connect(path)
    names = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "sidebar_entries" in names
    con.execute("INSERT INTO sidebar_entries(title, order_idx) VALUES ('AI', 0)")
    con.commit()
    con.close()
