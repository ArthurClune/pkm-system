# pattern: Imperative Shell
"""The typed database handle: feature code holds a `Db`, never a raw
`sqlite3.Connection`, and reads rows through `select`, which returns dicts
typed by `pkm.rows.Row` and (in tests and the test servers) checks each one
against that vocabulary."""
from __future__ import annotations

import os
import sqlite3
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import NamedTuple, cast

from pkm.rows import Row, row_problems

Params = Sequence[object] | Mapping[str, object]


class RowCheckError(AssertionError):
    """A selected row failed `row_problems`."""


class WriteResult(NamedTuple):
    rowcount: int
    lastrowid: int | None


class Db:
    def __init__(self, con: sqlite3.Connection, *, check_rows: bool) -> None:
        self._con = con
        self._check_rows = check_rows

    @property
    def raw(self) -> sqlite3.Connection:
        """For tests and tooling only; product code goes through `Db`."""
        return self._con

    @property
    def in_transaction(self) -> bool:
        return self._con.in_transaction

    def select(self, sql: str, params: Params = ()) -> list[Row]:
        cursor = self._con.execute(sql, params)
        names = [d[0] for d in cursor.description or ()]
        rows = [cast(Row, dict(zip(names, values)))
                for values in cursor.fetchall()]
        if self._check_rows:
            for row in rows:
                problems = row_problems(row)
                if problems:
                    raise RowCheckError(_check_message(sql, problems))
        return rows

    def select_one(self, sql: str, params: Params = ()) -> Row | None:
        rows = self.select(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: Params = ()) -> WriteResult:
        """Run a write; reads go through `select`."""
        cursor = self._con.execute(sql, params)
        return WriteResult(cursor.rowcount, cursor.lastrowid)

    def executemany(self, sql: str,
                    param_rows: Iterable[Params]) -> WriteResult:
        cursor = self._con.executemany(sql, param_rows)
        return WriteResult(cursor.rowcount, cursor.lastrowid)

    def executescript(self, sql: str) -> None:
        self._con.executescript(sql)

    def begin_immediate(self) -> None:
        self._con.execute("BEGIN IMMEDIATE")

    def commit(self) -> None:
        self._con.commit()

    def rollback(self) -> None:
        self._con.rollback()

    def close(self) -> None:
        self._con.close()

    def table_columns(self, table: str) -> set[str]:
        """Column names of `table` (catalog read; bypasses the row check)."""
        return {str(r[1])
                for r in self._con.execute(f"PRAGMA table_info({table})")}

    def trigger_sql(self, name: str) -> str | None:
        """The stored SQL of trigger `name`, or None when it is absent."""
        found = self._con.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger'"
            " AND name = ?", (name,)).fetchone()
        return None if found is None else str(found[0])

    def backup_to(self, path: Path) -> None:
        """Copy this database to a new file with the sqlite backup API."""
        dst = sqlite3.connect(path)
        try:
            self._con.backup(dst)
        finally:
            dst.close()


def _check_message(sql: str, problems: list[str]) -> str:
    return (f"row check failed for {' '.join(sql.split())!r}: "
            + "; ".join(problems)
            + ". Fix the query: alias the column to a key of pkm.rows.Row"
              " (or register it in brand_registry.COLUMN_KEYS / add a Row"
              " key), COALESCE a NULL aggregate or use a nullable key;"
              " never loosen row_problems.")


def connect(path: Path | str, *, read_only: bool = False, uri: bool = False,
            check_same_thread: bool = True) -> Db:
    """Open `path` as a `Db`. The raw connection returns plain tuples;
    `select` builds dicts from the cursor description. `read_only`
    builds its own `mode=ro` URI from `path`, so it cannot be combined
    with a caller-supplied URI."""
    if read_only and uri:
        raise ValueError("read_only builds its own URI; pass a plain path")
    target = (Path(path).resolve().as_uri() + "?mode=ro"
              if read_only else str(path))
    con = sqlite3.connect(target, uri=uri or read_only,
                          check_same_thread=check_same_thread)
    return Db(con, check_rows=os.environ.get("PKM_ROW_CHECK") == "1")
