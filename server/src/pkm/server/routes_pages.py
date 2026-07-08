# pattern: Imperative Shell
"""Page read routes: page tree, block-ref resolution (backlinks: Task 5)."""
from __future__ import annotations

import sqlite3
import time
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException

from pkm.server.auth import require_auth
from pkm.server.backlinks import group_backlinks
from pkm.server.daily import date_for_title, title_for_date
from pkm.server.db import get_db
from pkm.server.fts import phrase_query
from pkm.server.tree import build_tree, collect_block_ref_uids

router = APIRouter(dependencies=[Depends(require_auth)])

_BLOCK_COLS = ("uid, parent_uid, order_idx, text, heading, collapsed,"
               " created_at, updated_at")


def _fetch_page(db: sqlite3.Connection, title: str) -> sqlite3.Row | None:
    return db.execute(
        "SELECT id, title, created_at, updated_at FROM pages WHERE title = ?",
        (title,)).fetchone()


def _block_ref_texts(db: sqlite3.Connection, texts: list[str]) -> dict:
    uids = collect_block_ref_uids(texts)
    if not uids:
        return {}
    marks = ",".join("?" * len(uids))
    rows = db.execute(
        f"SELECT b.uid, b.text, p.title AS page_title FROM blocks b"
        f" JOIN pages p ON p.id = b.page_id WHERE b.uid IN ({marks})",
        uids).fetchall()
    return {r["uid"]: {"text": r["text"], "page_title": r["page_title"]}
            for r in rows}


def _fetch_ancestors(db: sqlite3.Connection, uids: list[str]) -> dict[str, list[str]]:
    if not uids:
        return {}
    marks = ",".join("?" * len(uids))
    rows = db.execute(
        f"""WITH RECURSIVE anc(start_uid, uid, parent_uid, text, depth) AS (
              SELECT uid, uid, parent_uid, text, 0 FROM blocks
               WHERE uid IN ({marks})
              UNION ALL
              SELECT a.start_uid, b.uid, b.parent_uid, b.text, a.depth + 1
                FROM anc a JOIN blocks b ON b.uid = a.parent_uid
            )
            SELECT start_uid, text, depth FROM anc WHERE depth > 0
             ORDER BY start_uid, depth DESC""", uids).fetchall()
    out: dict[str, list[str]] = {}
    for r in rows:  # depth DESC = root first
        out.setdefault(r["start_uid"], []).append(r["text"])
    return out


def _backlinks(db: sqlite3.Connection, page_id: int,
               offset: int, limit: int) -> tuple[list[dict], int, list[str]]:
    total = db.execute(
        """SELECT count(DISTINCT b.page_id) FROM refs r
            JOIN blocks b ON b.uid = r.src_block_uid
           WHERE r.target_page_id = ?""", (page_id,)).fetchone()[0]
    page_ids = [r[0] for r in db.execute(
        """SELECT DISTINCT b.page_id FROM refs r
            JOIN blocks b ON b.uid = r.src_block_uid
            JOIN pages p ON p.id = b.page_id
           WHERE r.target_page_id = ?
           ORDER BY p.updated_at DESC NULLS LAST, p.title
           LIMIT ? OFFSET ?""", (page_id, limit, offset)).fetchall()]
    if not page_ids:
        return [], total, []
    marks = ",".join("?" * len(page_ids))
    rows = db.execute(
        f"""SELECT b.uid, b.text, p.id AS src_page_id, p.title AS src_page_title
              FROM refs r
              JOIN blocks b ON b.uid = r.src_block_uid
              JOIN pages p ON p.id = b.page_id
             WHERE r.target_page_id = ? AND b.page_id IN ({marks})
             ORDER BY p.updated_at DESC NULLS LAST, p.title, b.uid""",
        [page_id, *page_ids]).fetchall()
    ancestors = _fetch_ancestors(db, [r["uid"] for r in rows])
    return (group_backlinks(rows, ancestors), total,
            [r["text"] for r in rows])


@router.get("/api/page/{title:path}")
def get_page(title: str, bl_offset: int = 0, bl_limit: int = 20,
             db: sqlite3.Connection = Depends(get_db)) -> dict:
    bl_limit = max(1, min(bl_limit, 100))
    page = _fetch_page(db, title)
    if page is None:
        if date_for_title(title) is None:
            raise HTTPException(status_code=404, detail="page not found")
        now = int(time.time() * 1000)
        db.execute(
            "INSERT INTO pages(title, created_at, updated_at) VALUES (?,?,?)",
            (title, now, now))
        db.commit()
        page = _fetch_page(db, title)
    blocks = db.execute(
        f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
        (page["id"],)).fetchall()
    groups, total, bl_texts = _backlinks(db, page["id"], bl_offset, bl_limit)
    return {
        "page": dict(page),
        "blocks": build_tree(blocks),
        "backlinks": {"groups": groups, "total_pages": total,
                      "offset": bl_offset, "limit": bl_limit},
        "block_ref_texts": _block_ref_texts(
            db, [r["text"] for r in blocks] + bl_texts),
    }


@router.get("/api/unlinked")
def get_unlinked(title: str, limit: int = 20, offset: int = 0,
                 db: sqlite3.Connection = Depends(get_db)) -> dict:
    limit = max(1, min(limit, 100))
    page = _fetch_page(db, title)
    if page is None:
        raise HTTPException(status_code=404, detail="page not found")
    where = """FROM blocks_fts f
               JOIN blocks b ON b.rowid = f.rowid
               JOIN pages p ON p.id = b.page_id
              WHERE blocks_fts MATCH ? AND b.page_id != ?
                AND NOT EXISTS (SELECT 1 FROM refs r
                                 WHERE r.src_block_uid = b.uid
                                   AND r.target_page_id = ?)"""
    params = (phrase_query(title), page["id"], page["id"])
    total = db.execute(f"SELECT count(*) {where}", params).fetchone()[0]
    rows = db.execute(
        f"""SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title
            {where} ORDER BY p.title, b.uid LIMIT ? OFFSET ?""",
        (*params, limit, offset)).fetchall()
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


@router.get("/api/journal")
def get_journal(before: str | None = None, days: int = 7,
                db: sqlite3.Connection = Depends(get_db)) -> dict:
    days = max(1, min(days, 31))
    start = (date.fromisoformat(before) if before
             else date.today() + timedelta(days=1))
    out = []
    for i in range(1, days + 1):
        d = start - timedelta(days=i)
        title = title_for_date(d)
        page = _fetch_page(db, title)
        if page is None and d == date.today():
            now = int(time.time() * 1000)
            db.execute(
                "INSERT INTO pages(title, created_at, updated_at) VALUES (?,?,?)",
                (title, now, now))
            db.commit()
            page = _fetch_page(db, title)
        if page is None:
            out.append({"date": d.isoformat(), "title": title,
                        "exists": False, "blocks": []})
        else:
            blocks = db.execute(
                f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
                (page["id"],)).fetchall()
            out.append({"date": d.isoformat(), "title": title,
                        "exists": True, "blocks": build_tree(blocks)})
    return {"days": out}
