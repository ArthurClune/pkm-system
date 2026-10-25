# pattern: Imperative Shell
"""Page read routes: page tree, block-ref resolution (backlinks: Task 5)."""
from __future__ import annotations

import sqlite3
import time
from collections.abc import Sequence
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field
from pkm.contracts.text import WellFormedModel

from pkm.contracts.daily import date_for_title
from pkm.contracts.ops import BlockUid, PageId
from pkm.contracts.ops import UID_RE as _UID_RE
from pkm.contracts.responses import (
    BacklinkGroup, Backlinks, BlockBacklinksPayload, BlockPayload, BlockRefsPayload, BlockRefText, CurrentWorkPayload,
    CurrentWorkPage, CurrentWorkSection, DeleteBlockerModel, DeletePreview,
    GroupsPayload, JournalCleanupResponse, JournalDay, JournalPayload, OkAck, PageMeta, PagePayload, RenamePageResponse)
from pkm.contracts.titles import RawTitle
from pkm.contracts.int64 import INT64_MIN, Int64
from pkm.database import Db
from pkm.refs import (CanonicalTitle, canonical_daily_title,
                      describe_title_length, is_blank_title, parse_block_uid,
                      title_length_over, title_syntax_reason)
from pkm.rows import Row
from pkm.server import notify
from pkm.server.auth import require_auth
from pkm.server.grouping import group_backlinks, group_by_page
from pkm.server.daily import (is_page_empty, past_week_dates,
                              select_journal_days)
from pkm.server.db import get_db
from pkm.server.fts import phrase_query
from pkm.server.store import (BlankTitleError, DeleteBlockedError,
                              ForbiddenTitleError, delete_page_rows,
                              delete_page_unlinking, fetch_page,
                              get_or_create_page, merge_page_rows,
                              plan_delete, rename_page_rows,
                              RewriteTextLimitError)
from pkm.server.sync_core import chunk_ids
from pkm.server.sync_meta import read_title, title_reader
from pkm.server.tree import (ancestor_texts, build_tree,
                             collect_block_ref_uids, find_node)
from pkm.server import wholepath  # noqa: F401 -- registers {title:wholepath}
from pkm.unlink import DeleteBlocker

router = APIRouter(dependencies=[Depends(require_auth)])

_BLOCK_COLS = ("uid, parent_uid, order_idx, text, heading, collapsed,"
               " created_at, updated_at, view_type")


class CreatePageRequest(WellFormedModel):
    title: RawTitle = Field(min_length=1)


class RenamePageRequest(WellFormedModel):
    new_title: RawTitle = Field(min_length=1)
    allow_merge: bool = False


def _daily_title(d: date) -> CanonicalTitle:
    return canonical_daily_title(d)


def _block_ref_texts(db: Db,
                     texts: list[str]) -> dict[BlockUid, BlockRefText]:
    return _resolve_ref_uids(db, collect_block_ref_uids(texts))


def _block_ref_counts(db: Db,
                      uids: list[BlockUid]) -> dict[BlockUid, int]:
    """Incoming ((ref)) count per uid, nonzero entries only.
    One GROUP BY per chunk against idx_block_refs_target; src rows CASCADE
    with their block, so every counted row has a live source."""
    counts: dict[BlockUid, int] = {}
    for chunk in chunk_ids(list(dict.fromkeys(uids))):
        marks = ",".join("?" * len(chunk))
        counts.update({r["target_block_uid"]: r["n"] for r in db.select(
            f"""SELECT target_block_uid, count(*) AS n FROM block_refs
                 WHERE target_block_uid IN ({marks})
                 GROUP BY target_block_uid""", chunk)})
    return counts


def _resolve_ref_uids(db: Db, uids: Sequence[BlockUid]
                      ) -> dict[BlockUid, BlockRefText]:
    """Resolve ((refs)) transitively: a referenced block's text may itself
    contain ((refs)) the client renders nested, so follow the chain. The
    seen set makes cycles (and repeated missing uids) terminate."""
    out: dict[BlockUid, BlockRefText] = {}
    seen: set[str] = set()
    pending = uids
    while True:
        new = [u for u in pending if u not in seen]
        if not new:
            return out
        seen.update(new)
        rows: list[Row] = []
        for chunk in chunk_ids(list(dict.fromkeys(new))):
            marks = ",".join("?" * len(chunk))
            rows += db.select(
                f"SELECT b.uid, b.text, p.title AS page_title FROM blocks b"
                f" JOIN pages p ON p.id = b.page_id WHERE b.uid IN ({marks})",
                chunk)
        for r in rows:
            out[r["uid"]] = BlockRefText(
                text=r["text"], page_title=r["page_title"])
        pending = collect_block_ref_uids([r["text"] for r in rows])


def _page_meta(page: Row) -> PageMeta:
    return PageMeta(id=page["page_id"], title=page["title"],
                    created_at=page["created_at"],
                    updated_at=page["updated_at"])


def _fetch_ancestors(db: Db, uids: list[BlockUid]
                     ) -> dict[BlockUid, list[str]]:
    """Breadcrumb trails (ancestor texts, root first) for each uid that has
    ancestors. The CTE holds `uid` alone and joins with UNION, which queues
    a row only once, so each distinct ancestor is read once however many
    starts share it, and a corrupt parent cycle ends the walk without a
    depth bound that would cut real deep chains short. It must never carry
    a per-row path string: one row per (start, ancestor), each building
    and searching an O(depth) string, made breadcrumbs cost O(depth^3).
    `ancestor_texts` rebuilds the trails and stops on a repeated uid."""
    starts = list(dict.fromkeys(uids))
    blocks: dict[BlockUid, tuple[BlockUid | None, str]] = {}
    for chunk in chunk_ids(starts):
        marks = ",".join("?" * len(chunk))
        for r in db.select(
                f"""WITH RECURSIVE anc(uid) AS (
                      SELECT uid FROM blocks WHERE uid IN ({marks})
                      UNION
                      SELECT b.parent_uid FROM anc a
                        JOIN blocks b ON b.uid = a.uid
                       WHERE b.parent_uid IS NOT NULL
                    )
                    SELECT b.uid, b.parent_uid, b.text
                      FROM anc JOIN blocks b ON b.uid = anc.uid""", chunk):
            blocks[r["uid"]] = (r["parent_uid"], r["text"])
    return ancestor_texts(starts, blocks)


def _backlinks(db: Db, page_id: PageId,
               offset: int, limit: int) -> tuple[list[BacklinkGroup], int, list[str]]:
    """A page's own blocks are never its linked references, even when they
    reference it (Roam-style `{{[[TODO]]}}` markers on the TODO page do)
    -- the same `b.page_id != ?` rule unlinked references apply.
    The shim's `backlinks()` mirrors these three queries."""
    counted = db.select_one(
        """SELECT count(DISTINCT b.page_id) AS n FROM refs r
            JOIN blocks b ON b.uid = r.src_block_uid
           WHERE r.target_page_id = ? AND b.page_id != ?""",
        (page_id, page_id))
    assert counted is not None  # an aggregate always yields a row
    total = counted["n"]
    page_ids = [r["page_id"] for r in db.select(
        """SELECT DISTINCT b.page_id FROM refs r
            JOIN blocks b ON b.uid = r.src_block_uid
            JOIN pages p ON p.id = b.page_id
           WHERE r.target_page_id = ? AND b.page_id != ?
           ORDER BY p.updated_at DESC NULLS LAST, p.title
           LIMIT ? OFFSET ?""", (page_id, page_id, limit, offset))]
    if not page_ids:
        return [], total, []
    marks = ",".join("?" * len(page_ids))
    rows = db.select(
        f"""SELECT b.uid, b.text, p.id AS src_page_id, p.title AS src_page_title
              FROM refs r
              JOIN blocks b ON b.uid = r.src_block_uid
              JOIN pages p ON p.id = b.page_id
             WHERE r.target_page_id = ? AND b.page_id IN ({marks})
             ORDER BY p.updated_at DESC NULLS LAST, p.title, b.uid""",
        [page_id, *page_ids])
    ancestors = _fetch_ancestors(db, [r["uid"] for r in rows])
    return (group_backlinks(rows, ancestors), total,
            [r["text"] for r in rows])


@router.get("/api/block-refs", response_model=BlockRefsPayload)
def get_block_refs(uids: str,  # brand: untrusted -- comma-separated query
                   db: Db = Depends(get_db)) -> BlockRefsPayload:
    """On-demand ((uid)) resolution for refs pasted after the page payload
    loaded. `uids` is comma-separated; unknown uids are omitted
    (the client renders them unresolved, same as the payload path)."""
    wanted = [u for u in uids.split(",") if u]
    if len(wanted) > 50:
        raise HTTPException(status_code=422, detail="too many uids")
    checked: list[BlockUid] = []
    for uid in wanted:
        parsed = parse_block_uid(uid)
        if parsed is None:
            raise HTTPException(status_code=422,
                                detail=f"malformed uid: {uid!r}")
        checked.append(parsed)
    return BlockRefsPayload(block_ref_texts=_resolve_ref_uids(db, checked))


@router.get("/api/block/{uid}/backlinks", response_model=BlockBacklinksPayload)
def get_block_backlinks(uid: BlockUid,
                        db: Db = Depends(get_db)) -> BlockBacklinksPayload:
    """The ((uid)) badge's popover read: who references this
    block. Same group shape and ordering as page backlinks; the count badge
    itself rides the page/journal payloads (block_ref_counts)."""
    if not _UID_RE.fullmatch(uid):
        raise HTTPException(status_code=422, detail=f"malformed uid: {uid!r}")
    if db.select_one("SELECT uid FROM blocks WHERE uid = ?",
                     (uid,)) is None:
        raise HTTPException(status_code=404, detail="block not found")
    rows = db.select(
        """SELECT b.uid, b.text, p.id AS src_page_id, p.title AS src_page_title
             FROM block_refs r
             JOIN blocks b ON b.uid = r.src_block_uid
             JOIN pages p ON p.id = b.page_id
            WHERE r.target_block_uid = ?
            ORDER BY p.updated_at DESC NULLS LAST, p.title, b.uid""",
        (uid,))
    ancestors = _fetch_ancestors(db, [r["uid"] for r in rows])
    return BlockBacklinksPayload(
        groups=group_backlinks(rows, ancestors))


@router.get("/api/block/{uid}", response_model=BlockPayload)
def get_block(uid: BlockUid, db: Db = Depends(get_db)) -> BlockPayload:
    """One block's subtree plus its page and ancestor texts (the CLI/MCP
    `get <uid>` read; pages remain the only other read unit)."""
    if not _UID_RE.fullmatch(uid):
        raise HTTPException(status_code=422, detail=f"malformed uid: {uid!r}")
    row = db.select_one(
        "SELECT p.id AS page_id, p.title, p.created_at, p.updated_at"
        "  FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.uid = ?",
        (uid,))
    if row is None:
        raise HTTPException(status_code=404, detail="block not found")
    blocks = db.select(
        f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
        (row["page_id"],))
    node = find_node(build_tree(blocks), uid)
    assert node is not None  # the block row exists on this page
    texts = [r["text"] for r in blocks]
    return BlockPayload(
        page=_page_meta(row),
        block=node,
        breadcrumbs=_fetch_ancestors(db, [uid]).get(uid, []),
        block_ref_texts=_block_ref_texts(db, texts),
    )


@router.get("/api/page/{title:wholepath}", response_model=PagePayload)
def get_page(request: Request, title: RawTitle, bl_offset: Int64 = 0, bl_limit: Int64 = 20,
             db: Db = Depends(get_db)) -> PagePayload:
    bl_limit = max(1, min(bl_limit, 100))
    canonical_title = read_title(db, title)
    page = fetch_page(db, canonical_title)
    if page is None:
        # Only TODAY auto-creates on read (journal semantics). Auto-creating
        # any daily title resurrected deleted dailies as zombies and let
        # plain reads mint pages.
        if date_for_title(canonical_title) != date.today():
            raise HTTPException(status_code=404, detail="page not found")
        page = get_or_create_page(db, canonical_title, int(time.time() * 1000))
        notify.commit_and_nudge_threadpool(request, db)
    blocks = db.select(
        f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
        (page["page_id"],))
    groups, total, bl_texts = _backlinks(db, page["page_id"], bl_offset, bl_limit)
    return PagePayload(
        page=_page_meta(page),
        blocks=build_tree(blocks),
        backlinks=Backlinks(groups=groups, total_pages=total,
                            offset=bl_offset, limit=bl_limit),
        block_ref_texts=_block_ref_texts(
            db, [r["text"] for r in blocks] + bl_texts),
        block_ref_counts=_block_ref_counts(
            db, [r["uid"] for r in blocks]),
    )


@router.post("/api/pages", response_model=PageMeta)
def create_page(request: Request, body: CreatePageRequest,
                db: Db = Depends(get_db)) -> PageMeta:
    """Idempotent: creating an existing page returns its row, not an error.
    A title longer than 1,000 characters (`MAX_PAGE_TITLE_CHARS`) is a 422,
    even for a page stored before the cap."""
    # Judged on the title as sent, before the store looks it up: the store
    # refuses only creating a long page, and this route refuses the title.
    measured = title_length_over(body.title)
    if measured is not None:
        raise HTTPException(status_code=422,
                            detail=describe_title_length(measured))
    # get_or_create_page is the shared boundary that defines "blank" (a
    # whitespace-only title normalizes to "" there); this route is
    # interactive, so it turns that into an explicit 422 rather than the
    # ops path's fallback-title recovery (ops_apply.py).
    try:
        page = get_or_create_page(db, body.title, int(time.time() * 1000))
    except BlankTitleError:
        raise HTTPException(status_code=422,
                            detail="title must not be blank") from None
    except ForbiddenTitleError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    notify.commit_and_nudge_threadpool(request, db)
    return _page_meta(page)


def _blocker_models(blockers: Sequence[DeleteBlocker]) -> list[DeleteBlockerModel]:
    return [DeleteBlockerModel.of(b.uid, b.page_title, b.text, b.reason)
            for b in blockers]


@router.get("/api/delete-preview", response_model=DeletePreview)
def delete_preview(title: RawTitle,
                   db: Db = Depends(get_db)) -> DeletePreview:
    """What deleting the page would rewrite: how many [[links]] become plain
    text and ((block refs)) become copies (blocks and distinct pages), and the
    blocks that would make DELETE refuse (a query macro naming the page, or a
    rewrite that would change the leading attribute name, as for
    `[[page]]:: v`, still reference the page, or carry the block over a text
    limit with the copies it inlines). Read-only; 404 when the page
    does not exist. Not under /api/page/ because GET /api/page/{title:wholepath}
    would swallow it."""
    canonical_title = read_title(db, title)
    page = fetch_page(db, canonical_title)
    if page is None:
        raise HTTPException(status_code=404, detail="page not found")
    plan = plan_delete(db, page["page_id"], canonical_title)
    return DeletePreview(
        links=plan.links, link_pages=plan.link_pages,
        block_refs=plan.block_refs, block_ref_pages=plan.block_ref_pages,
        blockers=_blocker_models(plan.blockers))


@router.delete("/api/page/{title:wholepath}", response_model=OkAck)
def delete_page(request: Request, title: RawTitle,
                db: Db = Depends(get_db)) -> OkAck:
    """Deletes the page, its blocks, and any sidebar entry for it. Inbound
    [[links]] and #tags in other pages' blocks become plain
    text, and inbound ((block refs)) are replaced by a copy of the referenced
    text. 409 with the offending blocks when a query macro names the page or
    unlinking would change a block's leading attribute name (`[[page]]:: v`)
    or still leave a reference, since those cannot be rewritten, or when the
    copies inlined would carry a block over the text length cap or nest its
    `[[` past the cap; nothing is changed."""
    # Same ordering rule as rename: the write lock precedes the snapshot of
    # referencing blocks, so no batch can commit between snapshot and rewrite.
    try:
        db.begin_immediate()
    except sqlite3.OperationalError as exc:
        if "locked" not in str(exc):
            raise
        raise HTTPException(status_code=503, headers={"Retry-After": "1"},
                            detail="database busy, retry") from exc
    try:
        canonical_title = read_title(db, title)
        page = fetch_page(db, canonical_title)
        if page is None:
            raise HTTPException(status_code=404, detail="page not found")
        delete_page_unlinking(db, page["page_id"], canonical_title, int(time.time() * 1000))
    except DeleteBlockedError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail={
            "message": "page is still referenced in ways a delete cannot"
                       " rewrite",
            "blockers": [b.model_dump()
                         for b in _blocker_models(exc.blockers)],
        }) from None
    except BaseException:
        db.rollback()
        raise
    notify.commit_and_nudge_threadpool(request, db)
    return OkAck(ok=True)


@router.post("/api/page/{title:wholepath}/rename", response_model=RenamePageResponse)
def rename_page(request: Request, title: RawTitle, body: RenamePageRequest,
                db: Db = Depends(get_db)) -> RenamePageResponse:
    """Rename a page, rewriting every [[link]]/#tag/attr:: in block text.
    When the new title is taken: 409 unless allow_merge is true, in which
    case the source page is concatenated onto the target (source's
    top-level blocks appended after the target's, referencing text
    rewritten to the target, source page row dropped) -- a confirm-gated
    merge, not a silent overwrite. Case-sensitive throughout, like
    pages.title itself. 422 when the new title is blank, refused or longer
    than 1,000 characters, or when the rewrite would carry a block over the
    text length cap or nest its `[[` past the cap (a longer title lengthens
    every link to it); the detail names the block, and nothing changes."""
    # The write lock is taken before the first read the decision rests on
    # (existence, target, the snapshot of referencing blocks), so a batch
    # cannot commit between that snapshot and the rewrite and escape it:
    # it is ordered wholly before or wholly after the rename.
    result: Literal["renamed", "merged"]
    try:
        db.begin_immediate()
    except sqlite3.OperationalError as exc:
        if "locked" not in str(exc):
            raise
        raise HTTPException(status_code=503, headers={"Retry-After": "1"},
                            detail="database busy, retry") from exc
    try:
        canonical = title_reader(db)
        canonical_title = canonical(title)
        # normalized here as well as in get_or_create_page: the merge branch
        # below compares and reports new_title directly, so it has to be the
        # title that actually lands in the row.
        new_title = canonical(body.new_title)
        if is_blank_title(new_title):
            raise HTTPException(status_code=422,
                                detail="title must not be blank")
        # Before the syntax check, whose detail echoes the title.
        measured = title_length_over(body.new_title)
        if measured is not None:
            raise HTTPException(status_code=422,
                                detail=describe_title_length(measured))
        if title_syntax_reason(new_title) is not None:
            raise HTTPException(
                status_code=422,
                detail=f"unsupported page-title syntax: {new_title!r}",
            )
        page = fetch_page(db, canonical_title)
        if page is None:
            raise HTTPException(status_code=404, detail="page not found")
        if new_title == canonical_title:
            raise HTTPException(status_code=400, detail="title is unchanged")
        if date_for_title(canonical_title) is not None:
            raise HTTPException(status_code=400,
                                detail="daily notes cannot be renamed")
        now_ms = int(time.time() * 1000)
        # No IntegrityError branch: with the write lock held no other writer
        # can create new_title after this check, and the helpers retitle
        # sidebar entries without tripping UNIQUE(title).
        target = fetch_page(db, new_title)
        if target is None:
            rename_page_rows(db, page["page_id"], canonical_title, new_title, now_ms,
                             canonical)
            result = "renamed"
        elif not body.allow_merge:
            raise HTTPException(status_code=409,
                                detail=f"page {new_title!r} already exists")
        else:
            merge_page_rows(db, page["page_id"], target["page_id"], canonical_title, new_title,
                            now_ms, canonical)
            result = "merged"
    except RewriteTextLimitError as exc:
        db.rollback()
        raise HTTPException(status_code=422,
                            detail=f"rename refused: {exc}") from None
    except BaseException:
        db.rollback()
        raise
    notify.commit_and_nudge_threadpool(request, db)
    return RenamePageResponse(result=result, title=new_title)


@router.get("/api/unlinked", response_model=GroupsPayload)
def get_unlinked(title: RawTitle, limit: Int64 = 20, offset: Int64 = 0,
                 db: Db = Depends(get_db)) -> GroupsPayload:
    limit = max(1, min(limit, 100))
    canonical_title = read_title(db, title)
    page = fetch_page(db, canonical_title)
    if page is None:
        raise HTTPException(status_code=404, detail="page not found")
    where = """FROM blocks_fts f
               JOIN blocks b ON b.rowid = f.rowid
               JOIN pages p ON p.id = b.page_id
              WHERE blocks_fts MATCH ? AND b.page_id != ?
                AND NOT EXISTS (SELECT 1 FROM refs r
                                 WHERE r.src_block_uid = b.uid
                                   AND r.target_page_id = ?)"""
    params = (phrase_query(canonical_title), page["page_id"], page["page_id"])
    counted = db.select_one(f"SELECT count(*) AS n {where}", params)
    assert counted is not None  # an aggregate always yields a row
    rows = db.select(
        f"""SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title
            {where} ORDER BY p.title, b.uid LIMIT ? OFFSET ?""",
        (*params, limit, offset))
    return GroupsPayload(groups=group_by_page(rows), total=counted["n"])


_HOUR_MS = 60 * 60 * 1000
_CURRENT_WORK_SECTIONS = [
    ("last-24-hours", "Last 24 hours", 0, 24 * _HOUR_MS),
    ("24-to-48-hours", "24–48 hours", 24 * _HOUR_MS, 48 * _HOUR_MS),
    ("48-hours-to-7-days", "48 hours–7 days", 48 * _HOUR_MS, 7 * 24 * _HOUR_MS),
]


@router.get("/api/current-work", response_model=CurrentWorkPayload)
def get_current_work(now_ms: Int64 | None = None,
                     db: Db = Depends(get_db)) -> CurrentWorkPayload:
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    sections: list[CurrentWorkSection] = []
    for section_id, heading, min_age, max_age in _CURRENT_WORK_SECTIONS:
        # `now` is any int64, so the window bounds can leave the range
        # SQLite binds; clamping keeps the comparison's meaning.
        newer_than = max(INT64_MIN, now - max_age)
        older_than = max(INT64_MIN, now - min_age)
        lower_operator = ">=" if max_age == 7 * 24 * _HOUR_MS else ">"
        rows = db.select(
            f"""SELECT id AS page_id, title, updated_at FROM pages
                WHERE updated_at IS NOT NULL
                  AND updated_at {lower_operator} ?
                  AND updated_at <= ?
                ORDER BY updated_at DESC, title""",
            (newer_than, older_than),
        )
        sections.append(CurrentWorkSection(
            id=section_id,
            heading=heading,
            # The query's `updated_at IS NOT NULL` makes the filter a no-op;
            # it narrows the Row's nullable column for the model.
            pages=[CurrentWorkPage(id=r["page_id"], title=r["title"],
                                   updated_at=r["updated_at"])
                   for r in rows if r["updated_at"] is not None],
        ))
    return CurrentWorkPayload(sections=sections)


# Non-empty = any block with non-whitespace text; the trim char set matches
# is_page_empty()'s strip() for ASCII whitespace, and the offline shim runs the
# identical SQL so both engines agree byte-for-byte (offline-editing-design.md
# §7).
_NONEMPTY_DAILY_SQL = (
    "SELECT title FROM pages WHERE EXISTS ("
    " SELECT 1 FROM blocks b WHERE b.page_id = pages.id"
    " AND trim(b.text, char(9)||char(10)||char(13)||char(32)) <> '')")

# A daily page with zero blocks still has something worth surfacing on the
# scroll if another page [[links]] to it ("Remind me on [[July
# 28th, 2026]]" should show under that day even before anyone writes to it
# directly) -- so a daily title with an inbound ref counts as non-empty too.
# Same SQL in the offline shim (offline-editing-design.md §7).
_REFERENCED_DAILY_SQL = (
    "SELECT DISTINCT p.title FROM pages p JOIN refs r ON r.target_page_id = p.id")

# How many referencing pages each journal day carries inline. A scroll full of
# days each listing every referencing page would be noisy; the day's own
# BacklinksSection pages the rest from /api/page on demand. The offline shim
# uses the same number (offline-editing-design.md §7), and the web client reads
# the limit back off the payload rather than hardcoding it.
JOURNAL_BACKLINK_PREVIEW = 5


@router.get("/api/journal", response_model=JournalPayload)
def get_journal(request: Request, before: str | None = None, days: Int64 = 7,
                db: Db = Depends(get_db)) -> JournalPayload:
    """Newest-first batch of non-empty daily pages. The head
    batch (no `before`) starts with today — auto-created so there is a
    page to compose into, even when empty — followed by the most recent
    non-empty days; `before` pages strictly backwards from that date. A
    day with no blocks but an inbound [[link]] from elsewhere counts as
    non-empty too, so a reminder written on another page surfaces under
    the day it points at once that day would otherwise show.
    Empty, unreferenced days are omitted, and a batch shorter than `days`
    tells the client the journal is exhausted.

    Each day carries its own linked-references preview
    (JOURNAL_BACKLINK_PREVIEW pages of them), so a scroll of N days is N/batch
    requests rather than one page read per day."""
    days = max(1, min(days, 31))
    cursor: date | None = None
    if before:
        try:
            cursor = date.fromisoformat(before)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid before date")
    today = date.today()
    if cursor is None and fetch_page(db, _daily_title(today)) is None:
        get_or_create_page(db, _daily_title(today), int(time.time() * 1000))
        notify.commit_and_nudge_threadpool(request, db)
    nonempty: set[date] = set()
    for row in db.select(_NONEMPTY_DAILY_SQL):
        d = date_for_title(row["title"])
        if d is not None:
            nonempty.add(d)
    for row in db.select(_REFERENCED_DAILY_SQL):
        d = date_for_title(row["title"])
        if d is not None:
            nonempty.add(d)
    out: list[JournalDay] = []
    texts: list[str] = []
    uids: list[BlockUid] = []
    for d in select_journal_days(nonempty, today, cursor, days):
        page = fetch_page(db, _daily_title(d))
        if page is None:  # pragma: no cover - selected days exist
            continue
        blocks = db.select(
            f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
            (page["page_id"],))
        groups, total, bl_texts = _backlinks(
            db, page["page_id"], 0, JOURNAL_BACKLINK_PREVIEW)
        texts.extend(r["text"] for r in blocks)
        texts.extend(bl_texts)
        uids.extend(r["uid"] for r in blocks)
        out.append(JournalDay(
            date=d.isoformat(), title=page["title"], exists=True,
            blocks=build_tree(blocks),
            backlinks=Backlinks(groups=groups, total_pages=total, offset=0,
                                limit=JOURNAL_BACKLINK_PREVIEW)))
    return JournalPayload(
        days=out, block_ref_texts=_block_ref_texts(db, texts),
        block_ref_counts=_block_ref_counts(db, uids))


def _daily_is_linked(db: Db, page_id: PageId) -> bool:
    """True if a block on another page links, tags or attribute-references
    the page (any `refs` kind), or ((embeds)) one of its blocks."""
    return db.select_one(
        "SELECT 1 AS n FROM refs r JOIN blocks b ON b.uid = r.src_block_uid"
        " WHERE r.target_page_id = ? AND b.page_id != ?"
        " UNION ALL"
        " SELECT 1 AS n FROM block_refs br"
        " JOIN blocks t ON t.uid = br.target_block_uid"
        " JOIN blocks s ON s.uid = br.src_block_uid"
        " WHERE t.page_id = ? AND s.page_id != ? LIMIT 1",
        (page_id, page_id, page_id, page_id)) is not None


@router.post("/api/journal/cleanup", response_model=JournalCleanupResponse)
def cleanup_journal(request: Request,
                    db: Db = Depends(get_db)) -> JournalCleanupResponse:
    """Deletes completely-empty daily pages from the 7 days before today
    (today is spared: the journal auto-creates it for composing). Stateless:
    every call re-checks the whole window, so a page emptied later by block
    moves is caught on the next load. A day with any incoming link is
    spared, never rewritten: a `refs` row of any kind (link, tag, attribute)
    targeting the page, or a ((block ref)) to one of its blocks, from a
    block on another page."""
    # The write lock precedes the emptiness and link checks, so no block
    # created on a day between its check and its delete goes with the page.
    try:
        db.begin_immediate()
    except sqlite3.OperationalError as exc:
        if "locked" not in str(exc):
            raise
        raise HTTPException(status_code=503, headers={"Retry-After": "1"},
                            detail="database busy, retry") from exc
    deleted: list[CanonicalTitle] = []
    try:
        for d in past_week_dates(date.today()):
            title = _daily_title(d)
            page = fetch_page(db, title)
            if page is None:
                continue
            blocks = db.select(
                "SELECT uid, text FROM blocks WHERE page_id = ?",
                (page["page_id"],))
            if not is_page_empty([r["text"] for r in blocks]):
                continue
            if _daily_is_linked(db, page["page_id"]):
                continue
            delete_page_rows(db, page["page_id"], title)
            deleted.append(title)
    except BaseException:
        db.rollback()
        raise
    db.commit()
    # Guarded (unlike most routes' unconditional nudge): this route is
    # called on every journal load (docstring above), so a no-op run is the
    # common case, and only a non-empty `deleted` actually advanced
    # changes.seq (notify.py's invariant) -- nudging every empty run would
    # broadcast a no-op frame to every connected replica on each load.
    if deleted:
        notify.nudge_threadpool(request, db)
    return JournalCleanupResponse(deleted=deleted)
