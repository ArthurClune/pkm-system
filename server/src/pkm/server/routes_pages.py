# pattern: Imperative Shell
"""Page read routes: page tree, block-ref resolution (backlinks: Task 5)."""
from __future__ import annotations

import sqlite3
import time
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from pkm.server.auth import require_auth
from pkm.server.backlinks import group_backlinks
from pkm.server.daily import date_for_title, title_for_date
from pkm.server.db import get_db
from pkm.server.fts import phrase_query
from pkm.server.response_models import (
    GroupsPayload, JournalPayload, PageMeta, PagePayload)
from pkm.server.store import fetch_page, get_or_create_page
from pkm.server.tree import build_tree, collect_block_ref_uids

router = APIRouter(dependencies=[Depends(require_auth)])

_BLOCK_COLS = ("uid, parent_uid, order_idx, text, heading, collapsed,"
               " created_at, updated_at")


class CreatePageRequest(BaseModel):
    title: str = Field(min_length=1)


def _block_ref_texts(db: sqlite3.Connection, texts: list[str]) -> dict:
    """Resolve ((refs)) transitively: a referenced block's text may itself
    contain ((refs)) the client renders nested, so follow the chain. The
    seen set makes cycles (and repeated missing uids) terminate."""
    out: dict = {}
    seen: set[str] = set()
    pending = collect_block_ref_uids(texts)
    while True:
        new = [u for u in pending if u not in seen]
        if not new:
            return out
        seen.update(new)
        marks = ",".join("?" * len(new))
        rows = db.execute(
            f"SELECT b.uid, b.text, p.title AS page_title FROM blocks b"
            f" JOIN pages p ON p.id = b.page_id WHERE b.uid IN ({marks})",
            new).fetchall()
        for r in rows:
            out[r["uid"]] = {"text": r["text"], "page_title": r["page_title"]}
        pending = collect_block_ref_uids([r["text"] for r in rows])


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
               WHERE a.depth < 100
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


@router.get("/api/page/{title:path}", response_model=PagePayload)
def get_page(title: str, bl_offset: int = 0, bl_limit: int = 20,
             db: sqlite3.Connection = Depends(get_db)) -> dict:
    bl_limit = max(1, min(bl_limit, 100))
    page = fetch_page(db, title)
    if page is None:
        if date_for_title(title) is None:
            raise HTTPException(status_code=404, detail="page not found")
        page = get_or_create_page(db, title, int(time.time() * 1000))
        db.commit()
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


@router.post("/api/pages", response_model=PageMeta)
def create_page(body: CreatePageRequest,
                db: sqlite3.Connection = Depends(get_db)) -> dict:
    """Idempotent: creating an existing page returns its row, not an error."""
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="title must not be blank")
    page = get_or_create_page(db, title, int(time.time() * 1000))
    db.commit()
    return dict(page)


@router.delete("/api/page/{title:path}")
def delete_page(title: str, db: sqlite3.Connection = Depends(get_db)) -> dict:
    """Deletes the page, its blocks, and any sidebar entry for it. Inbound
    [[links]] from other pages' block text are left as-is -- only the refs
    rows pointing at this page disappear (via target_page_id CASCADE).

    Blocks are deleted explicitly (not left to the pages FK cascade) so the
    blocks_fts_ad trigger fires for every row -- a direct DELETE guarantees
    that; relying on cascade-triggered deletes to fire triggers is not safe."""
    page = fetch_page(db, title)
    if page is None:
        raise HTTPException(status_code=404, detail="page not found")
    db.execute("DELETE FROM blocks WHERE page_id = ?", (page["id"],))
    db.execute("DELETE FROM pages WHERE id = ?", (page["id"],))
    db.execute("DELETE FROM sidebar_entries WHERE title = ?", (title,))
    db.commit()
    return {"ok": True}


@router.get("/api/unlinked", response_model=GroupsPayload)
def get_unlinked(title: str, limit: int = 20, offset: int = 0,
                 db: sqlite3.Connection = Depends(get_db)) -> dict:
    limit = max(1, min(limit, 100))
    page = fetch_page(db, title)
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


@router.get("/api/journal", response_model=JournalPayload)
def get_journal(before: str | None = None, days: int = 7,
                db: sqlite3.Connection = Depends(get_db)) -> dict:
    days = max(1, min(days, 31))
    if before:
        try:
            start = date.fromisoformat(before)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid before date")
    else:
        start = date.today() + timedelta(days=1)
    out = []
    texts: list[str] = []
    for i in range(1, days + 1):
        d = start - timedelta(days=i)
        title = title_for_date(d)
        page = fetch_page(db, title)
        if page is None and d == date.today():
            page = get_or_create_page(db, title, int(time.time() * 1000))
            db.commit()
        if page is None:
            out.append({"date": d.isoformat(), "title": title,
                        "exists": False, "blocks": []})
        else:
            blocks = db.execute(
                f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
                (page["id"],)).fetchall()
            texts.extend(r["text"] for r in blocks)
            out.append({"date": d.isoformat(), "title": title,
                        "exists": True, "blocks": build_tree(blocks)})
    return {"days": out, "block_ref_texts": _block_ref_texts(db, texts)}
