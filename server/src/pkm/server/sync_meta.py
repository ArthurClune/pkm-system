# pattern: Imperative Shell
from __future__ import annotations

from collections.abc import Callable

from pkm.database import Db
from pkm.refs import CanonicalTitle, canonicalize_title


def plain_space_title_canonicalization_active(db: Db) -> bool:
    row = db.select_one(
        "SELECT value AS sync_meta_value FROM sync_meta"
        " WHERE key = 'plain_space_title_canonicalization'")
    return row is not None and row["sync_meta_value"] == "1"


def read_title(db: Db, title: str) -> CanonicalTitle:
    """Canonicalize a title arriving as a lookup key (URL path, query
    param, request body). Every title used to key a `pages` row goes
    through this, so routes never compare a raw/normalized title against
    the canonical form stored in `pages.title`."""
    return title_reader(db)(title)


def title_reader(db: Db) -> Callable[[str], CanonicalTitle]:
    """`read_title` for a request that canonicalises several titles: the
    flag is read once, not once per title. The sole general mint point for
    `CanonicalTitle` -- `canonicalize_title` alone only produces
    `NormalizedTitle`, since it doesn't know this database's live flag."""
    plain_space = plain_space_title_canonicalization_active(db)
    return lambda title: CanonicalTitle(
        canonicalize_title(title, plain_space=plain_space))


def set_plain_space_title_canonicalization(
    db: Db, active: bool
) -> None:
    db.execute(
        "INSERT INTO sync_meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("plain_space_title_canonicalization", "1" if active else "0"),
    )


def database_generation(db: Db) -> str:
    row = db.select_one(
        "SELECT value AS sync_meta_value FROM sync_meta"
        " WHERE key = 'db_generation'")
    return row["sync_meta_value"] if row is not None else ""


def rotate_database_generation(db: Db) -> str:
    fresh = db.select_one(
        "SELECT lower(hex(randomblob(16))) AS sync_meta_value")
    assert fresh is not None  # a bare SELECT always yields a row
    generation = fresh["sync_meta_value"]
    db.execute(
        "INSERT INTO sync_meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("db_generation", generation),
    )
    return generation
