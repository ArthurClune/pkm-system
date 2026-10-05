# pattern: Imperative Shell
"""proptest/check.sh entry point: run the Hypothesis property suite for
whichever side(s) a diff touches, under the `merge` profile.

Never runs from `pytest -q` -- see `-m 'not proptest'` in
server/pyproject.toml. `auto` detects touched sides the same way
perfcheck.run does: merge base with main, plus untracked files."""
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from proptest.sides import available, sides_for


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True,
                          capture_output=True, text=True).stdout


def repo_root() -> Path:
    return Path(_git(Path.cwd(), "rev-parse", "--show-toplevel").strip())


def changed_paths(repo: Path) -> list[str]:
    base = _git(repo, "merge-base", "HEAD", "main").strip()
    tracked = _git(repo, "diff", "--name-only", base).splitlines()
    untracked = _git(repo, "ls-files", "--others", "--exclude-standard").splitlines()
    return sorted(set(tracked) | set(untracked))


def _run_server(repo: Path, seed: int | None, path: str | None = None,
                replay_path: str | None = None, file: str | None = None) -> int:
    # Hypothesis replays from the seed alone: path, replay_path and file are web-only.
    cmd = ["uv", "run", "pytest", "-m", "proptest", "--no-cov", "-q", "tests/props"]
    if seed is not None:
        cmd.append(f"--hypothesis-seed={seed}")
    result = subprocess.run(cmd, cwd=repo / "server",
                            env={**os.environ, "HYPOTHESIS_PROFILE": "merge"})
    return result.returncode


WEB_PORT = 8978
WEB_PASSWORD = "proptest-pw"
_HEALTH_DEADLINE_S = 30.0


def web_command(seed: int | None, file: str | None = None) -> list[str]:
    # The seed travels in PROPTEST_SEED, not argv: vitest has no seed flag.
    cmd = ["pnpm", "exec", "vitest", "run", "--config", "vitest.props.config.ts"]
    if file is not None:
        cmd.append(file)
    return cmd


def web_env(port: int, seed: int | None, path: str | None,
            replay_path: str | None) -> dict[str, str]:
    """What the props suite reads (web/src/props/env.ts and sync/env.ts): the server,
    and, to replay a failure, fast-check's seed, path and command replay
    path."""
    env = {"PROPTEST_BASE_URL": f"http://127.0.0.1:{port}",
           "PROPTEST_PASSWORD": WEB_PASSWORD}
    if seed is not None:
        env["PROPTEST_SEED"] = str(seed)
    if path is not None:
        env["PROPTEST_PATH"] = path
    if replay_path is not None:
        env["PROPTEST_REPLAY_PATH"] = replay_path
    return env


def _port_in_use(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def _healthy(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1) as r:
            return r.status == 200
    except OSError:
        return False


def _run_web(repo: Path, seed: int | None, path: str | None = None,
             replay_path: str | None = None, file: str | None = None) -> int:
    if _port_in_use(WEB_PORT):
        print(f"web: port {WEB_PORT} is already in use; refusing to touch it. "
              "Stop whatever owns it and re-run.", file=sys.stderr)
        return 1
    log = Path(tempfile.gettempdir()) / "proptest-sync-server.log"
    out = Path(tempfile.gettempdir()) / "proptest-sync-server.out"
    with out.open("w") as logf:
        server = subprocess.Popen(
            ["uv", "run", "python", "-m", "proptest.sync_server"],
            cwd=repo / "server", stdout=logf, stderr=subprocess.STDOUT,
            env={**os.environ, "TZ": "Europe/London",
                 "PYTHONPATH": str(repo / "server" / "tooling"),
                 "PROPTEST_PORT": str(WEB_PORT),
                 "PROPTEST_SERVER_LOG": str(log)})
        try:
            deadline = time.monotonic() + _HEALTH_DEADLINE_S
            while not _healthy(WEB_PORT):
                if server.poll() is not None or time.monotonic() > deadline:
                    print(f"web: sync server on port {WEB_PORT} did not become healthy; "
                          f"see {log} and {out}", file=sys.stderr)
                    return 1
                time.sleep(0.2)
            env = {**os.environ, **web_env(WEB_PORT, seed, path, replay_path)}
            return subprocess.run(web_command(seed, file), cwd=repo / "web", env=env).returncode
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


_RUNNERS = {"server": _run_server, "web": _run_web}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="proptest/check.sh")
    ap.add_argument("side", nargs="?", default="auto", choices=["auto", "server", "web"])
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--path", default=None,
                    help="web only: fast-check counterexample path (with --seed)")
    ap.add_argument("--replay-path", default=None,
                    help="web only: fast-check command replayPath (with --seed and --path)")
    ap.add_argument("--file", default=None,
                    help="web only: a vitest file filter, to run one suite")
    a = ap.parse_args(argv)
    if a.file is not None and a.side != "web":
        print("--file is web only: name the side, as in `proptest/check.sh web --file ...`",
              file=sys.stderr)
        return 2
    repo = repo_root()
    if a.side == "auto":
        sides = sides_for(changed_paths(repo))
        if not sides:
            print("no property sides touched")
            return 0
    else:
        sides = [a.side]
    rc = 0
    for side in sides:
        if not available(side):
            print(f"{side}: no properties yet")
            continue
        rc = max(rc, _RUNNERS[side](repo, a.seed, a.path, a.replay_path, a.file))
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
