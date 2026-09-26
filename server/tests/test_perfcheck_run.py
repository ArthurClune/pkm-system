import http.server
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
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


def test_sides_for_skips_e2e_specs_and_docs_under_web():
    assert run_core.sides_for(["web/e2e/journal.spec.ts", "web/tooling/perf/README.md",
                               "web/README.md"]) == []
    assert run_core.sides_for(["web/e2e/journal.spec.ts", "web/src/App.tsx"]) == ["frontend"]
    assert run_core.sides_for(["server/README.md"]) == ["backend"]


def test_frontend_letters_cover_whole_context_groups():
    # counts were recorded with each letter in its shared browser context
    assert run_core.frontend_letters(["K/drag-top", "K/drag-bottom", "S/search-rare"]) == "J,K,S"
    assert run_core.frontend_letters(["F/typing"]) == "A,B,F,I"
    assert run_core.frontend_letters(["W/warm", "I/journal-scroll"]) == "A,B,F,H,I,W"


def test_next_steps_one_line_per_verdict_present():
    lines = run_core.next_steps("frontend", ["regression", "unstable", "regression", "improvement"])
    assert len(lines) == 2
    assert "diff" in lines[0] and "bean" in lines[1]
    assert "perf/check.sh frontend --rebaseline" in run_core.next_steps("frontend", ["stale-baseline"])[0]
    lost, reclassified = run_core.next_steps("backend", ["reclassified", "lost"])
    assert lost.startswith("lost:") and "perf/check.sh backend --bootstrap" in lost
    assert reclassified.startswith("reclassified:") and "--bootstrap" in reclassified
    assert run_core.next_steps("backend", ["improvement", "new"]) == []


def test_stale_entries_keep_recent_and_named():
    day = 86_400.0
    now = 100 * day
    used = {"old": now - 8 * day, "recent": now - 2 * day, "current": now - 30 * day}
    assert run_core.stale_entries(used, now, keep={"current"}, max_age_s=7 * day) == ["old"]
    assert run_core.stale_entries({}, now, keep=set(), max_age_s=day) == []


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
    fcmd, fenv = run.FrontendRunner(repo).server_command(wt, Path("/fx.sqlite3"), "tok")
    assert fcmd[4:6] == ["--with", "time-machine"]
    assert str(repo / "server" / "tests" / "e2e_serve.py") in fcmd
    assert fenv["E2E_WEB_DIST"] == str(wt / "web" / "dist")
    assert fenv["E2E_INSTANCE"] == "tok"
    # never web/e2e/.server.log, which a concurrent `pnpm e2e` owns
    assert fenv["E2E_SERVER_LOG"] == str(repo / "perf" / "out" / "fixture-server-errors.log")


def test_port_busy_fails_without_result(tmp_path):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", run.FRONTEND_PORT))
        s.listen(1)
    except OSError:
        pass  # something else already holds the port: just as busy
    try:
        out = tmp_path / "r.json"
        with pytest.raises(run.PerfRunError, match=str(run.FRONTEND_PORT)):
            run.FrontendRunner(tmp_path).ensure_port_free()
        assert not out.exists()
    finally:
        s.close()


def _doc(scenarios):
    return {"commit": "c", "fixture_hash": "h", "env": {"py": "3"},
            "scenarios": {s: {k: {"class": "exact", "value": v} for k, v in ms.items()}
                          for s, ms in scenarios.items()}}


class _FakeRunner:
    """Hands out canned result docs: head runs from one list, merge-base runs
    (told apart by their worktree) from another, recording each call's `only`."""
    def __init__(self, head_docs, mb_docs, mb_wt):
        self.head_docs, self.mb_docs, self.mb_wt = list(head_docs), list(mb_docs), mb_wt
        self.head_only, self.mb_only = [], []

    def run(self, worktree, only, commit):
        if worktree == self.mb_wt:
            assert commit == "base"
            self.mb_only.append(only)
            return self.mb_docs.pop(0)
        self.head_only.append(only)
        return self.head_docs.pop(0)


@pytest.fixture
def check(tmp_path, monkeypatch):
    """Run do_check against a committed-looking baseline with canned results;
    returns (rc, runner, baseline path)."""
    (tmp_path / "perf").mkdir()
    path = tmp_path / "perf" / "baseline-backend.json"
    path.write_text(json.dumps(_doc({"a/1": {"n": 10, "k": 10}, "b/2": {"n": 5}})))
    mb_wt = tmp_path / "mb"
    monkeypatch.setattr(run, "head_commit", lambda repo: "head")
    monkeypatch.setattr(run, "merge_base_worktree", lambda repo, side: (mb_wt, "base"))

    def go(head_docs, mb_docs=()):
        runner = _FakeRunner(head_docs, mb_docs, mb_wt)
        monkeypatch.setattr(run, "_runner", lambda repo, side: runner)
        return run.do_check(tmp_path, "backend"), runner, path
    return go


def test_check_unstable_skips_merge_base(check, capsys):
    rc, runner, _ = check([_doc({"a/1": {"n": 11, "k": 10}, "b/2": {"n": 5}}),
                           _doc({"a/1": {"n": 10, "k": 10}})])
    assert rc == 1
    assert runner.head_only == [None, ["a/1"]]
    assert runner.mb_only == []
    assert "| a/1 | n | 10 | 11 | unstable |" in capsys.readouterr().out


def test_check_regression_runs_merge_base_for_survivors_only(check, capsys):
    rc, runner, _ = check([_doc({"a/1": {"n": 11, "k": 10}, "b/2": {"n": 6}}),
                           _doc({"a/1": {"n": 11, "k": 10}, "b/2": {"n": 5}})],
                          [_doc({"a/1": {"n": 10, "k": 10}})])
    assert rc == 1
    assert runner.head_only == [None, ["a/1", "b/2"]]
    assert runner.mb_only == [["a/1"]]
    out = capsys.readouterr().out
    assert "| a/1 | n | 10 | 11 | regression |" in out
    assert "| b/2 | n | 5 | 6 | unstable |" in out
    assert "- regression: read your diff" in out
    assert "- unstable: " in out and "bean" in out


def test_check_stale_baseline(check, capsys):
    rc, runner, _ = check([_doc({"a/1": {"n": 11, "k": 10}, "b/2": {"n": 5}}),
                           _doc({"a/1": {"n": 11, "k": 10}})],
                          [_doc({"a/1": {"n": 11, "k": 10}})])
    assert rc == 1
    assert runner.mb_only == [["a/1"]]
    assert "| a/1 | n | 10 | 11 | stale-baseline |" in capsys.readouterr().out


def test_check_without_baseline_refuses(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(run, "_runner", lambda repo, side: pytest.fail("ran without a baseline"))
    assert run.do_check(tmp_path, "backend") == 1
    assert "--bootstrap" in capsys.readouterr().out
    assert not (tmp_path / "perf" / "baseline-backend.json").exists()


def test_check_holds_improvements_while_failing(check, capsys):
    rc, _, path = check([_doc({"a/1": {"n": 11, "k": 8}, "b/2": {"n": 5}}),
                         _doc({"a/1": {"n": 11, "k": 8}})],
                        [_doc({"a/1": {"n": 10, "k": 10}})])
    assert rc == 1
    assert json.loads(path.read_text())["scenarios"]["a/1"]["k"]["value"] == 10
    out = capsys.readouterr().out
    assert "once the check passes" in out
    assert "baseline updated" not in out


def test_check_records_improvements_when_passing(check, capsys):
    rc, runner, path = check([_doc({"a/1": {"n": 10, "k": 8}, "b/2": {"n": 5}})])
    assert rc == 0
    assert runner.head_only == [None]
    assert runner.mb_only == []
    assert json.loads(path.read_text())["scenarios"]["a/1"]["k"]["value"] == 8
    out = capsys.readouterr().out
    assert "baseline updated" in out
    assert "next:" not in out


@pytest.mark.parametrize("runs", ["0", "1"])
def test_runs_below_two_rejected(runs, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["perf/check.sh", "backend", "--bootstrap", "--runs", runs])
    monkeypatch.setattr(run, "repo_root", lambda: pytest.fail("parsed a bad --runs"))
    with pytest.raises(SystemExit) as e:
        run.main()
    assert e.value.code == 2
    assert "--runs" in capsys.readouterr().err


def _sleeper(ignore_term=False):
    code = "import signal, time\n"
    if ignore_term:
        code += "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
    code += "print('ready', flush=True)\ntime.sleep(60)\n"
    p = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE,
                         start_new_session=True, text=True)
    assert p.stdout is not None and p.stdout.readline() == "ready\n"
    return p


def test_wait_healthy_rejects_a_server_that_is_not_ours(monkeypatch):
    class Foreign(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, format, *args):
            pass
    httpd = http.server.HTTPServer(("127.0.0.1", 0), Foreign)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    monkeypatch.setattr(run, "FRONTEND_PORT", httpd.server_address[1])
    ours = _sleeper()
    try:
        with pytest.raises(run.PerfRunError, match="another server answers"):
            run.FrontendRunner(Path("/repo"))._wait_healthy(ours, "our-token")
    finally:
        httpd.shutdown()
        ours.kill()
        ours.wait()


def test_stop_kills_a_server_that_ignores_terminate(monkeypatch):
    monkeypatch.setattr(run, "STOP_TIMEOUT_S", 0.5)
    p = _sleeper(ignore_term=True)
    run._stop(p)
    assert p.returncode == -signal.SIGKILL


def test_prune_worktrees_removes_only_long_unused(tmp_path, monkeypatch):
    root = tmp_path / "worktrees"
    for name, age_days in [("old", 8), ("recent", 2), ("current", 30)]:
        (root / name).mkdir(parents=True)
        (root / name / run.USED_MARKER).touch()
        t = time.time() - age_days * 86_400
        os.utime(root / name / run.USED_MARKER, (t, t))
    calls = []
    monkeypatch.setattr(run, "_git", lambda repo, *a: calls.append(a) or "")
    run.prune_worktrees(tmp_path, root, keep=root / "current")
    assert calls == [("worktree", "remove", "--force", str(root / "old")), ("worktree", "prune")]
