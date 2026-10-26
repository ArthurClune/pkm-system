"""The server refuses to start on a SQLite too old for the SQL it runs."""
from __future__ import annotations

import sqlite3

import pytest

from pkm.server.db import init_db
from pkm.server.db_core import MIN_SQLITE_VERSION, sqlite_too_old


@pytest.mark.parametrize("found", ["3.43.0", "3.47.1", "3.100.0", "4.0.0"])
def test_a_new_enough_sqlite_passes(found):
    assert sqlite_too_old(found) is None


@pytest.mark.parametrize("found", ["3.42.9", "3.9.2", "2.8.17"])
def test_an_older_sqlite_is_refused_naming_both_versions(found):
    # 3.9.2 is older than 3.43.0, though it sorts after it as a string
    problem = sqlite_too_old(found)
    assert problem is not None
    assert found in problem
    assert ".".join(map(str, MIN_SQLITE_VERSION)) in problem


def test_init_db_refuses_an_old_sqlite_before_touching_the_file(
        tmp_path, monkeypatch):
    monkeypatch.setattr(sqlite3, "sqlite_version", "3.42.0")
    path = tmp_path / "pkm.sqlite3"
    with pytest.raises(RuntimeError, match=r"3\.42\.0.*3\.43\.0"):
        init_db(path)
    assert not path.exists()


def test_init_db_runs_on_this_sqlite(tmp_path):
    init_db(tmp_path / "pkm.sqlite3")
