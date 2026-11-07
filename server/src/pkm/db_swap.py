# pattern: Imperative Shell
"""The check the importer and a restore run before renaming a new database
file over `db_path`: fold leftover sidecars, then refuse if any remain."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from pkm.database import connect
from pkm.db_sidecars import live_sidecar_refusal, sidecar_paths


def _fold_sidecars(db_path: Path) -> None:
    """Open and close `db_path` read-write. As the last connection, the
    close checkpoints the WAL into the file and removes both sidecars; with
    another connection open it leaves them. Never unlink them directly: a
    live writer's WAL holds commits the file does not."""
    db = connect(db_path)
    try:
        db.select("SELECT count(*) AS n FROM sqlite_master")
    except sqlite3.DatabaseError:
        pass  # not a database: nothing to fold; the check still runs
    finally:
        db.close()


def swap_refusal(db_path: Path) -> str | None:
    if db_path.is_file():
        _fold_sidecars(db_path)
    return live_sidecar_refusal(
        db_path, [p for p in sidecar_paths(db_path) if p.exists()])
