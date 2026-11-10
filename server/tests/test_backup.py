import sqlite3
from pathlib import Path

import pytest

from pkm.backup.__main__ import sqlite_backup
from pkm.database import Db, connect
from pkm.export.writer import export_graph
from pkm.schema import DDL


def _seed(path: Path) -> None:
    db = connect(path)
    db.executescript(DDL)
    db.execute("INSERT INTO pages VALUES (1, 'Alpha', NULL, NULL)")
    db.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at) VALUES "
        "('abcdef', 1, NULL, 0, 'hello', 0, 0, NULL, NULL)")
    db.commit()
    db.close()


def test_export_reads_snapshot_through_read_only_db(tmp_path: Path) -> None:
    live = tmp_path / "live.sqlite3"
    _seed(live)
    snapshot = tmp_path / "snap.sqlite3"
    sqlite_backup(live, snapshot)
    db = connect(f"file:{snapshot}?mode=ro&immutable=1", uri=True)
    try:
        counts = export_graph(db, tmp_path / "assets", tmp_path / "export")
    finally:
        db.close()
    assert counts["pages"] == 1
    assert (tmp_path / "export" / "pages" / "Alpha.md").read_text(
        encoding="utf-8") == "# Alpha\n\n- hello\n"


def test_a_failing_backup_leaves_no_temp_file(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    live = tmp_path / "live.sqlite3"
    _seed(live)
    dest = tmp_path / "snap.sqlite3"

    def partial_then_fail(self: Db, target: Path) -> None:
        Path(target).write_bytes(b"half a database")
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(Db, "backup_to", partial_then_fail)
    with pytest.raises(sqlite3.OperationalError):
        sqlite_backup(live, dest)
    assert not dest.exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["live.sqlite3"]
