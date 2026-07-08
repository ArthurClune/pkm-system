# pattern: Imperative Shell
"""Full-text search (query evaluation joins in Task 8)."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.fts import escape_fts_query

router = APIRouter(dependencies=[Depends(require_auth)])


@router.get("/api/search")
def search(q: str = "", limit: int = 20,
           db: sqlite3.Connection = Depends(get_db)) -> dict:
    limit = max(1, min(limit, 100))
    if not q.strip():
        return {"pages": [], "blocks": []}
    match = escape_fts_query(q)
    pages = [dict(r) for r in db.execute(
        """SELECT p.id, p.title FROM pages_fts f
            JOIN pages p ON p.id = f.rowid
           WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?""",
        (match, limit)).fetchall()]
    blocks = [dict(r) for r in db.execute(
        """SELECT b.uid, p.title AS page_title,
                  snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 16)
                    AS snippet
             FROM blocks_fts f
             JOIN blocks b ON b.rowid = f.rowid
             JOIN pages p ON p.id = b.page_id
            WHERE blocks_fts MATCH ? ORDER BY rank LIMIT ?""",
        (match, limit)).fetchall()]
    return {"pages": pages, "blocks": blocks}
