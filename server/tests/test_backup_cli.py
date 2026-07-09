import json
import sqlite3
import subprocess
from datetime import date
from pathlib import Path

import pytest

from pkm.backup.__main__ import main
from pkm.backup.rotation import backup_name
from pkm.schema import DDL


@pytest.fixture()
def data_dir(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    con = sqlite3.connect(d / "pkm.sqlite3")
    con.executescript(DDL)
    con.execute("INSERT INTO pages VALUES (1, 'Alpha', NULL, NULL)")
    con.execute("INSERT INTO blocks VALUES "
                "('u1', 1, NULL, 0, 'hello', NULL, 0, NULL, NULL)")
    con.commit()
    con.close()
    (d / "assets").mkdir()
    (d / "config.json").write_text(json.dumps({
        "db_file": "pkm.sqlite3", "assets_dir": "assets",
        "password_salt": "ab", "password_hash": "cd",
        "session_secret": "ef"}))
    return d


def git_commits(export: Path) -> int:
    out = subprocess.run(["git", "-C", str(export), "rev-list", "--count",
                          "HEAD"], capture_output=True, text=True, check=True)
    return int(out.stdout)


def test_backup_creates_snapshot_export_and_commit(data_dir, tmp_path):
    backups = tmp_path / "backups"
    assert main(["--data-dir", str(data_dir),
                 "--backups-dir", str(backups)]) == 0
    dated = backups / "sqlite" / backup_name(date.today())
    con = sqlite3.connect(f"file:{dated}?mode=ro", uri=True)
    assert con.execute("SELECT COUNT(*) FROM blocks").fetchone()[0] == 1
    con.close()
    assert (backups / "export" / "pages" / "Alpha.md").is_file()
    assert git_commits(backups / "export") == 1


def test_second_run_with_no_changes_commits_nothing(data_dir, tmp_path):
    backups = tmp_path / "backups"
    main(["--data-dir", str(data_dir), "--backups-dir", str(backups)])
    assert main(["--data-dir", str(data_dir),
                 "--backups-dir", str(backups)]) == 0
    assert git_commits(backups / "export") == 1


def test_rotation_prunes_old_dailies(data_dir, tmp_path):
    backups = tmp_path / "backups"
    (backups / "sqlite").mkdir(parents=True)
    old = backups / "sqlite" / "pkm-2020-05-05.sqlite3"
    mid = backups / "sqlite" / "pkm-2020-05-06.sqlite3"  # May 2020's latest
    old.write_bytes(b"x")
    mid.write_bytes(b"x")
    main(["--data-dir", str(data_dir), "--backups-dir", str(backups),
          "--keep-daily", "1"])
    assert not old.exists()
    assert mid.exists()  # latest of its month: kept forever
    assert (backups / "sqlite" / backup_name(date.today())).exists()


def test_live_db_is_untouched(data_dir, tmp_path):
    live = data_dir / "pkm.sqlite3"
    before = live.stat().st_mtime_ns
    main(["--data-dir", str(data_dir), "--backups-dir", str(tmp_path / "b")])
    assert live.stat().st_mtime_ns == before
