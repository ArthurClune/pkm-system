"""Read a database from a test outside the `Row` vocabulary that
`Db.select` enforces (catalog tables, journal columns, counts). Rows are
tuples that also index by column name, so they compare equal to plain tuples
and `dict(row)` works."""
import sqlite3
from typing import Any

from pkm.database import Db, Params


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


def read(db: Db | sqlite3.Connection, sql: str,
         params: Params = ()) -> sqlite3.Cursor:
    con = db.raw if isinstance(db, Db) else db
    cursor = con.cursor()
    cursor.row_factory = _factory
    return cursor.execute(sql, params)
