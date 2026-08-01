# pattern: Imperative Shell
"""Sync-down protocol: windowed changes feed + bootstrap snapshot.

Both endpoints do ALL reads inside one explicit read transaction
(python's sqlite3 runs bare SELECTs in autocommit, where each statement
sees its own snapshot): without BEGIN, a write landing between the
journal scan and the hydration queries could advance the data past the
cursor we return -- reflected in the cursor but missing from the payload.
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from pkm.contracts.responses import (ChangesPayload, SnapshotPayload,
                                        SyncBlock, SyncPage, SyncRef,
                                        SyncSidebarEntry, SyncTombstone)
from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.sync_core import chunk_ids, dedupe_window, hydrate_in_order

router = APIRouter(dependencies=[Depends(require_auth)])

MAX_LIMIT = 5000


def _generation(db: sqlite3.Connection) -> str:
    """The database's generation token (pkm-o9o5). init_db() mints it at
    process startup, so it always exists by the time a request runs."""
    row = db.execute(
        "SELECT value FROM sync_meta WHERE key = 'db_generation'").fetchone()
    return row["value"] if row is not None else ""


def _blocks_by_uid(db: sqlite3.Connection,
                   uids: list[str]) -> dict[str, sqlite3.Row]:
    out: dict[str, sqlite3.Row] = {}
    for chunk in chunk_ids(uids):
        marks = ",".join("?" * len(chunk))
        for row in db.execute(
                "SELECT uid, page_id, parent_uid, order_idx, text, heading,"
                " collapsed, created_at, updated_at, view_type"
                f" FROM blocks WHERE uid IN ({marks})", chunk):
            out[row["uid"]] = row
    return out


def _refs_by_block(db: sqlite3.Connection,
                   uids: list[str]) -> dict[str, list[SyncRef]]:
    out: dict[str, list[SyncRef]] = {}
    for chunk in chunk_ids(uids):
        marks = ",".join("?" * len(chunk))
        # refs is WITHOUT ROWID, keyed on (src_block_uid, target_page_id,
        # kind) -- ordering by the trailing key columns keeps each uid's
        # ref list in the same order the old single-uid query returned
        # (that query had no ORDER BY either, but a WITHOUT ROWID table's
        # scan is a btree walk in primary-key order already).
        for row in db.execute(
                "SELECT src_block_uid, target_page_id, kind FROM refs"
                f" WHERE src_block_uid IN ({marks})"
                " ORDER BY src_block_uid, target_page_id, kind", chunk):
            out.setdefault(row["src_block_uid"], []).append(
                SyncRef(target_page_id=row["target_page_id"],
                        kind=row["kind"]))
    return out


def _block_payloads(db: sqlite3.Connection,
                    uids: list[str]) -> tuple[list[SyncBlock], set[int]]:
    """Hydrate blocks + their refs; also return every page id referenced
    by those refs (dependency pages -- spec section 1: a window boundary
    can split a block+refs from the implicitly-created page it points at,
    so referenced pages ship with the block). Fetched via chunked
    `WHERE uid IN (...)` set queries rather than one query per uid
    (pkm-ldqx) -- a legal window/snapshot can carry thousands of uids."""
    if not uids:
        return [], set()
    block_rows = _blocks_by_uid(db, uids)
    # refs only for uids that still have a block row: a uid whose block
    # was deleted again since has no row here, and the caller turns its
    # absence into a tombstone -- same as the old per-uid loop skipping
    # the refs query for a missing block.
    refs_by_uid = _refs_by_block(db, list(block_rows))
    by_uid: dict[str, SyncBlock] = {}
    dep_pages: set[int] = set()
    for uid, row in block_rows.items():
        refs = refs_by_uid.get(uid, [])
        dep_pages.update(r.target_page_id for r in refs)
        by_uid[uid] = SyncBlock(
            uid=row["uid"], page_id=row["page_id"],
            parent_uid=row["parent_uid"], order_idx=row["order_idx"],
            text=row["text"], heading=row["heading"],
            view_type=row["view_type"],
            collapsed=row["collapsed"], created_at=row["created_at"],
            updated_at=row["updated_at"], refs=refs)
    return hydrate_in_order(uids, by_uid), dep_pages


def _page_payloads(db: sqlite3.Connection, ids: set[int]) -> list[SyncPage]:
    if not ids:
        return []
    ordered = sorted(ids)
    by_id: dict[int, SyncPage] = {}
    for chunk in chunk_ids(ordered):
        marks = ",".join("?" * len(chunk))
        for row in db.execute(
                "SELECT id, title, created_at, updated_at FROM pages"
                f" WHERE id IN ({marks})", chunk):
            by_id[row["id"]] = SyncPage(**dict(row))
    return hydrate_in_order(ordered, by_id)


def _sidebar_payloads(db: sqlite3.Connection,
                      ids: list[int]) -> list[SyncSidebarEntry]:
    if not ids:
        return []
    by_id: dict[int, SyncSidebarEntry] = {}
    for chunk in chunk_ids(ids):
        marks = ",".join("?" * len(chunk))
        for row in db.execute(
                "SELECT id, title, order_idx FROM sidebar_entries"
                f" WHERE id IN ({marks})", chunk):
            by_id[row["id"]] = SyncSidebarEntry(**dict(row))
    return hydrate_in_order(ids, by_id)


@router.get("/api/sync/changes", response_model=ChangesPayload)
def sync_changes(since: int = 0, limit: int = 1000,
                 db: sqlite3.Connection = Depends(get_db)) -> ChangesPayload:
    limit = max(1, min(limit, MAX_LIMIT))
    db.execute("BEGIN")  # one consistent read snapshot for scan + hydration
    try:
        generation = _generation(db)
        latest = db.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
        if since > latest:
            # cursor from a different/rebuilt database (importer swap):
            # the client must re-bootstrap from the snapshot
            return ChangesPayload(reset=True, generation=generation,
                                  next_since=0, latest_seq=latest,
                                  pages=[], blocks=[], sidebar=[],
                                  tombstones=[])
        rows = db.execute(
            "SELECT seq, kind, entity_id FROM changes WHERE seq > ?"
            " ORDER BY seq LIMIT ?", (since, limit)).fetchall()
        win = dedupe_window([(r["seq"], r["kind"], r["entity_id"])
                             for r in rows])
        block_uids = [e for k, e in win.entities if k == "block"]
        page_ids = {int(e) for k, e in win.entities if k == "page"}
        sidebar_ids = [int(e) for k, e in win.entities if k == "sidebar"]

        blocks, dep_pages = _block_payloads(db, block_uids)
        pages = _page_payloads(db, page_ids | dep_pages)
        sidebar = _sidebar_payloads(db, sidebar_ids)

        present_blocks = {b.uid for b in blocks}
        present_pages = {p.id for p in pages}
        present_sidebar = {s.id for s in sidebar}
        tombstones = [
            SyncTombstone(kind=k, entity_id=e) for k, e in win.entities
            if (k == "block" and e not in present_blocks)
            or (k == "page" and int(e) not in present_pages)
            or (k == "sidebar" and int(e) not in present_sidebar)]
        return ChangesPayload(
            generation=generation,
            next_since=win.next_since if rows else since,
            latest_seq=latest, pages=pages, blocks=blocks, sidebar=sidebar,
            tombstones=tombstones)
    finally:
        db.rollback()  # end the read transaction; nothing was written


@router.get("/api/sync/snapshot", response_model=SnapshotPayload)
def sync_snapshot(db: sqlite3.Connection = Depends(get_db)
                  ) -> SnapshotPayload:
    db.execute("BEGIN")
    try:
        seq = db.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
        uids = [r["uid"] for r in db.execute("SELECT uid FROM blocks")]
        blocks, _ = _block_payloads(db, uids)
        pages = [SyncPage(**dict(r)) for r in db.execute(
            "SELECT id, title, created_at, updated_at FROM pages")]
        sidebar = [SyncSidebarEntry(**dict(r)) for r in db.execute(
            "SELECT id, title, order_idx FROM sidebar_entries")]
        return SnapshotPayload(generation=_generation(db), seq=seq,
                               pages=pages, blocks=blocks, sidebar=sidebar)
    finally:
        db.rollback()
