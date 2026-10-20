# pattern: Imperative Shell
"""Sidebar-entries routes: list, add, remove, and reorder."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field
from pkm.contracts.strict import StrictModel

from pkm.contracts.ops import SidebarEntryId
from pkm.contracts.responses import OkAck, SidebarNavEntry, SidebarNavPayload
from pkm.contracts.titles import RawTitle
from pkm.database import Db
from pkm.importer.sidebar_rows import next_order_idx, reorder_is_valid
from pkm.refs import is_blank_title
from pkm.server import notify
from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.store import insert_sidebar_entry
from pkm.server.sync_meta import read_title

router = APIRouter(dependencies=[Depends(require_auth)])


class AddSidebarEntryRequest(StrictModel):
    title: RawTitle = Field(min_length=1)


class ReorderSidebarEntriesRequest(StrictModel):
    order: list[SidebarEntryId]


@router.get("/api/sidebar", response_model=SidebarNavPayload)
def get_sidebar(db: Db = Depends(get_db)) -> SidebarNavPayload:
    rows = db.select(
        "SELECT id AS sidebar_entry_id, title FROM sidebar_entries"
        " ORDER BY order_idx")
    return SidebarNavPayload(entries=[
        SidebarNavEntry(id=r["sidebar_entry_id"], title=r["title"])
        for r in rows])


@router.post("/api/sidebar", response_model=SidebarNavEntry)
def add_sidebar_entry(request: Request, body: AddSidebarEntryRequest,
                      db: Db = Depends(get_db)) -> SidebarNavEntry:
    canonical_title = read_title(db, body.title)
    if is_blank_title(canonical_title):
        raise HTTPException(status_code=422, detail="title must not be blank")
    db.begin_immediate()
    existing = db.select(
        "SELECT title, order_idx AS sidebar_order_idx FROM sidebar_entries")
    if any(r["title"] == canonical_title for r in existing):
        db.rollback()
        raise HTTPException(status_code=409, detail="entry already exists")
    order_idx = next_order_idx([r["sidebar_order_idx"] for r in existing])
    try:
        entry_id = insert_sidebar_entry(db, canonical_title, order_idx)
    except sqlite3.IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="entry already exists") from None
    notify.commit_and_nudge_threadpool(request, db)
    return SidebarNavEntry(id=entry_id, title=canonical_title)


@router.delete("/api/sidebar/{entry_id}", response_model=OkAck)
def delete_sidebar_entry(request: Request, entry_id: SidebarEntryId,
                         db: Db = Depends(get_db)) -> OkAck:
    cur = db.execute("DELETE FROM sidebar_entries WHERE id = ?", (entry_id,))
    if cur.rowcount == 0:
        db.rollback()
        raise HTTPException(status_code=404, detail="entry not found")
    notify.commit_and_nudge_threadpool(request, db)
    return OkAck(ok=True)


@router.put("/api/sidebar", response_model=OkAck)
def reorder_sidebar_entries(request: Request, body: ReorderSidebarEntriesRequest,
                            db: Db = Depends(get_db)) -> OkAck:
    existing_ids = {r["sidebar_entry_id"] for r in db.select(
        "SELECT id AS sidebar_entry_id FROM sidebar_entries")}
    if not reorder_is_valid(existing_ids, body.order):
        raise HTTPException(
            status_code=400,
            detail="order must list every existing entry id exactly once")
    db.executemany(
        "UPDATE sidebar_entries SET order_idx = ? WHERE id = ?",
        [(idx, entry_id) for idx, entry_id in enumerate(body.order)])
    notify.commit_and_nudge_threadpool(request, db)
    return OkAck(ok=True)
