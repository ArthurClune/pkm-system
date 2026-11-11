# pattern: Imperative Shell
"""Git reads shared by the perf and property orchestrators."""
from __future__ import annotations

import subprocess
from pathlib import Path


class GitError(RuntimeError):
    pass


def git(repo: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(repo), *args], check=True,
                              capture_output=True, text=True).stdout
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        raise GitError(f"git {' '.join(args)} failed"
                       + (f": {stderr}" if stderr else "")) from e


def repo_root() -> Path:
    return Path(git(Path.cwd(), "rev-parse", "--show-toplevel").strip())


def changed_paths(repo: Path) -> list[str]:
    base = git(repo, "merge-base", "HEAD", "main").strip()
    tracked = git(repo, "diff", "--name-only", base).splitlines()
    untracked = git(repo, "ls-files", "--others", "--exclude-standard").splitlines()
    return sorted(set(tracked) | set(untracked))
