# pattern: Imperative Shell
"""Full-text search (query evaluation joins in Task 8)."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from pkm.contracts.responses import (
    GroupsPayload, QueryPayload, SearchPayload, TitlesPayload)
from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.fts import escape_fts_query
from pkm.server.grouping import group_by_page
from pkm.server.query import (
    QueryNode, page_operands, parse_query, plan_sql, QueryParseError)
from pkm.server.query_exec import count_matches, execute_plan
from pkm.todo import is_todo

router = APIRouter(dependencies=[Depends(require_auth)])


@router.get("/api/search", response_model=SearchPayload)
def search(q: str = "", limit: int = 20, exact: bool = False,
           db: sqlite3.Connection = Depends(get_db)) -> dict:
    limit = max(1, min(limit, 100))
    if not q.strip():
        return {"pages": [], "blocks": []}
    match = escape_fts_query(q, exact)
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


@router.get("/api/query", response_model=QueryPayload)
def run_query(expr: str, expand: bool = False,
              db: sqlite3.Connection = Depends(get_db)) -> dict:
    try:
        node = parse_query(expr)
        sql, params = plan_sql(node, expand)
    except QueryParseError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # QueryPayload.ref_counts: each operand re-planned on its own and
    # counted the same way as the whole expression's total.
    ref_counts = {
        title: count_matches(db, *plan_sql(QueryNode("page", title), expand))
        for title in page_operands(node)
    }
    matches = execute_plan(db, sql, params)
    return {"groups": group_by_page(matches.rows), "total": matches.total,
            "ref_counts": ref_counts}


@router.get("/api/titles", response_model=TitlesPayload)
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


@router.get("/api/todos", response_model=GroupsPayload)
def todos(page: str | None = None,
          db: sqlite3.Connection = Depends(get_db)) -> dict:
    """Blocks whose text starts with a {{TODO}} marker, grouped by page
    (pkm-w05j). SQL narrows to TODO-containing candidates; the shared
    pkm.todo matcher (the grammar's block-start rule, both bracket
    variants, '> ' quote prefix) decides. Marker-based rather than
    refs-based: the editor emits the bracket-less {{TODO}}, which
    creates no ref row to query."""
    sql = ("SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title"
           "  FROM blocks b JOIN pages p ON p.id = b.page_id"
           " WHERE instr(b.text, 'TODO') > 0")
    params: list[str] = []
    if page is not None:
        sql += " AND p.title = ?"
        params.append(page)
    sql += " ORDER BY p.title, b.uid"
    rows = [r for r in db.execute(sql, params).fetchall()
            if is_todo(r["text"])]
    return {"groups": group_by_page(rows), "total": len(rows)}
