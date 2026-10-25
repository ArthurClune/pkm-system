# pattern: Imperative Shell
import os
import signal
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import e2e_serve
import pkm.mcp.tools
from rawread import read
from tool_runner import run_tool
from pkm.database import connect
from pkm.server.config import Config


def test_prepare_db_empty(tmp_path):
    db = e2e_serve.prepare_db(tmp_path, None)
    con = connect(db)
    assert read(con, "SELECT COUNT(*) FROM blocks").fetchone()[0] == 0


def test_prepare_db_copies_source(tmp_path):
    src = e2e_serve.prepare_db(tmp_path / "seed", None)
    con = connect(src)
    con.execute("INSERT INTO pages(id, title) VALUES (1, 'Copied')")
    con.commit()
    con.close()
    db = e2e_serve.prepare_db(tmp_path / "data", src)
    copied = connect(db)
    assert copied.select("SELECT title FROM pages")[0]["title"] == "Copied"
    copied.close()
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


def test_the_e2e_assistant_runs_its_tools_in_require_expect_mode(
        tmp_path, monkeypatch):
    # as the assistant's `pkm-mcp --require-expect` does: an allowed write
    # whose input lost the card's `expect` is refused before any request
    monkeypatch.setattr(pkm.mcp.tools, "_require_expect", False)
    monkeypatch.setattr(pkm.mcp.tools, "_client_factory",
                        pkm.mcp.tools._client_factory)
    monkeypatch.setattr(pkm.mcp.tools, "_cached_client", None)
    config = Config(db_path=e2e_serve.prepare_db(tmp_path, None),
                    assets_dir=tmp_path / "assets", password_salt="11",
                    password_hash="22", session_secret="ee" * 32)

    e2e_serve.assistant_engine(config, 1)
    with pytest.raises(ValueError, match="no expect argument"):
        run_tool("update_block", {"uid": "AAAAAAAAA", "text": "x"})
