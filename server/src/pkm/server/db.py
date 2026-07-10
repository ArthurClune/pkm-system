# pattern: Imperative Shell
"""SQLite connection helper and FastAPI dependencies."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi import Request

from pkm.schema import SIDEBAR_ENTRIES_DDL
from pkm.server.config import Config


# Genuine writer contention (two connections' write transactions racing)
# should retry briefly rather than fail outright; init_db() below removes
# the far larger, un-retriable source of lock errors (per-connection
# WAL/DDL setup racing an in-flight transaction).
BUSY_TIMEOUT_MS = 5000


def init_db(path: Path) -> None:
    """One-time, idempotent database setup: switch to WAL journal mode and
    apply schema migrations. Call this once at process startup (serve
    entrypoints) or from test fixtures, before any connection-per-request
    is opened — never from open_db() itself. Both operations here take
    locks that are incompatible with any other connection's open write
    transaction, so running them per-request (the pre-pkm-lhzd behavior)
    could raise 'database is locked' on an ordinary concurrent request."""
    con = sqlite3.connect(path)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        # No migration runner in this project (see schema.py) — ensure
        # tables added after a database was first created exist, so
        # already-populated (e.g. production) databases pick them up with
        # no manual step.
        con.executescript(SIDEBAR_ENTRIES_DDL)
        con.commit()
    finally:
        con.close()


def open_db(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    return con


def get_config(request: Request) -> Config:
    return request.app.state.config


def get_db(request: Request):
    con = open_db(request.app.state.config.db_path)
    try:
        yield con
    finally:
        con.close()
