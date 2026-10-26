# pattern: Functional Core
"""Whether the SQLite library the server links is new enough to run it."""
from __future__ import annotations

from typing import Final

# `octet_length`, which the rewrite rows' charge sizes a title with from
# its record header alone (`ops_apply._CHARGED_REWRITES`), came in 3.43.0.
MIN_SQLITE_VERSION: Final = (3, 43, 0)


def sqlite_too_old(found: str) -> str | None:
    """Why the server refuses to start on SQLite `found` (a version
    string such as "3.47.1"), or None when it is new enough."""
    parts = tuple(int(part) for part in found.split(".")[:3])
    if parts >= MIN_SQLITE_VERSION:
        return None
    need = ".".join(str(part) for part in MIN_SQLITE_VERSION)
    return (f"SQLite {found} is too old: the server requires"
            f" SQLite {need} or newer")
