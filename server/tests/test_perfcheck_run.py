import socket
from pathlib import Path

import pytest

from perfcheck import run, run_core
from perfcheck.compare import Comparison, Finding


def test_sides_for():
    assert run_core.sides_for(["server/src/pkm/server/routes_pages.py"]) == ["backend"]
    assert run_core.sides_for(["web/src/App.tsx"]) == ["frontend"]
    assert run_core.sides_for(["web/x.ts", "server/y.py"]) == ["backend", "frontend"]
    assert run_core.sides_for(["docs/architecture/frontend.md", "AGENTS.md"]) == []
    assert run_core.sides_for(["perf/baseline-backend.json"]) == []


def test_frontend_letters():
    assert run_core.frontend_letters(["K/drag-top", "K/drag-bottom", "S/search-rare"]) == "K,S"


def test_exit_code():
    ok = Comparison((Finding("s", "n", "improvement", "2", "1"),), {})
    assert run_core.exit_code(ok, {}) == 0
    reg = Comparison((Finding("s", "n", "candidate", "1", "2"),), {})
    assert run_core.exit_code(reg, {("s", "n"): "regression"}) == 1
    assert run_core.exit_code(reg, {("s", "n"): "unstable"}) == 1
    lost = Comparison((Finding("s", "*", "lost", "present", "missing"),), {})
    assert run_core.exit_code(lost, {}) == 1


def test_sides_include_untracked(tmp_path, monkeypatch):
    monkeypatch.setattr(run, "_git", lambda repo, *a: {
        ("merge-base", "HEAD", "main"): "abc\n",
        ("diff", "--name-only", "abc"): "server/a.py\n",
        ("ls-files", "--others", "--exclude-standard"): "web/new.ts\n",
    }[a])
    assert run.changed_paths(tmp_path) == ["server/a.py", "web/new.ts"]


def test_merge_base_command_uses_branch_harness(tmp_path):
    repo, wt = tmp_path / "repo", tmp_path / "wt"
    cmd, env = run.BackendRunner(repo).command(wt, ["page/big"], "abc", tmp_path / "out.json")
    assert cmd[:4] == ["uv", "run", "--project", str(wt / "server")]
    # a merge base older than this tooling has no time-machine in its venv
    assert cmd[4:6] == ["--with", "time-machine"]
    assert env["PYTHONPATH"] == str(repo / "server" / "tooling")
    fcmd, fenv = run.FrontendRunner(repo).server_command(wt, Path("/fx.sqlite3"))
    assert fcmd[4:6] == ["--with", "time-machine"]
    assert str(repo / "server" / "tests" / "e2e_serve.py") in fcmd
    assert fenv["E2E_WEB_DIST"] == str(wt / "web" / "dist")


def test_port_busy_fails_without_result(tmp_path):
    s = socket.socket()
    s.bind(("127.0.0.1", run.FRONTEND_PORT))
    s.listen(1)
    try:
        out = tmp_path / "r.json"
        with pytest.raises(run.PerfRunError, match=str(run.FRONTEND_PORT)):
            run.FrontendRunner(tmp_path).ensure_port_free()
        assert not out.exists()
    finally:
        s.close()
