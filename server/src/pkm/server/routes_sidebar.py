# pattern: Imperative Shell
"""Persistent sidebar-entries read route (management UI is a follow-up)."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from pkm.server.auth import require_auth
from pkm.server.db import get_db

router = APIRouter(dependencies=[Depends(require_auth)])


@router.get("/api/sidebar")
def get_sidebar(db: sqlite3.Connection = Depends(get_db)) -> dict:
    rows = db.execute(
        "SELECT id, title FROM sidebar_entries ORDER BY order_idx").fetchall()
    return {"entries": [dict(r) for r in rows]}
