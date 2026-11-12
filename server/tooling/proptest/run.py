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
from collections.abc import Mapping
from pathlib import Path

from proptest.sides import resolve_file_filter, sides_for
from repo_git import changed_paths, repo_root


def _run_server(repo: Path, seed: int | None, path: str | None = None,
                replay_path: str | None = None, file: str | None = None) -> int:
    # Hypothesis replays from the seed alone: path, replay_path and file are
    # web-only.
    cmd = ["uv", "run", "pytest", "-m", "proptest", "--no-cov", "-q", "tests/props"]
    if seed is not None:
        cmd.append(f"--hypothesis-seed={seed}")
    result = subprocess.run(cmd, cwd=repo / "server",
                            env={**os.environ, "HYPOTHESIS_PROFILE": "merge"})
    return result.returncode


DEFAULT_WEB_PORT = 8978
_PRODUCTION_PORT = 8974
WEB_PASSWORD = "proptest-pw"
_HEALTH_DEADLINE_S = 30.0


def web_port(environ: Mapping[str, str]) -> int:
    """PROPTEST_PORT lets parallel sessions each run the web side on their own
    port; sync_server.py reads the same variable."""
    raw = environ.get("PROPTEST_PORT")
    if raw is None:
        return DEFAULT_WEB_PORT
    try:
        port = int(raw)
    except ValueError:
        raise ValueError(f"PROPTEST_PORT={raw!r} is not a port number") from None
    if not 0 < port < 65536:
        raise ValueError(f"PROPTEST_PORT={raw!r} is not a port number")
    if port == _PRODUCTION_PORT:
        raise ValueError(f"PROPTEST_PORT={port} is production's port")
    return port


def web_command(file: str | None = None) -> list[str]:
    # The seed travels in PROPTEST_SEED, not argv: vitest has no seed flag.
    cmd = ["pnpm", "exec", "vitest", "run", "--config", "vitest.props.config.ts"]
    if file is not None:
        cmd.append(file)
    return cmd


def web_env(port: int, seed: int | None, path: str | None,
            replay_path: str | None) -> dict[str, str]:
    """What the props suite reads (web/src/props/env.ts and sync/env.ts): the
    server, and, to replay a failure, fast-check's seed, path and command
    replay path."""
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
    try:
        port = web_port(os.environ)
    except ValueError as e:
        print(f"web: {e}", file=sys.stderr)
        return 2
    if _port_in_use(port):
        print(f"web: port {port} is already in use; refusing to touch it. "
              "Stop whatever owns it, or set PROPTEST_PORT to a free port, "
              "and re-run.", file=sys.stderr)
        return 1
    log = Path(tempfile.gettempdir()) / f"proptest-sync-server-{port}.log"
    out = Path(tempfile.gettempdir()) / f"proptest-sync-server-{port}.out"
    with out.open("w") as logf:
        server = subprocess.Popen(
            ["uv", "run", "python", "-m", "proptest.sync_server"],
            cwd=repo / "server", stdout=logf, stderr=subprocess.STDOUT,
            env={**os.environ, "TZ": "Europe/London",
                 "PYTHONPATH": str(repo / "server" / "tooling"),
                 "PROPTEST_PORT": str(port),
                 "PROPTEST_SERVER_LOG": str(log)})
        try:
            deadline = time.monotonic() + _HEALTH_DEADLINE_S
            while not _healthy(port):
                if server.poll() is not None or time.monotonic() > deadline:
                    print(f"web: sync server on port {port} did not become healthy; "
                          f"see {log} and {out}", file=sys.stderr)
                    return 1
                time.sleep(0.2)
            env = {**os.environ, **web_env(port, seed, path, replay_path)}
            return subprocess.run(web_command(file), cwd=repo / "web", env=env).returncode
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


def _props_suites(repo: Path) -> list[str]:
    root = repo / "web" / "src" / "props"
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*.prop.ts"))


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
                    help="web only: a suite directory or file under web/src/props, e.g. ops")
    a = ap.parse_args(argv)
    if a.file is not None and a.side != "web":
        print("--file is web only: name the side, as in `proptest/check.sh web --file ...`",
              file=sys.stderr)
        return 2
    repo = repo_root()
    if a.file is not None:
        suites = _props_suites(repo)
        resolved = resolve_file_filter(a.file, suites)
        if resolved is None:
            print(f"--file {a.file!r} names no suite under web/src/props. Available: "
                  + ", ".join(suites), file=sys.stderr)
            return 2
        a.file = resolved
    if a.side == "auto":
        sides = sides_for(changed_paths(repo))
        if not sides:
            print("no property sides touched")
            return 0
    else:
        sides = [a.side]
    rc = 0
    for side in sides:
        rc = max(rc, _RUNNERS[side](repo, a.seed, a.path, a.replay_path, a.file))
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
