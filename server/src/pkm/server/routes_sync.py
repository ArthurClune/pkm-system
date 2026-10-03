# pattern: Imperative Shell
"""Sync-down protocol: windowed changes feed + bootstrap snapshot.

Both endpoints do ALL reads inside one explicit read transaction
(python's sqlite3 runs bare SELECTs in autocommit, where each statement
sees its own snapshot): without BEGIN, a write landing between the
journal scan and the hydration queries could advance the data past the
cursor we return -- reflected in the cursor but missing from the payload.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from pkm.contracts.ops import BatchId
from pkm.contracts.responses import (AppliedBatch, ChangesPayload, EntityKind,
                                        OpsAck, SnapshotPayload, SyncBlock,
                                        SyncPage, SyncRef, SyncSeq,
                                        SyncSidebarEntry, SyncTombstone)
from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.sync_core import (ChangeRow, chunk_ids, dedupe_window,
                                    hydrate_in_order, missing_parent_uids,
                                    tombstone_entities, tombstoned_ids)
from pkm.server.sync_meta import (
    database_generation,
    plain_space_title_canonicalization_active,
)

router = APIRouter(dependencies=[Depends(require_auth)])

MAX_LIMIT = 5000

# The client's pending batch ids, repeated: `?pending=a&pending=b`.
PendingIds = Annotated[list[str] | None, Query(
    description="Batch ids the client still holds as pending. The response's"
                " applied_batches names those this payload already holds.")]

logger = logging.getLogger("pkm.sync")


class ClientDiagnosticsRequest(BaseModel):
    """A replica's self-report, sent before it rebuilds itself."""
    kind: str
    error: str
    report: dict[str, Any]
    client: dict[str, Any]


@router.post("/api/client/diagnostics")
def client_diagnostics(body: ClientDiagnosticsRequest) -> dict:
    """Record a replica's self-report in the server log.

    A browser replica that finds its database corrupt rebuilds itself from a
    snapshot, which destroys the evidence. Before it does, it posts what the
    database said about itself (integrity checks, row counts, cursor) and
    which kind of client it is. The server only logs the body: the access
    log around the line already holds the requests that led up to it.
    Nothing is written to the database, so there is no journal row and no
    nudge.
    """
    logger.warning("client diagnostics %s",
                   json.dumps(body.model_dump(), sort_keys=True))
    return {"ok": True}


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


def _with_parent_closure(db: sqlite3.Connection,
                         block_rows: dict[str, sqlite3.Row]
                         ) -> dict[str, sqlite3.Row]:
    """Extend block_rows with every ancestor block (parent, grandparent,
    ...) not already present, walking the parent_uid chain to a fixpoint
    via chunked queries: a window whose journal rows predate a
    parent-child move can hydrate a block whose parent_uid points at a
    block none of this window's rows created, and a replica applying
    windows under deferred FKs needs that ancestor shipped in the same or
    an earlier window. `queried` tracks every uid ever fetched -- found or
    not -- so a cycle or a dangling parent_uid (an ancestor that no longer
    exists; not a dependency to ship, its own tombstone covers it) can't
    cause re-fetching or an infinite loop. Mutates `block_rows` in place
    and returns that same dict."""
    queried = set(block_rows)
    frontier = missing_parent_uids(
        (row["parent_uid"] for row in block_rows.values()), queried)
    while frontier:
        queried |= frontier
        found = _blocks_by_uid(db, list(frontier))
        block_rows.update(found)
        frontier = missing_parent_uids(
            (row["parent_uid"] for row in found.values()), queried)
    return block_rows


def _block_payloads(db: sqlite3.Connection,
                    uids: list[str]) -> tuple[list[SyncBlock], set[int]]:
    """Hydrate blocks + their refs, plus their transitive parent-block
    closure. Also return every page id a shipped block depends
    on: ref target pages (spec section 1 -- a window boundary can split a
    block+refs from the implicitly-created page it points at) and each
    shipped block's OWN page (a block moved to a brand-new page has the
    same hazard). Fetched via chunked `WHERE uid IN (...)` set queries
    rather than one query per uid -- a legal window/snapshot
    can carry thousands of uids."""
    if not uids:
        return [], set()
    block_rows = _blocks_by_uid(db, uids)
    block_rows = _with_parent_closure(db, block_rows)
    # refs only for uids that still have a block row: a uid whose block
    # was deleted again since has no row here, and the caller ships a
    # tombstone for it when the window holds its delete row -- same as the
    # old per-uid loop skipping the refs query for a missing block.
    refs_by_uid = _refs_by_block(db, list(block_rows))
    by_uid: dict[str, SyncBlock] = {}
    dep_pages: set[int] = set()
    for uid, row in block_rows.items():
        refs = refs_by_uid.get(uid, [])
        dep_pages.update(r.target_page_id for r in refs)
        dep_pages.add(row["page_id"])
        by_uid[uid] = SyncBlock(
            uid=row["uid"], page_id=row["page_id"],
            parent_uid=row["parent_uid"], order_idx=row["order_idx"],
            text=row["text"], heading=row["heading"],
            view_type=row["view_type"],
            collapsed=row["collapsed"], created_at=row["created_at"],
            updated_at=row["updated_at"], refs=refs)
    requested = set(uids)
    added_uids = [uid for uid in block_rows if uid not in requested]
    blocks = (hydrate_in_order(uids, by_uid)
             + hydrate_in_order(added_uids, by_uid))
    return blocks, dep_pages


def _reused_page_dependents(db: sqlite3.Connection,
                            page_ids: list[int]) -> list[str]:
    """Uids of the current blocks on any of `page_ids`, then of the blocks
    with a ref to one of them; deduped, first occurrence kept. A page id
    with no live row has neither (its blocks were deleted with it and the
    refs cascade removed the refs), so this returns nothing for it."""
    uids: list[str] = []
    for chunk in chunk_ids(page_ids):
        marks = ",".join("?" * len(chunk))
        uids.extend(r["uid"] for r in db.execute(
            f"SELECT uid FROM blocks WHERE page_id IN ({marks})"
            " ORDER BY uid", chunk))
    for chunk in chunk_ids(page_ids):
        marks = ",".join("?" * len(chunk))
        uids.extend(r["src_block_uid"] for r in db.execute(
            "SELECT DISTINCT src_block_uid FROM refs"
            f" WHERE target_page_id IN ({marks}) ORDER BY src_block_uid",
            chunk))
    return list(dict.fromkeys(uids))


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


def _applied_batches(db: sqlite3.Connection,
                     pending: list[str] | None) -> list[AppliedBatch]:
    """The `pending` ids that have an applied_batches row, in request order,
    each with its stored ack's seq and skipped ops. The caller runs this inside
    the read transaction that hydrates its payload: routes_ops commits a
    batch's writes and its applied_batches row together, so a row visible here
    is a batch whose effects that payload's rows already show. No ids, no
    query."""
    if not pending:
        return []
    ids = list(dict.fromkeys(pending))
    found: dict[str, AppliedBatch] = {}
    for chunk in chunk_ids(ids):
        marks = ",".join("?" * len(chunk))
        for row in db.execute(
                "SELECT batch_id, response FROM applied_batches"
                f" WHERE batch_id IN ({marks})", chunk):
            ack = OpsAck.model_validate(json.loads(row["response"]))
            found[row["batch_id"]] = AppliedBatch(
                batch_id=BatchId(row["batch_id"]), seq=ack.seq,
                skipped=ack.skipped)
    return hydrate_in_order(ids, found)


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
                 pending: PendingIds = None,
                 db: sqlite3.Connection = Depends(get_db)) -> ChangesPayload:
    """One window of the change journal after `since`, hydrated to current
    rows, plus which of the `pending` batch ids that window already holds."""
    limit = max(1, min(limit, MAX_LIMIT))
    db.execute("BEGIN")  # one consistent read snapshot for scan + hydration
    try:
        generation = database_generation(db)
        plain_space_active = plain_space_title_canonicalization_active(db)
        latest = SyncSeq(db.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0])
        if since > latest:
            # cursor from a different/rebuilt database (importer swap):
            # the client must re-bootstrap from the snapshot
            return ChangesPayload(
                reset=True,
                generation=generation,
                plain_space_title_canonicalization=plain_space_active,
                next_since=0,
                latest_seq=latest,
                pages=[],
                blocks=[],
                sidebar=[],
                tombstones=[],
            )
        rows = db.execute(
            "SELECT seq, kind, entity_id, deleted FROM changes WHERE seq > ?"
            " ORDER BY seq LIMIT ?", (since, limit)).fetchall()
        win = dedupe_window([
            ChangeRow(seq=SyncSeq(r["seq"]), kind=r["kind"],
                     entity_id=r["entity_id"], deleted=r["deleted"])
            for r in rows])
        block_uids = [e for k, e in win.entities if k == "block"]
        page_ids = {int(e) for k, e in win.entities if k == "page"}
        sidebar_ids = [int(e) for k, e in win.entities if k == "sidebar"]

        deleted_pages = [int(e) for e in tombstoned_ids(win, "page")]
        pages_by_id: dict[int, SyncPage] = {}
        if deleted_pages:
            # The window's own page rows are fetched first only when it holds
            # a page delete, to tell a reused id (delete row, live row now)
            # from a page that is simply gone.
            pages_by_id = {p.id: p for p in _page_payloads(db, page_ids)}
            reused_pages = [p for p in deleted_pages if p in pages_by_id]
            if reused_pages:
                # A page shipped as both tombstone and live row carries every
                # current block on it or referencing it: the replica applies
                # page tombstones first, and the page's cascade removes those
                # rows before the upserts. Shipping them here makes the page
                # whole again by the window's COMMIT, not only once the
                # blocks' own later journal rows arrive.
                listed = set(block_uids)
                block_uids += [
                    u for u in _reused_page_dependents(db, reused_pages)
                    if u not in listed]

        blocks, dep_pages = _block_payloads(db, block_uids)
        # page ids already queried above are not asked for again, found or not
        still_wanted = (dep_pages - page_ids) if deleted_pages \
            else (page_ids | dep_pages)
        pages_by_id.update(
            (p.id, p) for p in _page_payloads(db, still_wanted))
        pages = [pages_by_id[i] for i in sorted(pages_by_id)]
        sidebar = _sidebar_payloads(db, sidebar_ids)

        # a reused page or sidebar id ships as a tombstone AND a live row
        present: dict[EntityKind, set[str]] = {
            "block": {b.uid for b in blocks},
            "page": {str(p.id) for p in pages},
            "sidebar": {str(s.id) for s in sidebar}}
        tombstones = [SyncTombstone(kind=k, entity_id=e)
                      for k, e in tombstone_entities(win, present)]
        return ChangesPayload(
            generation=generation,
            plain_space_title_canonicalization=plain_space_active,
            next_since=win.next_since if rows else SyncSeq(since),
            latest_seq=latest, pages=pages, blocks=blocks, sidebar=sidebar,
            tombstones=tombstones,
            applied_batches=_applied_batches(db, pending))
    finally:
        db.rollback()  # end the read transaction; nothing was written


@router.get("/api/sync/snapshot", response_model=SnapshotPayload)
def sync_snapshot(pending: PendingIds = None,
                  db: sqlite3.Connection = Depends(get_db)
                  ) -> SnapshotPayload:
    """The whole graph at one journal seq, plus which of the `pending` batch
    ids it already holds."""
    db.execute("BEGIN")
    try:
        seq = SyncSeq(db.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0])
        uids = [r["uid"] for r in db.execute("SELECT uid FROM blocks")]
        blocks, _ = _block_payloads(db, uids)
        pages = [SyncPage(**dict(r)) for r in db.execute(
            "SELECT id, title, created_at, updated_at FROM pages")]
        sidebar = [SyncSidebarEntry(**dict(r)) for r in db.execute(
            "SELECT id, title, order_idx FROM sidebar_entries")]
        return SnapshotPayload(
            generation=database_generation(db),
            plain_space_title_canonicalization=(
                plain_space_title_canonicalization_active(db)
            ),
            seq=seq,
            pages=pages,
            blocks=blocks,
            sidebar=sidebar,
            applied_batches=_applied_batches(db, pending),
        )
    finally:
        db.rollback()
