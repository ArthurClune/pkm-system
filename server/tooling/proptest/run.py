# pattern: Imperative Shell
"""proptest/check.sh entry point: run the Hypothesis property suite for
whichever side(s) a diff touches, under the `merge` profile.

Never runs from `pytest -q` -- see `-m 'not proptest'` in
server/pyproject.toml. `auto` detects touched sides the same way
perfcheck.run does: merge base with main, plus untracked files."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
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


def _run_server(repo: Path, seed: int | None) -> int:
    cmd = ["uv", "run", "pytest", "-m", "proptest", "--no-cov", "-q", "tests/props"]
    if seed is not None:
        cmd.append(f"--hypothesis-seed={seed}")
    result = subprocess.run(cmd, cwd=repo / "server",
                            env={**os.environ, "HYPOTHESIS_PROFILE": "merge"})
    return result.returncode


_RUNNERS = {"server": _run_server}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="proptest/check.sh")
    ap.add_argument("side", nargs="?", default="auto", choices=["auto", "server", "web"])
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args(argv)
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
        rc = max(rc, _RUNNERS[side](repo, a.seed))
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
