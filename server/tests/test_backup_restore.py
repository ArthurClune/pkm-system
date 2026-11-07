import json
from pathlib import Path

from pkm.backup.__main__ import sqlite_backup
from pkm.backup.restore import main
from pkm.database import connect
from pkm.server.config import Config


def _write_config(config: Config) -> Path:
    data = config.db_path.parent
    (data / "config.json").write_text(json.dumps({
        "db_file": config.db_path.name, "assets_dir": "assets",
        "password_salt": "ab", "password_hash": "cd",
        "session_secret": "ef"}))
    return data


def _snapshot(config: Config, dest: Path) -> Path:
    sqlite_backup(config.db_path, dest)
    # The backup's read-only connection cannot checkpoint, so it leaves the
    # WAL files beside the source; the last read-write close removes them.
    rw = connect(config.db_path)
    rw.select("SELECT count(*) AS n FROM sqlite_master")
    rw.close()
    return dest


def _feed(client, since=0):
    r = client.get(f"/api/sync/changes?since={since}")
    assert r.status_code == 200
    return r.json()


def _edit(client, batch, text):
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": batch,
        "ops": [{"op": "update_text", "uid": "uid_b1", "text": text}]})
    assert r.status_code == 200


def test_restore_rotates_the_generation_the_changes_feed_reports(
        client, seeded_config, tmp_path, capsys):
    # A device whose cursor passed the backup's head must not go on pulling
    # from that cursor once the restored journal reuses those seqs.
    data = _write_config(seeded_config)
    _edit(client, "before_backup", "kept by the backup")
    backup_head = _feed(client)["latest_seq"]
    snapshot = _snapshot(seeded_config, tmp_path / "pkm-2026-11-01.sqlite3")
    _edit(client, "after_backup", "lost by the restore")
    before = _feed(client)

    assert main([str(snapshot), "--data-dir", str(data)]) == 0

    after = _feed(client, since=backup_head)
    assert after["reset"] is False  # the cursor guard alone cannot tell
    assert after["generation"] != before["generation"]
    blocks = {b["uid"]: b["text"] for b in _feed(client)["blocks"]}
    assert blocks["uid_b1"] == "kept by the backup"
    assert after["generation"] in capsys.readouterr().out


def _leftovers(data: Path) -> list[str]:
    return sorted(p.name for p in data.iterdir()
                  if p.name.startswith("pkm.sqlite3") and p.name != "pkm.sqlite3")


def test_restore_leaves_no_temp_or_wal_files(seeded_config, tmp_path):
    data = _write_config(seeded_config)
    backups = tmp_path / "backups"
    backups.mkdir()
    snapshot = _snapshot(seeded_config, backups / "snap.sqlite3")
    assert main([str(snapshot), "--data-dir", str(data)]) == 0
    assert _leftovers(data) == []
    assert [p.name for p in backups.iterdir()] == ["snap.sqlite3"]


def test_restore_refuses_a_snapshot_with_its_own_wal(
        seeded_config, tmp_path, capsys):
    data = _write_config(seeded_config)
    snapshot = _snapshot(seeded_config, tmp_path / "snap.sqlite3")
    (tmp_path / "snap.sqlite3-wal").write_bytes(b"pages")
    live = seeded_config.db_path.read_bytes()
    assert main([str(snapshot), "--data-dir", str(data)]) == 2
    assert "snap.sqlite3-wal" in capsys.readouterr().err
    assert seeded_config.db_path.read_bytes() == live


def test_restore_folds_the_sidecars_a_closed_reader_left(
        seeded_config, tmp_path):
    data = _write_config(seeded_config)
    snapshot = _snapshot(seeded_config, tmp_path / "snap.sqlite3")
    reader = connect(seeded_config.db_path, read_only=True)
    reader.select("SELECT count(*) AS n FROM pages")
    reader.close()
    assert _leftovers(data) == ["pkm.sqlite3-shm", "pkm.sqlite3-wal"]
    assert main([str(snapshot), "--data-dir", str(data)]) == 0
    assert _leftovers(data) == []


def test_restore_refuses_while_a_connection_holds_the_target(
        seeded_config, tmp_path, capsys):
    data = _write_config(seeded_config)
    snapshot = _snapshot(seeded_config, tmp_path / "snap.sqlite3")
    live = seeded_config.db_path.read_bytes()
    writer = connect(seeded_config.db_path)
    try:
        writer.select("SELECT count(*) AS n FROM pages")
        assert main([str(snapshot), "--data-dir", str(data)]) == 2
        assert seeded_config.db_path.read_bytes() == live
        assert _leftovers(data) == ["pkm.sqlite3-shm", "pkm.sqlite3-wal"]
    finally:
        writer.close()
    assert "stop the server first" in capsys.readouterr().err.lower()


def test_restore_refuses_a_missing_snapshot(seeded_config, tmp_path, capsys):
    data = _write_config(seeded_config)
    live = seeded_config.db_path.read_bytes()
    assert main([str(tmp_path / "nope.sqlite3"), "--data-dir", str(data)]) == 2
    assert "snapshot not found" in capsys.readouterr().err
    assert seeded_config.db_path.read_bytes() == live


def test_a_snapshot_older_than_sync_meta_gets_a_generation(
        client, seeded_config, tmp_path):
    data = _write_config(seeded_config)
    snapshot = _snapshot(seeded_config, tmp_path / "snap.sqlite3")
    old = connect(snapshot)
    old.execute("DROP TABLE sync_meta")
    old.commit()
    old.close()
    assert main([str(snapshot), "--data-dir", str(data)]) == 0
    assert len(_feed(client)["generation"]) == 32
