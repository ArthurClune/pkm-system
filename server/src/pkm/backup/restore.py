# pattern: Imperative Shell
"""Put a database snapshot in place, with a new db_generation:
python -m pkm.backup.restore --data-dir DATA SNAPSHOT"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

from pkm.database import connect
from pkm.db_sidecars import live_sidecar_refusal, sidecar_paths
from pkm.server.config import load_config
from pkm.server.db import init_db
from pkm.server.sync_meta import rotate_database_generation


class RestoreRefused(Exception):
    pass


def _refuse_beside_sidecars(db_path: Path) -> None:
    refusal = live_sidecar_refusal(
        db_path, [p for p in sidecar_paths(db_path) if p.exists()])
    if refusal is not None:
        raise RestoreRefused(refusal)


def restore_snapshot(snapshot: Path, target: Path) -> str:
    """Copy `snapshot` over `target` and return the generation it now
    carries. The copy is built and rotated beside `target`, then renamed
    in, so a failure leaves `target` as it was.

    The snapshot is copied as bytes rather than opened: a read-only SQLite
    connection to a WAL-mode file leaves `-wal` and `-shm` beside it on
    close, which would litter the backup folders. So a snapshot with its
    own sidecars is refused, since the file alone may be incomplete."""
    if not snapshot.is_file():
        raise RestoreRefused(f"snapshot not found: {snapshot}")
    _refuse_beside_sidecars(snapshot)
    tmp = target.with_name(target.name + ".restore-tmp")
    tmp.unlink(missing_ok=True)
    try:
        shutil.copyfile(snapshot, tmp)
        # The restored journal reuses seqs a device may already have
        # pulled past, so only a new generation makes it rebootstrap.
        # init_db first, so a snapshot older than sync_meta has the table.
        init_db(tmp)
        db = connect(tmp)
        try:
            generation = rotate_database_generation(db)
            db.commit()
        finally:
            db.close()
        _refuse_beside_sidecars(target)
        os.replace(tmp, target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return generation


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Restore a pkm.sqlite3 snapshot into a data dir whose"
                    " server is stopped.")
    ap.add_argument("snapshot", help="a pkm-YYYY-MM-DD.sqlite3 snapshot")
    ap.add_argument("--data-dir", required=True)
    args = ap.parse_args(argv)
    target = load_config(Path(args.data_dir) / "config.json").db_path
    try:
        generation = restore_snapshot(Path(args.snapshot), target)
    except RestoreRefused as exc:
        print(f"error: restore refused: {exc}", file=sys.stderr)
        return 2
    print(f"restored {args.snapshot} to {target}; new db_generation"
          f" {generation}, so every device rebuilds its local copy on its"
          " next sync")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
