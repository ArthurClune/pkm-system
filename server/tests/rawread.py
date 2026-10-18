"""Read a database from a test outside the `Row` vocabulary that
`Db.select` enforces (catalog tables, journal columns, counts). Rows are
tuples that also index by column name, so they compare equal to plain tuples
and `dict(row)` works.

A returned column named for a row key that carries a brand is refused, and
so is a raw column name that COLUMN_KEYS maps to one (a bare `id`, the
sidebar's `order_idx`): that value is read with `Db.select`, whose row check
validates it. The refusal goes by returned name, so `uid AS u` reads an
unbranded value and is not refused."""
import sqlite3
from collections.abc import Callable
from typing import Any

from pkm.brand_registry import CLIENT_KEYS, COLUMN_KEYS
from pkm.database import Db, Params
from pkm.rows import KEYS


class NamedRow(tuple):
    _names: tuple[str, ...]

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, str):
            return super().__getitem__(self._names.index(key))
        return super().__getitem__(key)

    def keys(self) -> tuple[str, ...]:
        return self._names


def _factory(cursor: sqlite3.Cursor, values: tuple) -> NamedRow:
    row = NamedRow(values)
    row._names = tuple(d[0] for d in cursor.description)
    return row


def _key_brand(key: str) -> str | None:
    if key in KEYS:
        return KEYS[key].brand
    type_name = CLIENT_KEYS.get(key, ("string", False))[0]
    return None if type_name in ("string", "number") else type_name


def _branded_names() -> dict[str, set[str]]:
    """Returned column name -> the brands it may carry: a row key's own
    brand, and the brand of every key COLUMN_KEYS maps that raw name to."""
    out: dict[str, set[str]] = {}
    pairs = [(key, key) for key in KEYS]
    pairs += [pair for columns in COLUMN_KEYS.values() for pair in columns.items()]
    for name, key in pairs:
        brand = _key_brand(key)
        if brand is not None:
            out.setdefault(name, set()).add(brand)
    return out


_BRANDED = _branded_names()


def _refuse_brand_columns(cursor: sqlite3.Cursor) -> None:
    for column, *_ in cursor.description or ():
        brands = _BRANDED.get(column)
        if brands:
            raise AssertionError(f"{column} carries {' or '.join(sorted(brands))}: "
                                 "read it with Db.select under its row key")


def read(db: Db | sqlite3.Connection, sql: str,
         params: Params = ()) -> sqlite3.Cursor:
    con = db.raw if isinstance(db, Db) else db
    cursor = con.cursor()
    cursor.row_factory = _factory
    cursor.execute(sql, params)
    _refuse_brand_columns(cursor)
    return cursor


def trace(db: Db, callback: Callable[[str], None] | None) -> None:
    """Install SQLite's statement trace callback on `db`, or remove it with
    None: tests that count or intercept statements need the raw connection,
    which only this module may touch."""
    db.raw.set_trace_callback(callback)
