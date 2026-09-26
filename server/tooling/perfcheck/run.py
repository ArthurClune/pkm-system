# pattern: Imperative Shell
"""perf/check.sh entry point: run the side(s) a diff touches, compare with the
committed baseline, confirm candidates (re-run, then merge base), write
ratcheted baselines, print the table.

Merge-base runs use this branch's harness (perfcheck, check.mjs,
e2e_serve.py) against the merge base's product code (pkm package, web/dist),
so they work even when the merge base predates this tooling."""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from perfcheck.build import cache_dir, fixture_hash
from perfcheck.compare import (bootstrap, compare, confirm, incomparable_reason,
                               render_table)
from perfcheck.fixture import FROZEN_NOW
from perfcheck.run_core import exit_code, frontend_letters, scenarios_of, sides_for

FRONTEND_PORT = 8977
TZ = "Europe/London"


class PerfRunError(RuntimeError):
    pass


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True,
                          capture_output=True, text=True).stdout


def repo_root() -> Path:
    return Path(_git(Path.cwd(), "rev-parse", "--show-toplevel").strip())


def changed_paths(repo: Path) -> list[str]:
    base = _git(repo, "merge-base", "HEAD", "main").strip()
    tracked = _git(repo, "diff", "--name-only", base).split()
    untracked = _git(repo, "ls-files", "--others", "--exclude-standard").split()
    return sorted(set(tracked) | set(untracked))


def head_commit(repo: Path) -> str:
    dirty = _git(repo, "status", "--porcelain").strip()
    sha = _git(repo, "rev-parse", "--short", "HEAD").strip()
    return f"{sha}+dirty" if dirty else sha


def _base_env() -> dict[str, str]:
    return {**os.environ, "TZ": TZ}


def _python(worktree: Path) -> list[str]:
    """Python in `worktree`'s server venv. The harness imports time-machine,
    which a merge base older than this tooling doesn't have installed."""
    return ["uv", "run", "--project", str(worktree / "server"), "--with", "time-machine", "python"]


class BackendRunner:
    def __init__(self, repo: Path) -> None:
        self.repo = repo

    def command(self, worktree: Path, only: list[str] | None, commit: str,
                out: Path) -> tuple[list[str], dict[str, str]]:
        cmd = [*_python(worktree), "-m", "perfcheck.backend", "--out", str(out), "--commit", commit]
        if only:
            cmd += ["--only", ",".join(only)]
        return cmd, {**_base_env(), "PYTHONPATH": str(self.repo / "server" / "tooling")}

    def run(self, worktree: Path, only: list[str] | None, commit: str) -> dict:
        out = self.repo / "perf" / "out" / "result-backend.json"
        out.unlink(missing_ok=True)
        cmd, env = self.command(worktree, only, commit, out)
        subprocess.run(cmd, check=True, env=env, cwd=worktree / "server")
        return json.loads(out.read_text())


class FrontendRunner:
    def __init__(self, repo: Path) -> None:
        self.repo = repo
        self._built = False

    def ensure_port_free(self) -> None:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", FRONTEND_PORT)) == 0:
                raise PerfRunError(f"port {FRONTEND_PORT} is in use; stop whatever holds it "
                                   "(never use 8974/8975 instead)")

    def fixture_path(self, worktree: Path) -> Path:
        out = subprocess.run(
            [*_python(worktree), "-c",
             "from perfcheck.build import cached_fixture; print(cached_fixture())"],
            check=True, capture_output=True, text=True,
            env={**_base_env(), "PYTHONPATH": str(self.repo / "server" / "tooling")})
        return Path(out.stdout.strip())

    def server_command(self, worktree: Path, fixture: Path) -> tuple[list[str], dict[str, str]]:
        cmd = [*_python(worktree), str(self.repo / "server" / "tests" / "e2e_serve.py")]
        env = {**_base_env(), "E2E_PORT": str(FRONTEND_PORT), "E2E_FROM_DB": str(fixture),
               "E2E_FROZEN_NOW": FROZEN_NOW.isoformat(),
               "E2E_WEB_DIST": str(worktree / "web" / "dist"),
               "PYTHONPATH": str(self.repo / "server" / "tooling")}
        return cmd, env

    def run(self, worktree: Path, only: list[str] | None, commit: str) -> dict:
        self.ensure_port_free()
        if worktree == self.repo and not self._built:
            subprocess.run(["pnpm", "build"], check=True, cwd=self.repo / "web",
                           env={**_base_env(), "CI": "true"})
            self._built = True
        fixture = self.fixture_path(worktree)
        cmd, env = self.server_command(worktree, fixture)
        # stdout is uvicorn's access log; boot failures still reach stderr
        server = subprocess.Popen(cmd, env=env, cwd=self.repo / "server", stdout=subprocess.DEVNULL)
        out = self.repo / "perf" / "out" / "result-frontend.json"
        out.unlink(missing_ok=True)
        try:
            self._wait_healthy(server)
            node = ["node", str(self.repo / "web" / "tooling" / "perf" / "check.mjs"), "--out", str(out)]
            if only:
                node += ["--only", frontend_letters(only)]
            subprocess.run(node, check=True, cwd=self.repo / "web", env={
                **_base_env(), "E2E_PORT": str(FRONTEND_PORT),
                "PERF_FROZEN_NOW": FROZEN_NOW.isoformat(),
                "PERF_FIXTURE_HASH": fixture_hash(), "PERF_COMMIT": commit})
        finally:
            server.terminate()
            server.wait(timeout=30)
        doc = json.loads(out.read_text())
        if only:  # a letter can cover several scenarios; keep only those asked for
            doc["scenarios"] = {k: v for k, v in doc["scenarios"].items() if k in set(only)}
        return doc

    def _wait_healthy(self, server: subprocess.Popen) -> None:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise PerfRunError(f"fixture server exited with {server.returncode}")
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{FRONTEND_PORT}/healthz", timeout=1)
                return
            except OSError:
                time.sleep(0.5)
        raise PerfRunError("fixture server did not become healthy within 60 s")


def merge_base_worktree(repo: Path, side: str) -> tuple[Path, str]:
    sha = _git(repo, "merge-base", "HEAD", "main").strip()
    wt = cache_dir() / "worktrees" / sha[:12]
    if not wt.exists():
        _git(repo, "worktree", "prune")  # forget a cached worktree whose directory was deleted
        _git(repo, "worktree", "add", "--detach", str(wt), sha)
    if side == "frontend" and not (wt / ".perf-built").exists():
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], check=True, cwd=wt / "web",
                       env={**_base_env(), "CI": "true"})
        subprocess.run(["pnpm", "build"], check=True, cwd=wt / "web",
                       env={**_base_env(), "CI": "true"})
        (wt / ".perf-built").touch()
    return wt, sha[:7]


def _runner(repo: Path, side: str) -> BackendRunner | FrontendRunner:
    return BackendRunner(repo) if side == "backend" else FrontendRunner(repo)


def _baseline_path(repo: Path, side: str) -> Path:
    return repo / "perf" / f"baseline-{side}.json"


def _write(path: Path, doc: dict) -> None:
    path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")


def do_bootstrap(repo: Path, side: str, runs: int, at_merge_base: bool) -> int:
    runner = _runner(repo, side)
    wt, commit = merge_base_worktree(repo, side) if at_merge_base else (repo, head_commit(repo))
    docs = [runner.run(wt, None, commit) for _ in range(runs)]
    base, unstable = bootstrap(docs)
    if base is None:
        print(f"## {side}: {len(unstable)} unstable metric(s) — reconcile before recording a baseline\n")
        for u in unstable:
            print(f"- {u.scenario} {u.metric}: {list(u.values)}")
        print("\nSee the spec's Determinism section: fix the source in the harness first; "
              "reclassify to band only if the variation is inherent.")
        return 1
    _write(_baseline_path(repo, side), base)
    print(f"## {side}: baseline written from {runs} runs at {commit}")
    return 0


def do_check(repo: Path, side: str) -> int:
    path = _baseline_path(repo, side)
    if not path.exists():
        print(f"## {side}: no baseline — run `perf/check.sh {side} --bootstrap`")
        return 1
    baseline = json.loads(path.read_text())
    runner = _runner(repo, side)
    result = runner.run(repo, None, head_commit(repo))
    reason = incomparable_reason(baseline, result)
    if reason:
        print(f"## {side}: cannot compare — {reason}.\n"
              f"Run `perf/check.sh {side} --rebaseline`, then check again.")
        return 1
    c = compare(baseline, result)
    outcomes = {}
    if c.candidates:
        names = scenarios_of(c.candidates)
        rerun = runner.run(repo, names, head_commit(repo))
        survivors = [f for f in c.candidates
                     if confirm(baseline, [f], rerun, None)[(f.scenario, f.metric)] == "regression"]
        mb = None
        if survivors:
            wt, mb_commit = merge_base_worktree(repo, side)
            mb = runner.run(wt, scenarios_of(survivors), mb_commit)
        outcomes = confirm(baseline, c.candidates, rerun, mb)
    rc = exit_code(c, outcomes)
    improved = c.new_baseline != baseline
    if improved and rc == 0:  # only a passing check may ratchet the baseline
        _write(path, c.new_baseline)
    print(f"## perf: {side}\n")
    print(render_table(c.findings, outcomes) if c.findings else "no changes against the baseline")
    if improved and rc == 0:
        print(f"\nbaseline updated: {path.relative_to(repo)} — commit it with this change")
    elif improved:
        print(f"\nimprovements not recorded: {path.relative_to(repo)} is updated once the check passes")
    return rc


def _runs(value: str) -> int:
    n = int(value)
    if n < 2:  # one run can't show which counts are unstable
        raise argparse.ArgumentTypeError("must be at least 2")
    return n


def main() -> int:
    ap = argparse.ArgumentParser(prog="perf/check.sh")
    ap.add_argument("side", nargs="?", default="auto", choices=["auto", "backend", "frontend"])
    ap.add_argument("--bootstrap", action="store_true")
    ap.add_argument("--rebaseline", action="store_true")
    ap.add_argument("--runs", type=_runs, default=5)
    a = ap.parse_args()
    repo = repo_root()
    sides = sides_for(changed_paths(repo)) if a.side == "auto" else [a.side]
    if not sides:
        print("## perf: no backend or frontend changes — nothing to check")
        return 0
    rc = 0
    for side in sides:
        try:
            if a.bootstrap or a.rebaseline:
                rc |= do_bootstrap(repo, side, a.runs, at_merge_base=a.rebaseline)
            else:
                rc |= do_check(repo, side)
        except (PerfRunError, subprocess.CalledProcessError) as e:
            print(f"## perf: {side} failed — {e}", file=sys.stderr)
            rc |= 2
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
