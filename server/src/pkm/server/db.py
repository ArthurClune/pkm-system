# pattern: Imperative Shell
"""SQLite connection helper and FastAPI dependencies."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi import Request

from pkm.schema import SIDEBAR_ENTRIES_DDL
from pkm.server.config import Config


def open_db(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    # No migration runner in this project (see schema.py) — ensure tables
    # added after a database was first created exist on every open, so
    # already-populated (e.g. production) databases pick them up with no
    # manual step.
    con.executescript(SIDEBAR_ENTRIES_DDL)
    return con


def get_config(request: Request) -> Config:
    return request.app.state.config


def get_db(request: Request):
    con = open_db(request.app.state.config.db_path)
    try:
        yield con
    finally:
        con.close()
