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
from pkm.db_sidecars import sidecar_paths
from pkm.db_swap import swap_refusal
from pkm.server.config import load_config
from pkm.server.db import init_db
from pkm.server.sync_meta import rotate_database_generation


class RestoreRefused(Exception):
    pass


def _refuse_snapshot_sidecars(snapshot: Path) -> None:
    present = [p.name for p in sidecar_paths(snapshot) if p.exists()]
    if present:
        raise RestoreRefused(
            f"{', '.join(present)} beside the snapshot {snapshot}: it is"
            " open, or its WAL holds commits the file lacks. Restore from a"
            f" copy made with `sqlite3 '{snapshot}' '.backup COPY'`.")


def restore_snapshot(snapshot: Path, target: Path) -> str:
    """Copy `snapshot` over `target` and return the generation it now
    carries. The copy is built and rotated beside `target`, then renamed
    in, so a failure leaves `target` as it was.

    The snapshot is copied as bytes rather than opened: a read-only SQLite
    connection to a WAL-mode file leaves `-wal` and `-shm` beside it on
    close, which would litter the backup folders. So a snapshot with its
    own sidecars is refused, since the file alone may be incomplete.
    Sidecars beside `target` are folded first (`db_swap.swap_refusal`)."""
    if not snapshot.is_file():
        raise RestoreRefused(f"snapshot not found: {snapshot}")
    _refuse_snapshot_sidecars(snapshot)
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
        refusal = swap_refusal(target)
        if refusal is not None:
            raise RestoreRefused(refusal)
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
