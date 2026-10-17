# pattern: Imperative Shell
"""Read SQLite into per-kind op contexts and execute planned effects.
Runs inside the caller's transaction; never commits or rolls back."""
from __future__ import annotations

import dataclasses
import secrets
from collections.abc import Collection
from datetime import datetime
from typing import Union

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import (BlockOp, BlockUid, CreateOp, CreatePageOp,
                               DeleteOp, MoveOp, OpBatch, OrderIdx, PageId,
                               SetCollapsedOp, SetHeadingOp, SetViewTypeOp,
                               UpdateTextOp)
from pkm.contracts.responses import SkippedOp
from pkm.database import Db
from pkm.refs import (CanonicalTitle, NormalizedTitle, is_blank_title,
                      normalize_title)
from pkm.rows import Row
from pkm.server.ops_core import (SKIPPED_CONTEXTS, BlockContext, BlockInfo,
                                 BlockRewrite, ConflictLanding, CreateContext,
                                 DeleteBlocks, DeleteConflictContext,
                                 DeleteContext, Effect,
                                 ExistingHeader, FreshHeader, InsertBlock,
                                 JournalBlock, LandedSkipContext, MoveContext,
                                 OpContext, OpError, PageContext,
                                 RecordConflictHeader, RecordRewrite, RewriteStep,
                                 ReindexRefs,
                                 SetCollapsed, SetHeading, SetPageId,
                                 SetParent, SetViewType, ShiftSiblings, Skip,
                                 SkipContext, SkippedContext,
                                 StuckMoveContext, SubtreeRow,
                                 TextConflictContext,
                                 TextEditContext, TouchPage, UpdateText,
                                 classify_skip, classify_text_edit,
                                 delete_diverged,
                                 find_op_title_violation, plan_op,
                                 skip_report, rewrite_effects,
                                 unlink_stale_text)
from pkm.server.store import (BlankTitleError, fetch_page,
                              get_or_create_page, reindex_refs_for_text,
                              stale_titles)
from pkm.server.sync_meta import read_title, title_reader
from pkm.unlink import TitleMatch

# Every op that addresses a block by uid: BlockOp minus create_page.
_AddressedOp = Union[CreateOp, UpdateTextOp, MoveOp, DeleteOp,
                     SetCollapsedOp, SetHeadingOp, SetViewTypeOp]
# Fallback title for an op's page_title that normalizes to "" (e.g. a
# whitespace-only string -- pydantic's min_length=1 lets that through). The
# ops path must never reject a batch over this (an offline client
# replays queued batches, and a rejected one wedges its queue permanently),
# so instead of raising BlankTitleError up to the caller it resolves to this
# fixed, always-valid title -- get_or_create semantics, so repeated blank
# titles all land on the same page rather than minting one each.
UNTITLED_PAGE_TITLE = "Untitled"


def _new_uid() -> BlockUid:
    # 12 chars of [A-Za-z0-9_-]: fits UID_RE. Retry until the first char is
    # alphanumeric so a conflict header/child uid is never unaddressable
    # via a bare CLI argument the same way a client-minted uid could be.
    while True:
        uid = secrets.token_urlsafe(9)
        if uid[0].isalnum():
            return BlockUid(uid)


def _resolve_page(db: Db, title: str,
                  now_ms: int) -> Row:
    """get_or_create_page for op page_title fields: falls back to
    UNTITLED_PAGE_TITLE rather than propagating BlankTitleError (see
    module docstring above)."""
    try:
        return get_or_create_page(db, title, now_ms)
    except BlankTitleError:
        return get_or_create_page(db, UNTITLED_PAGE_TITLE, now_ms)


def _hint_page_exists(db: Db, page_title: str | None) -> bool:
    """Does check 1's page_title hint name a page that exists now?
    Canonicalized the way get_or_create_page looks pages up. A hint whose
    page was renamed or deleted since the client saw it simply doesn't
    exist: block_rewrites can't map it to the new title, being keyed by
    referencing block, with rows only where some block referenced the page."""
    if page_title is None:
        return False
    return fetch_page(db, read_title(db, page_title)) is not None


def _block_info(db: Db, uid: BlockUid) -> BlockInfo | None:
    row = db.select_one(
        "SELECT uid, page_id, parent_uid FROM blocks WHERE uid = ?",
        (uid,))
    if row is None:
        return None
    return BlockInfo(row["uid"], row["page_id"], row["parent_uid"])


def _block_rewrites(db: Db,
                    uid: BlockUid) -> tuple[BlockRewrite, ...]:
    """Every recorded rename/merge/delete rewrite of this block, newest
    first -- the order `ops_core.replay_title_rewrites` walks the chain in."""
    rows = db.select(
        "SELECT base_hash, after_hash, old_title, new_title,"
        " kind AS rewrite_kind FROM block_rewrites WHERE uid = ?"
        " ORDER BY created_at DESC, rowid DESC", (uid,))
    return tuple(BlockRewrite(row["base_hash"], row["after_hash"],
                              row["old_title"], row["new_title"],
                              row["rewrite_kind"])
                 for row in rows)


def _parent_chain(db: Db, uid: BlockUid) -> tuple[BlockUid, ...]:
    """uid and every ancestor above it, root last. Each block has exactly one
    parent, so this is a single path -- but a corrupted DB could already
    contain a cycle, so recursion is guarded by a visited-path check (`path`)
    rather than a depth cap: it stops the instant a uid reappears, however
    deep the real hierarchy runs, instead of silently truncating it. The
    comma-delimited path only works as a membership test because UID_RE
    (ops_core.py) bars commas from ever appearing in a uid."""
    rows = db.select(
        """WITH RECURSIVE chain(uid, parent_uid, path) AS (
              SELECT uid, parent_uid, ',' || uid || ',' FROM blocks
               WHERE uid = ?
              UNION ALL
              SELECT b.uid, b.parent_uid, c.path || b.uid || ','
                FROM chain c JOIN blocks b ON b.uid = c.parent_uid
               WHERE instr(c.path, ',' || b.uid || ',') = 0
            ) SELECT uid FROM chain""", (uid,))
    return tuple(r["uid"] for r in rows)


def _subtree_deepest_first(db: Db,
                           uid: BlockUid) -> tuple[BlockUid, ...]:
    """uid and every descendant, deepest first (children before parents, as
    DeleteBlocks and SetPageId both require). Same visited-path guard as
    _parent_chain: a proper tree can't revisit a uid, so the guard only ever
    fires on already-corrupted data, and otherwise traverses to full depth."""
    rows = db.select(
        """WITH RECURSIVE sub(uid, path, depth) AS (
              SELECT uid, ',' || uid || ',', 0 FROM blocks WHERE uid = ?
              UNION ALL
              SELECT b.uid, s.path || b.uid || ',', s.depth + 1
                FROM sub s JOIN blocks b ON b.parent_uid = s.uid
               WHERE instr(s.path, ',' || b.uid || ',') = 0
            ) SELECT uid FROM sub ORDER BY depth DESC""", (uid,))
    return tuple(r["uid"] for r in rows)


def _subtree_rows(db: Db,
                  uid: BlockUid) -> tuple[SubtreeRow, ...]:
    """uid and every descendant with its parent, position and text, deepest
    first -- what a guarded delete hashes and, on a divergence, copies. The
    same recursive CTE and visited-path guard as _subtree_deepest_first, so
    each row appears once and is reached from uid by construction: the
    walk only ever follows parent -> child links out of rows it already
    holds, and the guard refuses a uid already on the path. Every row
    DeleteBlocks removes is therefore one the copies can reach."""
    rows = db.select(
        """WITH RECURSIVE sub(uid, parent_uid, order_idx, text, path, depth)
            AS (
              SELECT uid, parent_uid, order_idx, text, ',' || uid || ',', 0
                FROM blocks WHERE uid = ?
              UNION ALL
              SELECT b.uid, b.parent_uid, b.order_idx, b.text,
                     s.path || b.uid || ',', s.depth + 1
                FROM sub s JOIN blocks b ON b.parent_uid = s.uid
               WHERE instr(s.path, ',' || b.uid || ',') = 0
            ) SELECT uid, parent_uid, order_idx, text FROM sub
               ORDER BY depth DESC""", (uid,))
    return tuple(SubtreeRow(r["uid"], r["parent_uid"], r["order_idx"],
                            r["text"]) for r in rows)


def _conflict_header(db: Db, target_uid: BlockUid, day: str,
                     daily_page_id: PageId
                     ) -> tuple[BlockUid, OrderIdx] | None:
    """(header_uid, next child order_idx) of today's conflict header for
    target_uid, or None when there is none or the user has deleted it (or
    moved it off the daily page) since it was recorded."""
    row = db.select_one(
        "SELECT h.header_uid FROM conflict_headers h"
        " JOIN blocks b ON b.uid = h.header_uid"
        " WHERE h.target_uid = ? AND h.day = ? AND b.page_id = ?",
        (target_uid, day, daily_page_id))
    if row is None:
        return None
    next_idx = db.select_one(
        "SELECT COALESCE(MAX(order_idx) + 1, 0) AS next_order_idx"
        " FROM blocks WHERE parent_uid = ?", (row["header_uid"],))
    assert next_idx is not None  # an aggregate always yields a row
    return row["header_uid"], next_idx["next_order_idx"]


def _conflict_landing(db: Db, target_uid: BlockUid,
                      now_ms: int,
                      exclude: Collection[str] = ()) -> ConflictLanding:
    """Where text that could not apply to target_uid lands: today's daily
    page, under its existing header for the block or at a fresh top-level
    slot. The day key is the local date (server timezone) of the batch's own
    now_ms, never a fresh clock read, so it agrees with the batch's applied_at.

    An existing header whose uid is in `exclude` is passed over for a fresh
    one: a delete passes the subtree it removes, and a header inside that
    subtree would take the copies down with it. The fresh header is then
    recorded in its place."""
    day = title_for_date(datetime.fromtimestamp(now_ms / 1000).date())
    # title_for_date's fixed format is already canonical under either
    # plain_space setting, the same argument _daily_title makes.
    daily_title = CanonicalTitle(NormalizedTitle(day))
    daily = get_or_create_page(db, day, now_ms)
    daily_page_id = daily["page_id"]
    next_top = db.select_one(
        "SELECT COALESCE(MAX(order_idx) + 1, 0) AS next_order_idx"
        " FROM blocks WHERE page_id = ? AND parent_uid IS NULL",
        (daily_page_id,))
    assert next_top is not None  # an aggregate always yields a row
    idx = next_top["next_order_idx"]
    existing = _conflict_header(db, target_uid, day, daily_page_id)
    if existing is not None and existing[0] in exclude:
        existing = None
    # A fresh header uid is minted only when there's no existing header to
    # append under: minting one anyway would be a uid neither this apply nor
    # any later one ever uses. It is minted before the entry uid.
    header = (FreshHeader(_new_uid(), idx) if existing is None
              else ExistingHeader(*existing))
    return ConflictLanding(daily_page_id=daily_page_id, daily_title=daily_title,
                           entry_uid=_new_uid(), header=header)


def _existing_page_id(db: Db, title: str) -> PageId | None:
    """The page `_resolve_page` would return for title, if it exists
    already; never creates one."""
    canonical = read_title(db, title)
    if is_blank_title(canonical):
        canonical = read_title(db, UNTITLED_PAGE_TITLE)
    page = fetch_page(db, canonical)
    return page["page_id"] if page is not None else None


def _deleted_block_page(db: Db, uid: BlockUid) -> PageId | None:
    """The page a gone block was on, from its latest page-bearing tombstone
    in the journal: its delete row (schema.BLOCKS_CHG_AD_TRIGGER), or a
    diverted create's tombstone. A newest-first scan: the tombstone a skip
    races is recent, and only a uid with none reads the whole journal."""
    row = db.select_one(
        "SELECT page_id AS change_page_id FROM changes WHERE entity_id = ?"
        " AND page_id IS NOT NULL ORDER BY seq DESC LIMIT 1",
        (uid,))
    return row["change_page_id"] if row is not None else None


def _destination_siblings(db: Db, op: _AddressedOp, skip: Skip,
                          parent_exists: bool) -> tuple[BlockUid, ...]:
    """The live blocks of a skipped create's or move's destination sibling
    group, where the client's local apply placed the op (placement.ts),
    when only these journal rows would re-ship them: the orphan move of a
    gone block. The other skipped creates and moves read nothing. A gone
    parent (diverted_create, move_parent_missing) has no live children,
    and a move_cycle's group, the target's children, lies inside the
    subtree its StuckMoveContext journals.

    The group is the children of a live parent_uid, or the top level of
    the page a top-level move's page_title names. With no page_title the
    move targets the block's own page, the one its tombstone in the
    journal recorded (`_deleted_block_page`). A uid with no page-bearing
    tombstone has none."""
    if skip.kind != "orphan_structural" or not isinstance(op, MoveOp):
        return ()
    if op.parent_uid is not None:
        if not parent_exists:
            return ()
        rows = db.select(
            "SELECT uid FROM blocks WHERE parent_uid = ?"
            " ORDER BY order_idx, uid", (op.parent_uid,))
    else:
        page_id = (_existing_page_id(db, op.page_title)
                   if op.page_title is not None
                   else _deleted_block_page(db, op.uid))
        if page_id is None:
            return ()
        rows = db.select(
            "SELECT uid FROM blocks WHERE page_id = ? AND parent_uid IS NULL"
            " ORDER BY order_idx, uid", (page_id,))
    return tuple(r["uid"] for r in rows)


def _diverted_create_page(db: Db,
                          op: CreateOp) -> tuple[bool, PageId | None]:
    """(whether op.page_title names a page now, the page the client placed
    the diverted block on). The client placed it on its parent's page
    (placement.ts), and page_title is the page its outline showed that
    parent on, so an existing page by that title comes first. A title that
    names no page (renamed since, or blank) falls back to the page the
    parent's own delete row recorded; None when neither is known."""
    hint = fetch_page(db, read_title(db, op.page_title))
    if hint is not None:
        return True, hint["page_id"]
    assert op.parent_uid is not None  # a diverted create names its parent
    return False, _deleted_block_page(db, op.parent_uid)


def _skip_context(db: Db, op: _AddressedOp, skip: Skip,
                  block: BlockInfo | None, parent_exists: bool,
                  now_ms: int) -> SkippedContext:
    """Context for an op classify_skip flagged. Resolves no op page_title
    (get_or_create would create a page for an op that isn't applied), and
    pays for today's daily page only when an entry lands."""
    hint_page_exists = False
    ghost_page: PageId | None = None
    if skip.kind == "diverted_create" and isinstance(op, CreateOp):
        hint_page_exists, ghost_page = _diverted_create_page(db, op)
    if skip.landing_uid is None:
        return SkipContext(skip, ghost_page)
    if isinstance(op, UpdateTextOp):
        hint_page_exists = _hint_page_exists(db, op.page_title)
    if skip.kind == "stale_page" and isinstance(op, CreateOp):
        # the header names the deleted page as a code span even when a
        # newer batch has re-created it since
        return LandedSkipContext(
            skip, _conflict_landing(db, skip.landing_uid, now_ms), False,
            _destination_siblings(db, op, skip, parent_exists), ghost_page)
    if skip.kind in ("move_parent_missing", "move_cycle", "stale_page"):
        assert block is not None  # the block exists; its target does not fit
        page_title = _require_page_title(db, block.page_id)
        subtree = _subtree_deepest_first(db, op.uid)
        return StuckMoveContext(
            skip, _conflict_landing(db, skip.landing_uid, now_ms),
            page_title, subtree)
    return LandedSkipContext(
        skip, _conflict_landing(db, skip.landing_uid, now_ms),
        hint_page_exists, _destination_siblings(db, op, skip, parent_exists),
        ghost_page)


def _context_for(db: Db, op: BlockOp, now_ms: int,
                 is_stale: TitleMatch | None = None) -> OpContext:
    """Read what `op` needs, classify it once (classify_skip, then
    classify_text_edit for a hashed edit), and return the context type
    that classification calls for. `is_stale` matches the titles of pages
    deleted after the batch's `seen_seq`; None when there are none."""
    if isinstance(op, CreatePageOp):
        page = _resolve_page(db, op.page_title, now_ms)
        return PageContext(page["page_id"])
    block = _block_info(db, op.uid)
    parent_uid = (op.parent_uid if isinstance(op, (CreateOp, MoveOp))
                  else None)
    parent = _block_info(db, parent_uid) if parent_uid else None
    # a move's target chain: what classify_skip's cycle test reads
    chain = (_parent_chain(db, parent.uid)
             if isinstance(op, MoveOp) and block is not None
             and parent is not None else ())
    # only a top-level create / move places by page_title
    page_stale = (is_stale is not None
                  and isinstance(op, (CreateOp, MoveOp))
                  and op.parent_uid is None and op.page_title is not None
                  and is_stale(op.page_title))
    skip = classify_skip(op, block is not None, parent is not None, chain,
                         page_stale)
    if skip is not None:
        return _skip_context(db, op, skip, block, parent is not None,
                             now_ms)
    if isinstance(op, CreateOp):
        # Under a live parent the block lands on the parent's page, so the
        # op's page_title is never resolved: a title gone stale since
        # another device moved the parent would get_or_create an empty
        # page. It places only a top-level create.
        page_id = (parent.page_id if parent is not None
                   else _resolve_page(db, op.page_title, now_ms)["page_id"])
        return CreateContext(uid_taken=block is not None, page_id=page_id)
    assert block is not None  # classify_skip covered its absence
    if isinstance(op, MoveOp):
        # same rule as create: page_title places only a top-level move
        page_id = (_resolve_page(db, op.page_title, now_ms)["page_id"]
                   if op.page_title is not None and parent is None
                   else None)
        return MoveContext(block, parent, page_id,
                           _subtree_deepest_first(db, op.uid))
    if isinstance(op, DeleteOp):
        if op.base_subtree_hash is None:
            return DeleteContext(block, _subtree_deepest_first(db, op.uid))
        rows = _subtree_rows(db, op.uid)
        if not delete_diverged(op.base_subtree_hash, rows):
            return DeleteContext(block, tuple(r.uid for r in rows))
        # only a divergence pays for today's daily page: the landing mints
        # the header then the root's entry, and each other row's copy uid
        # follows in `rows` order. The copies never land under a header
        # inside the subtree being deleted (a block on today's daily page
        # can hold its own earlier header): that header gets a fresh one.
        landing = _conflict_landing(db, op.uid, now_ms,
                                    exclude={r.uid for r in rows})
        copy_uids = {r.uid: _new_uid() for r in rows if r.uid != op.uid}
        return DeleteConflictContext(
            block, rows, _require_page_title(db, block.page_id), landing,
            copy_uids)
    if isinstance(op, UpdateTextOp) and op.base_text_hash is not None:
        row = db.select_one(
            "SELECT b.text, p.title FROM blocks b"
            " JOIN pages p ON p.id = b.page_id WHERE b.uid = ?",
            (op.uid,))
        assert row is not None  # classify_skip covered the block's absence
        rewrites = _block_rewrites(db, op.uid)
        # only an unlink replay matches titles the way the delete did; the
        # flag read is skipped for edits with no unlink row to replay
        canonical = (title_reader(db)
                     if any(r.kind == "unlink" for r in rewrites)
                     else normalize_title)
        outcome = classify_text_edit(op.text, op.base_text_hash,
                                     row["text"], rewrites, canonical)
        if outcome.kind != "conflict":
            return TextEditContext(block, outcome)
        # only a real conflict pays for today's daily page and its extra
        # queries
        return TextConflictContext(
            block, outcome.text, row["text"], row["title"],
            _conflict_landing(db, op.uid, now_ms), outcome.replayed,
            canonical)
    return BlockContext(block)


def _execute(db: Db, eff: Effect, now_ms: int) -> None:
    if isinstance(eff, ShiftSiblings):
        db.execute(
            "UPDATE blocks SET order_idx = order_idx + 1"
            " WHERE page_id = ? AND parent_uid IS ? AND order_idx >= ?",
            (eff.page_id, eff.parent_uid, eff.from_order_idx))
    elif isinstance(eff, InsertBlock):
        db.execute(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " heading, collapsed, created_at, updated_at, view_type)"
            " VALUES (?,?,?,?,?,?,0,?,?,?)",
            (eff.uid, eff.page_id, eff.parent_uid, eff.order_idx, eff.text,
             eff.heading, now_ms, now_ms, eff.view_type))
    elif isinstance(eff, UpdateText):
        db.execute("UPDATE blocks SET text = ?, updated_at = ? WHERE uid = ?",
                   (eff.text, now_ms, eff.uid))
    elif isinstance(eff, SetParent):
        db.execute(
            "UPDATE blocks SET parent_uid = ?, order_idx = ?, updated_at = ?"
            " WHERE uid = ?",
            (eff.parent_uid, eff.order_idx, now_ms, eff.uid))
    elif isinstance(eff, DeleteBlocks):
        db.executemany("DELETE FROM blocks WHERE uid = ?",
                       [(u,) for u in eff.uids])
    elif isinstance(eff, SetCollapsed):
        # collapse/expand is UI state, not a real change -- no
        # updated_at bump (contrast every other branch here).
        db.execute(
            "UPDATE blocks SET collapsed = ? WHERE uid = ?",
            (int(eff.collapsed), eff.uid))
    elif isinstance(eff, SetHeading):
        db.execute(
            "UPDATE blocks SET heading = ?, updated_at = ? WHERE uid = ?",
            (eff.heading, now_ms, eff.uid))
    elif isinstance(eff, SetViewType):
        db.execute(
            "UPDATE blocks SET view_type = ?, updated_at = ? WHERE uid = ?",
            (eff.view_type, now_ms, eff.uid))
    elif isinstance(eff, ReindexRefs):
        reindex_refs_for_text(db, eff.uid, eff.text, now_ms)
    elif isinstance(eff, TouchPage):
        db.execute("UPDATE pages SET updated_at = ? WHERE id = ?",
                   (now_ms, eff.page_id))
    elif isinstance(eff, SetPageId):
        db.executemany(
            "UPDATE blocks SET page_id = ?, updated_at = ? WHERE uid = ?",
            [(eff.page_id, now_ms, u) for u in eff.uids])
    elif isinstance(eff, RecordConflictHeader):
        db.execute("DELETE FROM conflict_headers WHERE day <> ?", (eff.day,))
        db.execute(
            "INSERT OR REPLACE INTO conflict_headers(target_uid, day,"
            " header_uid) VALUES (?,?,?)",
            (eff.target_uid, eff.day, eff.header_uid))
    elif isinstance(eff, RecordRewrite):
        db.executemany(
            "INSERT INTO block_rewrites(uid, base_hash, after_hash, old_title,"
            " new_title, created_at, kind) VALUES (?,?,?,?,?,?,?)",
            [(eff.uid, r.base_hash, r.after_hash, r.old_title, r.new_title,
              now_ms, r.kind) for r in eff.rewrites])
    elif isinstance(eff, JournalBlock):
        # the same row the blocks triggers write (schema.py SERVER_DDL)
        db.execute(
            "INSERT INTO changes(kind, entity_id, deleted, page_id)"
            " VALUES ('block', ?, ?, ?)",
            (eff.uid, int(eff.deleted), eff.page_id))
    else:
        raise AssertionError(f"unhandled effect: {eff!r}")


def _page_title(db: Db, page_id: PageId) -> CanonicalTitle | None:
    row = db.select_one("SELECT title FROM pages WHERE id = ?",
                        (page_id,))
    return row["title"] if row is not None else None


def _require_page_title(db: Db, page_id: PageId) -> CanonicalTitle:
    title = _page_title(db, page_id)
    if title is None:
        raise AssertionError(
            f"authoritative page title missing after applied op: page_id={page_id}"
        )
    return title


def _broadcast_page_title(db: Db, op: BlockOp,
                          ctx: OpContext) -> str | None:
    if isinstance(ctx, (CreateContext, PageContext)):
        return _require_page_title(db, ctx.page_id)
    if not isinstance(ctx, MoveContext):
        return None
    assert isinstance(op, MoveOp)
    row = db.select_one("SELECT page_id FROM blocks WHERE uid = ?",
                        (op.uid,))
    if row is None:
        raise AssertionError(
            f"applied move block missing before broadcast: uid={op.uid}"
        )
    if op.page_title is None and row["page_id"] == ctx.block.page_id:
        return None
    return _require_page_title(db, row["page_id"])


def _broadcast_op(db: Db, op: BlockOp,
                  ctx: OpContext) -> dict[str, object]:
    """The op as broadcast to remote clients.

    For create/create_page and any move that lands on a different page, the
    broadcast page_title comes from the authoritative stored page row the op
    actually applied to, not from the caller's spelling."""
    d = op.model_dump()
    title = _broadcast_page_title(db, op, ctx)
    if title is not None:
        d["page_title"] = title
    return d


@dataclasses.dataclass(frozen=True)
class AppliedBatch:
    """What apply_batch did: the applied ops as they should be broadcast
    (see _broadcast_op), and one `ops_core.skip_report` per op the shell
    classified as skipped. A skipped op is not echoed as if it were applied; its
    daily-note entry and journal rows reach other clients through the
    feed."""
    broadcast_ops: list[dict[str, object]]
    skipped: list[SkippedOp]


def apply_batch(db: Db, batch: OpBatch,
                now_ms: int) -> AppliedBatch:
    """Apply a batch inside the caller's transaction."""
    violation = find_op_title_violation(batch.ops)
    if violation is not None:
        raise OpError(
            violation.op_index,
            f"unsupported {violation.source} title syntax: {violation.title!r}",
        )
    broadcast_ops: list[dict[str, object]] = []
    skipped: list[SkippedOp] = []
    stale = stale_titles(db, batch.seen_seq)
    is_stale: TitleMatch | None = None
    stale_canonical = title_reader(db) if stale else None
    if stale_canonical is not None:

        def is_stale(raw: str) -> bool:
            return stale_canonical(normalize_title(raw)) in stale
    for index, op in enumerate(batch.ops):
        sent = op
        if is_stale is not None:
            if isinstance(op, CreatePageOp) and is_stale(op.page_title):
                # the replica's local page goes through dropStrandedLocalPages
                continue
            op = unlink_stale_text(op, is_stale)
        ctx = _context_for(db, op, now_ms, is_stale)
        effects = plan_op(index, op, ctx)
        replayed: tuple[RewriteStep, ...] = ()
        replay_canonical = normalize_title
        if isinstance(ctx, TextEditContext):
            replayed = ctx.outcome.replayed
            replay_canonical = ctx.outcome.canonical
        elif isinstance(ctx, TextConflictContext):
            replayed = ctx.replayed
            replay_canonical = ctx.canonical
        if replayed or (is_stale is not None and op is not sent):
            effects += rewrite_effects(
                sent, effects, stale, stale_canonical or replay_canonical,
                replayed,
                ctx.outcome.text if isinstance(ctx, TextEditContext) else None)
        for eff in effects:
            _execute(db, eff, now_ms)
        if isinstance(ctx, SKIPPED_CONTEXTS):
            skipped.append(skip_report(index, op, ctx))
        else:
            broadcast_ops.append(_broadcast_op(db, op, ctx))
    return AppliedBatch(broadcast_ops, skipped)
