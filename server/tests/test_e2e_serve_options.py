# pattern: Imperative Shell
import os
import signal
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


def test_parent_gone_compares_against_the_captured_ppid():
    assert e2e_serve._parent_gone(os.getppid()) is False
    assert e2e_serve._parent_gone(os.getppid() + 1) is True


def test_watch_parent_signals_itself_once_the_parent_is_gone(monkeypatch):
    # SIGKILL of the process that started us can't be caught; this is the
    # only way an orphaned fixture server ever notices and exits
    monkeypatch.setattr(e2e_serve, "_parent_gone", lambda ppid: True)
    calls = []
    monkeypatch.setattr(e2e_serve.os, "kill", lambda pid, sig: calls.append((pid, sig)))
    e2e_serve._watch_parent(12345, poll_s=0)
    assert calls == [(os.getpid(), signal.SIGTERM)]


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
