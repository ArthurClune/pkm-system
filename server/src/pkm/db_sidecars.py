# pattern: Functional Core
"""Tools that swap a whole database file in (the importer, a restore) refuse
while the WAL files sit beside it. SQLite replays a `-wal` over whatever file
holds the name on the next open, so a file swapped in under a live or
crashed server reads as the old database, or a mix of both.

The server opens a connection per request, so an idle server leaves no
sidecars and passes this check; stopping it stays the operator's step.
Apple's /usr/bin/sqlite3 keeps the WAL files on close, so it cannot clear
them; the server's own startup and clean stop does."""
from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path


def sidecar_paths(db_path: Path) -> tuple[Path, Path]:
    return (db_path.with_name(db_path.name + "-wal"),
            db_path.with_name(db_path.name + "-shm"))


def live_sidecar_refusal(db_path: Path,
                         present: Sequence[Path]) -> str | None:
    """The refusal for the sidecars found beside `db_path`, or None."""
    if not present:
        return None
    names = ", ".join(p.name for p in present)
    return (f"{names} beside {db_path}: stop the server first. If it is"
            " already stopped, a crash or a read-only reader such as the"
            " nightly backup left them: start the server and stop it again,"
            " which folds them in, then run this again.")
