import sqlite3
from pathlib import Path

import pytest

from rawread import read
from pkm.database import Db, RowCheckError, WriteResult, connect


def _db(tmp_path: Path, **kw: bool) -> Db:
    db = connect(tmp_path / "t.db", **kw)
    db.executescript(
        "CREATE TABLE blocks(uid TEXT, text TEXT);"
        "INSERT INTO blocks VALUES ('abcdefghi', 'hello world');")
    db.commit()
    return db


def test_select_returns_dicts_keyed_by_column(tmp_path: Path) -> None:
    rows = _db(tmp_path).select("SELECT uid, text FROM blocks")
    assert rows == [{"uid": "abcdefghi", "text": "hello world"}]
    assert type(rows[0]) is dict


def test_select_one_none_when_empty(tmp_path: Path) -> None:
    db = _db(tmp_path)
    assert db.select_one("SELECT uid FROM blocks WHERE uid = ?", ("x",)) is None
    assert db.select_one("SELECT uid FROM blocks") == {"uid": "abcdefghi"}


def test_row_check_raises_on_unregistered_alias(tmp_path: Path) -> None:
    db = _db(tmp_path)
    db._check_rows = True
    with pytest.raises(RowCheckError) as err:
        db.select("SELECT text AS uid FROM blocks")
    assert "SELECT text AS uid" in str(err.value)
    assert "alias the column" in str(err.value)


def test_row_check_off_without_env(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PKM_ROW_CHECK", raising=False)
    db = _db(tmp_path)
    assert db.select("SELECT text AS uid FROM blocks")[0]["uid"] == "hello world"


def test_row_check_on_with_env(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PKM_ROW_CHECK", "1")
    db = _db(tmp_path)
    with pytest.raises(RowCheckError):
        db.select("SELECT text AS uid FROM blocks")


def test_db_preserves_isolation_level(tmp_path: Path) -> None:
    assert connect(tmp_path / "t.db").raw.isolation_level == ""


def test_begin_immediate_blocks_second_writer(tmp_path: Path) -> None:
    first = _db(tmp_path)
    second = connect(tmp_path / "t.db")
    read(second, "PRAGMA busy_timeout=50")
    first.begin_immediate()
    with pytest.raises(sqlite3.OperationalError, match="locked"):
        second.begin_immediate()
    first.rollback()
    second.begin_immediate()
    assert second.in_transaction
    second.rollback()


def test_read_only_db_refuses_write(tmp_path: Path) -> None:
    _db(tmp_path).close()
    ro = connect(tmp_path / "t.db", read_only=True)
    assert ro.select("SELECT uid FROM blocks")
    with pytest.raises(sqlite3.OperationalError):
        ro.execute("DELETE FROM blocks")


def test_table_columns(tmp_path: Path) -> None:
    assert _db(tmp_path).table_columns("blocks") == {"uid", "text"}


def test_trigger_sql(tmp_path: Path) -> None:
    db = _db(tmp_path)
    assert db.trigger_sql("nope") is None
    db.execute("CREATE TRIGGER trg AFTER DELETE ON blocks BEGIN SELECT 1; END")
    assert "AFTER DELETE" in (db.trigger_sql("trg") or "")


def test_executemany_reports_rowcount(tmp_path: Path) -> None:
    db = _db(tmp_path)
    result = db.executemany("INSERT INTO blocks VALUES (?, ?)",
                            [("a", "b"), ("c", "d")])
    assert isinstance(result, WriteResult)
    assert result.rowcount == 2


def test_backup_to_copies(tmp_path: Path) -> None:
    db = _db(tmp_path)
    dest = tmp_path / "copy.db"
    db.backup_to(dest)
    copy = connect(dest)
    assert copy.select("SELECT text FROM blocks") == [{"text": "hello world"}]


def test_read_only_with_uri_refuses_a_target_that_could_write(
        tmp_path: Path) -> None:
    _db(tmp_path).close()
    with pytest.raises(ValueError, match="read_only"):
        connect(f"file:{tmp_path / 't.db'}", read_only=True, uri=True)


def test_read_only_path_with_uri_metacharacters(tmp_path: Path) -> None:
    odd = tmp_path / "a?b#c%d"
    odd.mkdir()
    _db(odd).close()
    ro = connect(odd / "t.db", read_only=True)
    assert ro.select("SELECT uid FROM blocks")
    with pytest.raises(sqlite3.OperationalError):
        ro.execute("DELETE FROM blocks")


def test_execute_returns_write_result(tmp_path: Path) -> None:
    db = _db(tmp_path)
    result = db.execute("INSERT INTO blocks VALUES ('jklmnopqr', 'more')")
    assert isinstance(result, WriteResult)
    assert result.rowcount == 1
    assert result.lastrowid is not None
    assert db.execute("DELETE FROM blocks").rowcount == 2


def test_select_one_of_a_returning_write_stays_in_the_callers_transaction(
        tmp_path: Path) -> None:
    db = _db(tmp_path)
    row = db.select_one(
        "INSERT INTO blocks VALUES ('zzzzzzzzz', 't') RETURNING uid AS uid")
    assert row == {"uid": "zzzzzzzzz"}
    assert db.in_transaction
    db.rollback()
    assert [r["uid"] for r in db.select("SELECT uid FROM blocks")] == ["abcdefghi"]
    db.select_one("INSERT INTO blocks VALUES ('yyyyyyyyy', 't') RETURNING uid AS uid")
    db.commit()
    assert len(db.select("SELECT uid FROM blocks")) == 2
