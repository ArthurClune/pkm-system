# pattern: Imperative Shell
"""Per-request SQL accounting via a get_db dependency override.

Every route opens its connection through `pkm.server.db.get_db`, so
overriding that one dependency sees all of a request's SQL. Statements
reported with a leading "--" are nested ones: trigger bodies, and the
internal queries FTS5 runs (e.g. one docsize lookup per bm25-ranked row).
They are tallied separately because triggers dominate write cost and FTS5
internals dominate search cost."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field

import sqlite3
from fastapi import Request

from pkm.server.db import open_db

PROGRESS_N = 1000


@dataclass
class Tally:
    statements: list[str] = field(default_factory=list)
    trigger_statements: int = 0
    ticks: int = 0


class Tracer:
    def __init__(self) -> None:
        self._tally: Tally | None = None

    def start(self) -> None:
        self._tally = Tally()

    def stop(self) -> Tally:
        assert self._tally is not None, "stop() without start()"
        t, self._tally = self._tally, None
        return t

    def _on_sql(self, sql: str) -> None:
        if self._tally is None:
            return
        if sql.lstrip().startswith("--"):
            self._tally.trigger_statements += 1
        else:
            self._tally.statements.append(sql)

    def _on_progress(self) -> int:
        if self._tally is not None:
            self._tally.ticks += 1
        return 0

    def get_db(self, request: Request) -> Iterator[sqlite3.Connection]:
        con = open_db(request.app.state.config.db_path)
        if self._tally is not None:
            con.set_trace_callback(self._on_sql)
            con.set_progress_handler(self._on_progress, PROGRESS_N)
        try:
            yield con
        finally:
            con.close()
