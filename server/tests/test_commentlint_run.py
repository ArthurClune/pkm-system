import subprocess
from pathlib import Path

import pytest

from commentlint.run import main, staged_paths, tree_paths

REPO = Path(__file__).resolve().parents[2]
HOOK = REPO / ".githooks" / "pre-commit"


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.email", "t@example.org")
    git(tmp_path, "config", "user.name", "t")
    git(tmp_path, "config", "commit.gpgsign", "false")
    return tmp_path


def write(repo: Path, rel: str, text: str) -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_staged_paths_are_the_added_copied_modified_and_renamed_files(repo: Path):
    write(repo, "web/src/a.ts", "const a = 1;\n")
    write(repo, "web/src/b.ts", "const b = 1;\n")
    git(repo, "add", "web/src")
    git(repo, "commit", "-q", "-m", "base")
    write(repo, "web/src/a.ts", "const a = 2;\n")
    write(repo, "web/src/c.ts", "const c = 1;\n")
    git(repo, "rm", "-q", "web/src/b.ts")
    git(repo, "add", "-A", "web/src")
    assert staged_paths(repo) == ["web/src/a.ts", "web/src/c.ts"]


def test_tree_paths_are_every_tracked_file(repo: Path):
    write(repo, "web/src/a.ts", "")
    write(repo, "docs/architecture/x.md", "")
    write(repo, "untracked.ts", "")
    git(repo, "add", "web/src", "docs")
    assert tree_paths(repo) == ["docs/architecture/x.md", "web/src/a.ts"]


def test_clean_staging_passes_silently(repo: Path, capsys):
    write(repo, "web/src/a.ts", "// the reason this guard exists\nconst a = 1;\n")
    git(repo, "add", "web/src")
    assert main([], repo) == 0
    assert capsys.readouterr().err == ""


def test_a_violation_anywhere_in_a_staged_file_fails(repo: Path, capsys):
    write(repo, "web/src/a.ts", "// old comment, fixed in pkm-ab12\nconst a = 1;\n")
    git(repo, "add", "web/src")
    git(repo, "commit", "-q", "-m", "base")
    write(repo, "web/src/a.ts", "// old comment, fixed in pkm-ab12\nconst a = 2;\n")
    git(repo, "add", "web/src")
    assert main([], repo) == 1
    assert "web/src/a.ts:1: bean-id: old comment, fixed in pkm-ab12" in capsys.readouterr().err


def test_judges_the_staged_content_not_the_working_tree(repo: Path):
    write(repo, "web/src/a.ts", "// the reason\n")
    git(repo, "add", "web/src")
    write(repo, "web/src/a.ts", "// see line 40\n")
    assert main([], repo) == 0


def test_unstaged_and_unscanned_files_are_ignored(repo: Path):
    write(repo, "web/src/a.ts", "// see line 40\n")
    write(repo, "docs/troubleshooting.md", "row for pkm-ab12\n")
    git(repo, "add", "docs")
    assert main([], repo) == 0


def test_all_scans_the_tracked_tree(repo: Path, capsys):
    write(repo, "web/src/a.ts", "// see line 40\n")
    write(repo, "server/src/pkm/b.py", "# the reason\n")
    git(repo, "add", "web", "server")
    git(repo, "commit", "-q", "-m", "base")
    assert main(["--all"], repo) == 1
    err = capsys.readouterr().err
    assert "web/src/a.ts:1: line-number" in err
    assert "server/src/pkm/b.py" not in err


def test_the_hook_runs_the_lint_from_any_checkout(repo: Path):
    write(repo, "web/src/a.ts", "// (plan-3 contract note)\n")
    git(repo, "add", "web/src")
    result = subprocess.run([str(HOOK)], cwd=repo, capture_output=True, text=True)
    assert result.returncode == 1
    assert "web/src/a.ts:1: orphan-pointer" in result.stderr


def test_the_hook_is_executable():
    assert HOOK.stat().st_mode & 0o111


def test_the_tracked_tree_is_clean(capsys):
    """The sweep the hook would run, over this checkout: a clone that never set
    core.hooksPath, and a merge commit (which no pre-commit hook sees), still
    fail here."""
    assert main(["--all"], REPO) == 0, capsys.readouterr().err
