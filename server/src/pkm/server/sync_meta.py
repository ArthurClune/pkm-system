# pattern: Imperative Shell
from __future__ import annotations

import sqlite3


def plain_space_title_canonicalization_active(db: sqlite3.Connection) -> bool:
    row = db.execute(
        "SELECT value FROM sync_meta WHERE key = 'plain_space_title_canonicalization'"
    ).fetchone()
    return row is not None and row[0] == "1"


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
