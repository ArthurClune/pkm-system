"""Read a database from a test for what `Db.select` cannot: catalog tables
and PRAGMAs, FTS virtual tables, raw `rowid` and unaliased counts. A value
under a `Row` key is read with `Db.select`, whose row check validates it;
this module guards only the brands of that.

A returned column named for a row key that carries a brand is refused, and
so is a raw column name that COLUMN_KEYS maps to one (a bare `id`, the
sidebar's `order_idx`). Nothing else is checked: an unbranded key read here
gets no type, nullability or domain check, so reading one is a choice to
skip it. The refusal goes by returned name, so `uid AS u` reads an unbranded
value and is not refused. Rows are tuples that also index by column name, so
they compare equal to plain tuples and `dict(row)` works."""
import sqlite3
from collections.abc import Callable

from pkm.brand_registry import CLIENT_KEYS, COLUMN_KEYS
from pkm.database import Db, Params
from pkm.rows import KEYS


class NamedRow(tuple):
    _names: tuple[str, ...]

    def __getitem__(self, key):
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


def table_rows(db: Db, table: str) -> list[tuple[object, ...]]:
    """Every row of `table`, sorted, as tuples in column order, for a
    before/after comparison of a whole table. Each column is read under its
    row key (COLUMN_KEYS aliases a raw name that differs), so the row check
    validates the brands."""
    columns = [str(row[1]) for row in read(db, f"PRAGMA table_info({table})")]
    aliases = COLUMN_KEYS.get(table, {})
    named = ", ".join(f"{c} AS {aliases.get(c, c)}" for c in columns)
    return sorted(tuple(row.values())
                  for row in db.select(f"SELECT {named} FROM {table}"))
