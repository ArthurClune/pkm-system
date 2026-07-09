# pattern: Imperative Shell
"""Full-text search (query evaluation joins in Task 8)."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.fts import escape_fts_query
from pkm.server.query import parse_query, plan_sql, QueryParseError

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


@router.get("/api/query")
def run_query(expr: str, limit: int = 100, offset: int = 0,
              db: sqlite3.Connection = Depends(get_db)) -> dict:
    limit = max(1, min(limit, 500))
    try:
        sql, params = plan_sql(parse_query(expr))
    except QueryParseError as e:
        raise HTTPException(status_code=400, detail=str(e))
    total = db.execute(
        f"SELECT count(*) FROM ({sql})", params).fetchone()[0]
    rows = db.execute(
        f"""SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title
              FROM ({sql}) m JOIN blocks b ON b.uid = m.uid
              JOIN pages p ON p.id = b.page_id
             ORDER BY p.title, b.uid LIMIT ? OFFSET ?""",
        [*params, limit, offset]).fetchall()
    groups: list[dict] = []
    index: dict[int, dict] = {}
    for r in rows:
        group = index.get(r["page_id"])
        if group is None:
            group = {"page_id": r["page_id"], "page_title": r["page_title"],
                     "items": []}
            index[r["page_id"]] = group
            groups.append(group)
        group["items"].append({"uid": r["uid"], "text": r["text"]})
    return {"groups": groups, "total": total}


@router.get("/api/titles")
def titles(q: str = "", limit: int = 10,
           db: sqlite3.Connection = Depends(get_db)) -> dict:
    """Page-title completion for the editor's [[ / # popup."""
    limit = max(1, min(limit, 50))
    needle = q.strip()
    if not needle:
        return {"titles": []}
    esc = (needle.replace("\\", "\\\\")
                 .replace("%", "\\%")
                 .replace("_", "\\_"))
    rows = db.execute(
        r"""SELECT title FROM pages
             WHERE title LIKE ? ESCAPE '\'
             ORDER BY (CASE WHEN title LIKE ? ESCAPE '\' THEN 0 ELSE 1 END),
                      length(title), title
             LIMIT ?""",
        (f"%{esc}%", f"{esc}%", limit)).fetchall()
    return {"titles": [r["title"] for r in rows]}
