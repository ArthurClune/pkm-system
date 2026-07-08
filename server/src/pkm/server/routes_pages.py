# pattern: Imperative Shell
"""Page read routes: page tree, block-ref resolution (backlinks: Task 5)."""
from __future__ import annotations

import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException

from pkm.server.auth import require_auth
from pkm.server.daily import date_for_title
from pkm.server.db import get_db
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


@router.get("/api/page/{title:path}")
def get_page(title: str, db: sqlite3.Connection = Depends(get_db)) -> dict:
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
    return {
        "page": dict(page),
        "blocks": build_tree(blocks),
        "block_ref_texts": _block_ref_texts(db, [r["text"] for r in blocks]),
    }
