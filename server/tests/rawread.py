"""Read a database from a test outside the `Row` vocabulary that
`Db.select` enforces (catalog tables, journal columns, counts). Rows are
tuples that also index by column name, so they compare equal to plain tuples
and `dict(row)` works.

A returned column named for a row key that carries a brand is refused: that
value is read with `Db.select`, whose row check validates it."""
import sqlite3
from typing import Any

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


def _refuse_brand_columns(cursor: sqlite3.Cursor) -> None:
    for column, *_ in cursor.description or ():
        spec = KEYS.get(column)
        if spec is not None and spec.brand is not None:
            raise AssertionError(f"{column} carries {spec.brand}: read it with Db.select under its row key")


def read(db: Db | sqlite3.Connection, sql: str,
         params: Params = ()) -> sqlite3.Cursor:
    con = db.raw if isinstance(db, Db) else db
    cursor = con.cursor()
    cursor.row_factory = _factory
    cursor.execute(sql, params)
    _refuse_brand_columns(cursor)
    return cursor
