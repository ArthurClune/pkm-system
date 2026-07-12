# pattern: Imperative Shell
"""Sidebar-entries routes: list, add, remove, and reorder."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from pkm.importer.sidebar_rows import next_order_idx, reorder_is_valid
from pkm.server import notify
from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.response_models import SidebarNavPayload

router = APIRouter(dependencies=[Depends(require_auth)])


class AddSidebarEntryRequest(BaseModel):
    title: str = Field(min_length=1)


class ReorderSidebarEntriesRequest(BaseModel):
    order: list[int]


@router.get("/api/sidebar", response_model=SidebarNavPayload)
def get_sidebar(db: sqlite3.Connection = Depends(get_db)) -> dict:
    rows = db.execute(
        "SELECT id, title FROM sidebar_entries ORDER BY order_idx").fetchall()
    return {"entries": [dict(r) for r in rows]}


@router.post("/api/sidebar")
def add_sidebar_entry(request: Request, body: AddSidebarEntryRequest,
                      db: sqlite3.Connection = Depends(get_db)) -> dict:
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="title must not be blank")
    existing = db.execute(
        "SELECT title, order_idx FROM sidebar_entries").fetchall()
    if any(r["title"] == title for r in existing):
        raise HTTPException(status_code=409, detail="entry already exists")
    order_idx = next_order_idx([r["order_idx"] for r in existing])
    cur = db.execute(
        "INSERT INTO sidebar_entries(title, order_idx) VALUES (?, ?)",
        (title, order_idx))
    db.commit()
    notify.nudge_threadpool(request, db)
    return {"id": cur.lastrowid, "title": title}


@router.delete("/api/sidebar/{entry_id}")
def delete_sidebar_entry(request: Request, entry_id: int,
                         db: sqlite3.Connection = Depends(get_db)) -> dict:
    cur = db.execute("DELETE FROM sidebar_entries WHERE id = ?", (entry_id,))
    if cur.rowcount == 0:
        db.rollback()
        raise HTTPException(status_code=404, detail="entry not found")
    db.commit()
    notify.nudge_threadpool(request, db)
    return {"ok": True}


@router.put("/api/sidebar")
def reorder_sidebar_entries(request: Request, body: ReorderSidebarEntriesRequest,
                            db: sqlite3.Connection = Depends(get_db)) -> dict:
    existing_ids = {r["id"] for r in
                    db.execute("SELECT id FROM sidebar_entries").fetchall()}
    if not reorder_is_valid(existing_ids, body.order):
        raise HTTPException(
            status_code=400,
            detail="order must list every existing entry id exactly once")
    db.executemany(
        "UPDATE sidebar_entries SET order_idx = ? WHERE id = ?",
        [(idx, entry_id) for idx, entry_id in enumerate(body.order)])
    db.commit()
    notify.nudge_threadpool(request, db)
    return {"ok": True}
