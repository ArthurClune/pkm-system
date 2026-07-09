# pattern: Imperative Shell
"""Nightly job: python -m pkm.backup --data-dir DATA --backups-dir BACKUPS

1. SQLite online backup from a read-only connection -> backups/sqlite/,
   written to a temp name and renamed in, then rotation pruning.
2. Markdown + assets export FROM THE FRESH SNAPSHOT (sqlite copy and
   export always describe the same instant) -> backups/export/, with a
   local git auto-commit of everything except assets/.
Never opens the live database for writing. Any failure exits nonzero
(launchd surfaces it via last-exit-status and the error log)."""
from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
from datetime import date
from pathlib import Path

from pkm.backup.rotation import backup_name, prune_list
from pkm.export.writer import export_graph
from pkm.server.config import load_config

# self-contained identity: the job must not depend on global git config
GIT_ID = ["-c", "user.name=pkm-backup", "-c", "user.email=pkm-backup@localhost"]


def open_ro(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def sqlite_backup(live_db: Path, dest: Path) -> None:
    tmp = dest.with_name(dest.name + ".tmp")
    src = open_ro(live_db)
    try:
        dst = sqlite3.connect(tmp)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    os.replace(tmp, dest)


def git_commit_export(export_dir: Path, day: date) -> str:
    def git(*a: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *GIT_ID, "-C", str(export_dir), *a],
                              capture_output=True, text=True, check=True)
    if not (export_dir / ".git").is_dir():
        git("init", "-q")
    git("add", "-A")
    if git("status", "--porcelain").stdout == "":
        return "clean"
    git("commit", "-q", "-m", f"nightly export {day.isoformat()}")
    return "committed"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Nightly PKM backup + export.")
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--backups-dir", required=True)
    ap.add_argument("--keep-daily", type=int, default=14)
    args = ap.parse_args(argv)
    config = load_config(Path(args.data_dir) / "config.json")
    backups = Path(args.backups_dir)
    sqlite_dir = backups / "sqlite"
    sqlite_dir.mkdir(parents=True, exist_ok=True)

    today = date.today()
    dated = sqlite_dir / backup_name(today)
    sqlite_backup(config.db_path, dated)
    for name in prune_list(sorted(p.name for p in sqlite_dir.iterdir()),
                           args.keep_daily):
        (sqlite_dir / name).unlink()

    snapshot = open_ro(dated)
    try:
        counts = export_graph(snapshot, config.assets_dir, backups / "export")
    finally:
        snapshot.close()
    outcome = git_commit_export(backups / "export", today)
    print(f"backup ok: {dated.name} export={counts} git={outcome}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 — launchd job: fail loud, exit nonzero
        import traceback
        traceback.print_exc()
        raise SystemExit(1)
