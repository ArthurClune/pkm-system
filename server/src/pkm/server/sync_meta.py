# pattern: Imperative Shell
from __future__ import annotations

import sqlite3
from collections.abc import Callable

from pkm.refs import canonicalize_title


def plain_space_title_canonicalization_active(db: sqlite3.Connection) -> bool:
    row = db.execute(
        "SELECT value FROM sync_meta WHERE key = 'plain_space_title_canonicalization'"
    ).fetchone()
    return row is not None and row[0] == "1"


def read_title(db: sqlite3.Connection, title: str) -> str:
    """Canonicalize a title arriving as a lookup key (URL path, query
    param, request body). Every title used to key a `pages` row goes
    through this, so routes never compare a raw/normalized title against
    the canonical form stored in `pages.title`."""
    return title_reader(db)(title)


def title_reader(db: sqlite3.Connection) -> Callable[[str], str]:
    """`read_title` for a request that canonicalises several titles: the
    flag is read once, not once per title."""
    plain_space = plain_space_title_canonicalization_active(db)
    return lambda title: canonicalize_title(title, plain_space=plain_space)


def set_plain_space_title_canonicalization(
    db: sqlite3.Connection, active: bool
) -> None:
    db.execute(
        "INSERT INTO sync_meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("plain_space_title_canonicalization", "1" if active else "0"),
    )


def database_generation(db: sqlite3.Connection) -> str:
    row = db.execute("SELECT value FROM sync_meta WHERE key = 'db_generation'").fetchone()
    return row[0] if row is not None else ""


def rotate_database_generation(db: sqlite3.Connection) -> str:
    generation = db.execute("SELECT lower(hex(randomblob(16)))").fetchone()[0]
    db.execute(
        "INSERT INTO sync_meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("db_generation", generation),
    )
    return generation
