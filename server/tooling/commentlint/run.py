# pattern: Imperative Shell
"""`.githooks/pre-commit` entry point: lint the staged copy of every staged
file the rules cover, or with `--all` the working copy of every tracked
file, and print the report to stderr.

The staged copy, not the working tree, is what the commit will contain, so
a partially staged file is judged on what is going in."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from commentlint.core import Violation, check_text, format_report, is_scanned


def _git(repo: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True).stdout


def _paths(out: bytes) -> list[str]:
    return sorted(p.decode("utf-8") for p in out.split(b"\0") if p)


def staged_paths(repo: Path) -> list[str]:
    """Files the index adds, copies, modifies or renames; a deletion has no content to lint."""
    return _paths(_git(repo, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"))


def tree_paths(repo: Path) -> list[str]:
    return _paths(_git(repo, "ls-files", "-z"))


def _staged_text(repo: Path, path: str) -> str:
    return _git(repo, "show", f":{path}").decode("utf-8", errors="replace")


def _tree_text(repo: Path, path: str) -> str:
    return (repo / path).read_text(encoding="utf-8", errors="replace")


def main(argv: list[str], repo: Path | None = None) -> int:
    if repo is None:
        repo = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True,
                                   capture_output=True, text=True).stdout.strip())
    whole_tree = "--all" in argv
    paths = tree_paths(repo) if whole_tree else staged_paths(repo)
    read = _tree_text if whole_tree else _staged_text
    violations: list[Violation] = []
    for path in paths:
        if is_scanned(path):
            violations.extend(check_text(path, read(repo, path)))
    sys.stderr.write(format_report(violations))
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
