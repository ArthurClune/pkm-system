# pattern: Imperative Shell
import sqlite3
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import e2e_serve


def test_prepare_db_empty(tmp_path):
    db = e2e_serve.prepare_db(tmp_path, None)
    con = sqlite3.connect(db)
    assert con.execute("SELECT COUNT(*) FROM blocks").fetchone()[0] == 0


def test_prepare_db_copies_source(tmp_path):
    src = e2e_serve.prepare_db(tmp_path / "seed", None)
    con = sqlite3.connect(src)
    con.execute("INSERT INTO pages(id, title) VALUES (1, 'Copied')")
    con.commit()
    con.close()
    db = e2e_serve.prepare_db(tmp_path / "data", src)
    assert sqlite3.connect(db).execute("SELECT title FROM pages").fetchone()[0] == "Copied"
    assert db.parent == tmp_path / "data" and db != src


def test_server_log_path_defaults_to_e2e_log_and_honours_override(tmp_path):
    assert e2e_serve.server_log_path(tmp_path, {}) == tmp_path / "web" / "e2e" / ".server.log"
    assert e2e_serve.server_log_path(tmp_path, {"E2E_SERVER_LOG": "/x/errors.log"}) == Path("/x/errors.log")


def test_instance_header_only_on_healthz():
    app = FastAPI()

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    @app.get("/api/x")
    def x() -> dict:
        return {}

    client = TestClient(e2e_serve.with_instance_header(app, "tok123"))
    assert client.get("/healthz").headers["x-e2e-instance"] == "tok123"
    assert "x-e2e-instance" not in client.get("/api/x").headers
