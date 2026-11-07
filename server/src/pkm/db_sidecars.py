# pattern: Functional Core
"""Tools that swap a whole database file in (the importer, a restore) refuse
while the WAL files sit beside it. SQLite replays a `-wal` over whatever file
holds the name on the next open, so a file swapped in under a live server
reads as the old database, or a mix of both.

`db_swap.swap_refusal` first folds sidecars that a crash or a closed
read-only reader (the nightly backup) left, so only an open connection
keeps them. The server opens a connection per request, so an idle server
holds none and passes; stopping it stays the operator's step."""
from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path


def sidecar_paths(db_path: Path) -> tuple[Path, Path]:
    return (db_path.with_name(db_path.name + "-wal"),
            db_path.with_name(db_path.name + "-shm"))


def live_sidecar_refusal(db_path: Path,
                         present: Sequence[Path]) -> str | None:
    """The refusal for the sidecars still beside `db_path` after a fold,
    or None."""
    if not present:
        return None
    names = ", ".join(p.name for p in present)
    return (f"{names} beside {db_path}: another connection still has the"
            " database open, so the server is running. Stop the server"
            " first, then run this again.")
