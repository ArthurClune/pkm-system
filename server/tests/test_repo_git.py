import pytest

import repo_git


def test_sides_include_untracked(tmp_path, monkeypatch):
    monkeypatch.setattr(repo_git, "git", lambda repo, *a: {
        ("merge-base", "HEAD", "main"): "abc\n",
        ("diff", "--name-only", "abc"): "server/a.py\n",
        ("ls-files", "--others", "--exclude-standard"): "web/new.ts\n",
    }[a])
    assert repo_git.changed_paths(tmp_path) == ["server/a.py", "web/new.ts"]


def test_changed_paths_handles_paths_with_spaces(tmp_path, monkeypatch):
    # .split() would break "server/name with space.py" into three entries
    monkeypatch.setattr(repo_git, "git", lambda repo, *a: {
        ("merge-base", "HEAD", "main"): "abc\n",
        ("diff", "--name-only", "abc"): "server/a.py\nserver/name with space.py\n",
        ("ls-files", "--others", "--exclude-standard"): "web/new.ts\n",
    }[a])
    assert repo_git.changed_paths(tmp_path) == [
        "server/a.py", "server/name with space.py", "web/new.ts"]


def test_git_surfaces_stderr_on_failure(tmp_path):
    not_a_repo = tmp_path / "not-a-repo"
    not_a_repo.mkdir()
    with pytest.raises(repo_git.GitError, match="not a git repository"):
        repo_git.git(not_a_repo, "rev-parse", "--show-toplevel")
