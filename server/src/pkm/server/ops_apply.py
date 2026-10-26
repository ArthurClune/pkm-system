# pattern: Imperative Shell
"""Read SQLite into per-kind op contexts and execute planned effects.
Runs inside the caller's transaction; never commits or rolls back."""
from __future__ import annotations

import dataclasses
from collections.abc import Callable, Collection, Mapping, Sequence
from datetime import datetime
from typing import Union

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import (MAX_OUTLINE_DEPTH, BlockOp, BlockUid,
                               CreateOp, CreatePageOp,
                               DeleteOp, ExpectedBlock, MoveOp,
                               PageId, SetCollapsedOp, SetHeadingOp,
                               SetViewTypeOp, Sha256Hex, UpdateTextOp,
                               new_uid, subtree_hash, text_hash)
from pkm.contracts.responses import SkippedOp
from pkm.database import Db
from pkm.contracts.titles import UNTITLED_PAGE_TITLE, RawTitle
from pkm.refs import (CanonicalTitle, canonical_daily_title, is_blank_title,
                      normalize_title)
from pkm.rows import Row
from pkm.server.ops_core import (MAX_BATCH_REPLAY_WORK, ROW_CHARS,
                                 SKIPPED_CONTEXTS,
                                 BlockContext, BlockInfo,
                                 BlockRewrite, ConflictLanding, CreateContext,
                                 DeleteBlocks, DeleteConflictContext,
                                 DeleteContext, Effect,
                                 ExistingHeader, FreshHeader, InsertBlock,
                                 JournalBlock, LandedSkipContext, MoveContext,
                                 JudgedBatch, OpContext, PageContext,
                                 RecordConflictHeader, RecordRewrite,
                                 RewriteHistory, RewriteStep, ReindexRefs,
                                 SetCollapsed, SetHeading, SetPageId,
                                 SetParent, SetViewType, ShiftSiblings, Skip,
                                 SkipContext, SkippedContext,
                                 StepKey, StuckMoveContext,
                                 SubtreeRow,
                                 ReplayOverLimitContext,
                                 TextConflictContext,
                                 TextEditContext, TouchPage, UpdateText,
                                 classify_skip, classify_text_edit,
                                 delete_diverged, plan_op,
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


def _resolve_page(db: Db, title: RawTitle,
                  now_ms: int) -> Row:
    """get_or_create_page for op page_title fields: falls back to
    UNTITLED_PAGE_TITLE rather than propagating BlankTitleError (see
    module docstring above)."""
    try:
        return get_or_create_page(db, title, now_ms)
    except BlankTitleError:
        return get_or_create_page(db, UNTITLED_PAGE_TITLE, now_ms)


def _hint_page(db: Db, page_title: RawTitle | None) -> CanonicalTitle | None:
    """The stored title of the page check 1's page_title hint names now, or
    None. Canonicalized the way get_or_create_page looks pages up. A hint
    whose page was renamed or deleted since the client saw it simply names
    none: block_rewrites can't map it to the new title, being keyed by
    referencing block, with rows only where some block referenced the page."""
    if page_title is None:
        return None
    page = fetch_page(db, read_title(db, page_title))
    return page["title"] if page is not None else None


def _block_info(db: Db, uid: BlockUid) -> BlockInfo | None:
    row = db.select_one(
        "SELECT uid, page_id, parent_uid FROM blocks WHERE uid = ?",
        (uid,))
    if row is None:
        return None
    return BlockInfo(row["uid"], row["page_id"], row["parent_uid"])


def _block_with_depth(db: Db,
                      uid: BlockUid) -> tuple[BlockInfo | None, int]:
    """The block and the level it sits at (1 at top level), in one query;
    (None, 0) when it is gone. The level counts _parent_chain's walk, under
    the same visited-path guard, and comes back as `n`."""
    row = db.select_one(
        """WITH RECURSIVE chain(uid, parent_uid, path) AS (
              SELECT uid, parent_uid, ',' || uid || ',' FROM blocks
               WHERE uid = ?
              UNION ALL
              SELECT b.uid, b.parent_uid, c.path || b.uid || ','
                FROM chain c JOIN blocks b ON b.uid = c.parent_uid
               WHERE instr(c.path, ',' || b.uid || ',') = 0
            ) SELECT b.uid, b.page_id, b.parent_uid,
                     (SELECT COUNT(*) FROM chain) AS n
                FROM blocks b WHERE b.uid = ?""", (uid, uid))
    if row is None:
        return None, 0
    return BlockInfo(row["uid"], row["page_id"], row["parent_uid"]), row["n"]


# The rows a replay reads, newest first: the order
# `ops_core.replay_title_rewrites` walks the chain in. By rowid, which
# the index `idx_block_rewrites_uid` orders a hash's rows by, so no read
# sorts; and a row a batch writes is always newest, as its history keeps
# it (`RewriteHistory.record`), even after the clock steps back.
_REWRITE_COLUMNS = (
    "SELECT base_hash, after_hash, old_title AS rewrite_old_text,"
    " new_title AS rewrite_new_text, kind AS rewrite_kind"
    " FROM block_rewrites")


def _rewrites_of(rows: Sequence[Row]) -> tuple[BlockRewrite, ...]:
    return tuple(BlockRewrite(row["base_hash"], row["after_hash"],
                              row["rewrite_old_text"], row["rewrite_new_text"],
                              row["rewrite_kind"])
                 for row in rows)


def _block_rewrites(db: Db,
                    uid: BlockUid) -> tuple[BlockRewrite, ...]:
    """Every recorded rename/merge/delete rewrite of this block, newest
    first. Only an op planned outside a batch reads them all."""
    return _rewrites_of(db.select(
        f"{_REWRITE_COLUMNS} WHERE uid = ? ORDER BY rowid DESC", (uid,)))


def _rewrites_from(db: Db, uid: BlockUid,
                   base_hash: Sha256Hex) -> tuple[BlockRewrite, ...]:
    """The rows of this block's rewrites from `base_hash`, newest first."""
    return _rewrites_of(db.select(
        f"{_REWRITE_COLUMNS} WHERE uid = ? AND base_hash = ?"
        " ORDER BY rowid DESC", (uid, base_hash)))


def _rewrites_cost(db: Db, uid: BlockUid, base_hash: Sha256Hex,
                   allowance: int) -> int | None:
    """What reading the rows from `base_hash` is charged: each row's titles
    in bytes and `ROW_CHARS`, as writing it is; None past `allowance`. It
    measures at most the rows the allowance could pay for, through the
    index and without loading their titles, so a hash holding millions of
    rows costs what the budget does."""
    sizes = db.select(
        "SELECT octet_length(old_title) + octet_length(new_title) AS n"
        " FROM block_rewrites WHERE uid = ? AND base_hash = ?"
        " ORDER BY rowid DESC LIMIT ?",
        (uid, base_hash, allowance // ROW_CHARS + 1))
    cost = sum(ROW_CHARS + row["n"] for row in sizes)
    return None if cost > allowance else cost


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


def _subtree_with_height(db: Db, uid: BlockUid
                         ) -> tuple[tuple[BlockUid, ...], int]:
    """uid and every descendant, deepest first (children before parents, as
    DeleteBlocks and SetPageId both require), and the subtree's height: how
    many levels its deepest block sits below uid, 0 for a leaf. Same
    visited-path guard as _parent_chain: a proper tree can't revisit a uid,
    so the guard only ever fires on already-corrupted data, and otherwise
    traverses to full depth. Each row's depth comes back as `n`."""
    rows = db.select(
        """WITH RECURSIVE sub(uid, path, depth) AS (
              SELECT uid, ',' || uid || ',', 0 FROM blocks WHERE uid = ?
              UNION ALL
              SELECT b.uid, s.path || b.uid || ',', s.depth + 1
                FROM sub s JOIN blocks b ON b.parent_uid = s.uid
               WHERE instr(s.path, ',' || b.uid || ',') = 0
            ) SELECT uid, depth AS n FROM sub ORDER BY depth DESC""", (uid,))
    return tuple(r["uid"] for r in rows), rows[0]["n"] if rows else 0


def _subtree_deepest_first(db: Db,
                           uid: BlockUid) -> tuple[BlockUid, ...]:
    """uid and every descendant, deepest first (_subtree_with_height)."""
    return _subtree_with_height(db, uid)[0]


def subtree_rows(db: Db,
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
                     daily_page_id: PageId) -> ExistingHeader | None:
    """Today's conflict header for target_uid, with the next child order_idx
    under it and its level, or None when there is none or the user has
    deleted it (or moved it off the daily page) since it was recorded. The
    level is _parent_chain's walk counted, under the same visited-path
    guard, in the query that finds the header (`n`)."""
    row = db.select_one(
        """WITH RECURSIVE chain(uid, parent_uid, path, header_uid) AS (
              SELECT b.uid, b.parent_uid, ',' || b.uid || ',', b.uid
                FROM conflict_headers h JOIN blocks b ON b.uid = h.header_uid
               WHERE h.target_uid = ? AND h.day = ? AND b.page_id = ?
              UNION ALL
              SELECT b.uid, b.parent_uid, c.path || b.uid || ',',
                     c.header_uid
                FROM chain c JOIN blocks b ON b.uid = c.parent_uid
               WHERE instr(c.path, ',' || b.uid || ',') = 0
            ) SELECT header_uid, COUNT(*) AS n FROM chain
               GROUP BY header_uid""",
        (target_uid, day, daily_page_id))
    if row is None:
        return None
    next_idx = db.select_one(
        "SELECT COALESCE(MAX(order_idx) + 1, 0) AS next_order_idx"
        " FROM blocks WHERE parent_uid = ?", (row["header_uid"],))
    assert next_idx is not None  # an aggregate always yields a row
    return ExistingHeader(row["header_uid"], next_idx["next_order_idx"],
                          row["n"])


def _conflict_landing(db: Db, target_uid: BlockUid,
                      now_ms: int,
                      exclude: Collection[str] = ()) -> ConflictLanding:
    """Where text that could not apply to target_uid lands: today's daily
    page, under its existing header for the block or at a fresh top-level
    slot. The day key is the local date (server timezone) of the batch's own
    now_ms, never a fresh clock read, so it agrees with the batch's applied_at.

    An existing header whose uid is in `exclude` is passed over for a fresh
    one: a delete passes the subtree it removes, and a header inside that
    subtree would take the copies down with it. So is one at
    MAX_OUTLINE_DEPTH or deeper, whose entry would land past the cap: a
    client can move an emptied header to exactly the cap, and only a
    legacy row sits deeper. The fresh header is then recorded in its
    place."""
    local_day = datetime.fromtimestamp(now_ms / 1000).date()
    day = title_for_date(local_day)
    daily_title = canonical_daily_title(local_day)
    daily = get_or_create_page(db, daily_title, now_ms)
    daily_page_id = daily["page_id"]
    next_top = db.select_one(
        "SELECT COALESCE(MAX(order_idx) + 1, 0) AS next_order_idx"
        " FROM blocks WHERE page_id = ? AND parent_uid IS NULL",
        (daily_page_id,))
    assert next_top is not None  # an aggregate always yields a row
    idx = next_top["next_order_idx"]
    existing = _conflict_header(db, target_uid, day, daily_page_id)
    if existing is not None and (existing.uid in exclude
                                 or existing.level >= MAX_OUTLINE_DEPTH):
        existing = None
    # A fresh header uid is minted only when there's no existing header to
    # append under: minting one anyway would be a uid neither this apply nor
    # any later one ever uses. It is minted before the entry uid.
    header = FreshHeader(new_uid(), idx) if existing is None else existing
    return ConflictLanding(daily_page_id=daily_page_id, daily_title=daily_title,
                           entry_uid=new_uid(), header=header)


def _existing_page_id(db: Db, title: RawTitle) -> PageId | None:
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


def _diverted_create_page(db: Db, op: CreateOp
                          ) -> tuple[CanonicalTitle | None, PageId | None]:
    """(the stored title of the page op.page_title names now, the page the
    client placed the diverted block on). The client placed it on its
    parent's page (placement.ts), and page_title is the page its outline
    showed that parent on, so an existing page by that title comes first.
    A title that names no page (renamed since, or blank) falls back to the
    page the parent's own delete row recorded; None when neither is
    known."""
    hint = fetch_page(db, read_title(db, op.page_title))
    if hint is not None:
        return hint["title"], hint["page_id"]
    assert op.parent_uid is not None  # a diverted create names its parent
    return None, _deleted_block_page(db, op.parent_uid)


def _skip_context(db: Db, op: _AddressedOp, skip: Skip,
                  block: BlockInfo | None, parent_exists: bool,
                  now_ms: int) -> SkippedContext:
    """Context for an op classify_skip flagged. Resolves no op page_title
    (get_or_create would create a page for an op that isn't applied), and
    pays for today's daily page only when an entry lands."""
    hint_page: CanonicalTitle | None = None
    ghost_page: PageId | None = None
    if skip.kind == "diverted_create" and isinstance(op, CreateOp):
        hint_page, ghost_page = _diverted_create_page(db, op)
    if skip.landing_uid is None:
        return SkipContext(skip, ghost_page)
    if isinstance(op, UpdateTextOp):
        hint_page = _hint_page(db, op.page_title)
    if skip.kind == "stale_page" and isinstance(op, CreateOp):
        # the header names the deleted page as a code span even when a
        # newer batch has re-created it since
        return LandedSkipContext(
            skip, _conflict_landing(db, skip.landing_uid, now_ms), None,
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
        hint_page, _destination_siblings(db, op, skip, parent_exists),
        ghost_page)


@dataclasses.dataclass
class BatchReplay:
    """What one batch's hashed edits share as it applies:
    - `allowance`, what its replays may still spend
      (`ops_core.MAX_BATCH_REPLAY_WORK`), the rows they read included;
    - `reader`, its one title canonicalisation, the stale titles' when it
      has them, else read on first use. One function for the whole batch,
      so what a step derives under it (`ops_core.StepTitles`) is reused
      by every op;
    - `histories`, each block's rewrite steps, read one base hash at a
      time as a walk reaches it (`walk`) and kept as the batch records
      more (`recorded`). A block can hold millions of rows, and many ops
      can edit one block, so each op reads only the hashes its walk
      reaches, and pays for them."""
    allowance: int
    reader: Callable[[str], str] | None = None
    histories: dict[BlockUid, RewriteHistory] = dataclasses.field(
        default_factory=dict)

    def canonical(self, db: Db) -> Callable[[str], str]:
        if self.reader is None:
            self.reader = title_reader(db)
        return self.reader

    def history(self, uid: BlockUid) -> RewriteHistory:
        return self.histories.setdefault(uid, RewriteHistory.lazy())

    def walk(self, db: Db, uid: BlockUid,
             base_hash: Sha256Hex) -> RewriteHistory:
        """The block's history, with every hash a walk from `base_hash`
        reaches read, or marked too costly to read."""
        history = self.history(uid)
        while (unread := history.next_unread(base_hash)) is not None:
            self._read(db, uid, history, unread)
        return history

    def _read(self, db: Db, uid: BlockUid, history: RewriteHistory,
              base_hash: Sha256Hex) -> None:
        """Read the rows from `base_hash`, charged (`_rewrites_cost`). Past
        what is left the hash is marked unread and the read spends the
        rest, as a replay step past the budget does."""
        cost = _rewrites_cost(db, uid, base_hash, self.allowance)
        if cost is None:
            self.allowance = 0
            history.add_unread(base_hash)
            return
        self.allowance -= cost
        history.add_read(base_hash, _rewrites_from(db, uid, base_hash))

    def recorded(self, db: Db, uid: BlockUid,
                 rows: Sequence[BlockRewrite]) -> tuple[BlockRewrite, ...]:
        """Of rows the batch would write for `uid`, those not stored
        already, kept in the block's history as written. The same stale
        edit posted again records the same rows, which would otherwise
        multiply a hash's rows without bound. Each hash's stored rows are
        read to compare, charged; one too costly to read is not compared,
        and its rows are all written, since a row the client's next edit
        needs must never be dropped."""
        history = self.history(uid)
        fresh: list[BlockRewrite] = []
        for row in rows:
            base = row.base_hash
            if not history.is_read(base) and not history.is_unread(base):
                self._read(db, uid, history, base)
            if (history.is_read(base) and (row.after_hash, row.kind,
                                           row.old_text, row.new_text)
                    in history.stored(base)):
                continue
            fresh.append(row)
        history.record(fresh)
        return tuple(fresh)


def _context_for(db: Db, op: BlockOp, now_ms: int,
                 is_stale: TitleMatch | None = None, *,
                 replay: BatchReplay | None = None) -> OpContext:
    """Read what `op` needs, classify it once (classify_skip, then
    classify_text_edit for a hashed edit), and return the context type
    that classification calls for. `is_stale` matches the titles of pages
    deleted after the batch's `seen_seq`; None when there are none.
    `replay` is what the batch's hashed edits share (`BatchReplay`); None
    replays with no budget, from rows read for this op alone."""
    if isinstance(op, CreatePageOp):
        page = _resolve_page(db, op.page_title, now_ms)
        return PageContext(page["page_id"])
    block = _block_info(db, op.uid)
    parent_uid = (op.parent_uid if isinstance(op, (CreateOp, MoveOp))
                  else None)
    if isinstance(op, CreateOp) and parent_uid:
        # a create reads its parent's level in the query that reads the
        # parent, so the depth cap costs it no extra query
        parent, parent_depth = _block_with_depth(db, parent_uid)
    else:
        parent = _block_info(db, parent_uid) if parent_uid else None
        parent_depth = 0
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
        return CreateContext(uid_taken=block is not None, page_id=page_id,
                             depth=parent_depth + 1)
    assert block is not None  # classify_skip covered its absence
    if isinstance(op, MoveOp):
        # same rule as create: page_title places only a top-level move
        page_id = (_resolve_page(db, op.page_title, now_ms)["page_id"]
                   if op.page_title is not None and parent is None
                   else None)
        subtree, height = _subtree_with_height(db, op.uid)
        # the target chain runs from the parent up, so its length is the
        # parent's level; a top-level move's is empty
        return MoveContext(block, parent, page_id, subtree,
                           deepest=len(chain) + 1 + height)
    if isinstance(op, DeleteOp):
        if op.base_subtree_hash is None:
            return DeleteContext(block, _subtree_deepest_first(db, op.uid))
        rows = subtree_rows(db, op.uid)
        if not delete_diverged(op.base_subtree_hash, rows):
            return DeleteContext(block, tuple(r.uid for r in rows))
        # only a divergence pays for today's daily page: the landing mints
        # the header then the root's entry, and each other row's copy uid
        # follows in `rows` order. The copies never land under a header
        # inside the subtree being deleted (a block on today's daily page
        # can hold its own earlier header): that header gets a fresh one.
        landing = _conflict_landing(db, op.uid, now_ms,
                                    exclude={r.uid for r in rows})
        copy_uids = {r.uid: new_uid() for r in rows if r.uid != op.uid}
        return DeleteConflictContext(
            block, rows, _require_page_title(db, block.page_id), landing,
            copy_uids)
    if isinstance(op, UpdateTextOp) and op.base_text_hash is not None:
        row = db.select_one(
            "SELECT b.text, p.title FROM blocks b"
            " JOIN pages p ON p.id = b.page_id WHERE b.uid = ?",
            (op.uid,))
        assert row is not None  # classify_skip covered the block's absence
        base = op.base_text_hash
        history = (RewriteHistory(_block_rewrites(db, op.uid))
                   if replay is None else replay.walk(db, op.uid, base))
        # a replay matches titles the way the rename or delete did: under
        # plain-space titles `[[ Old ]]` is the page Old, and left linked
        # it re-creates the page. The flag is read only for an edit with a
        # rewrite row to replay.
        if not (history.is_unread(base)
                or history.newest(base, frozenset()) is not None):
            canonical: Callable[[str], str] = normalize_title
        elif replay is None:
            canonical = title_reader(db)
        else:
            canonical = replay.canonical(db)
        outcome = classify_text_edit(
            op.text, op.base_text_hash, row["text"], history, canonical,
            None if replay is None else replay.allowance)
        if outcome.kind == "over_limit":
            return ReplayOverLimitContext(
                block, row["title"], _conflict_landing(db, op.uid, now_ms),
                outcome.replayed, canonical, outcome.reads, outcome.blind)
        if outcome.kind != "conflict":
            return TextEditContext(block, outcome)
        # only a real conflict pays for today's daily page and its extra
        # queries
        return TextConflictContext(
            block, outcome.text, row["text"], row["title"],
            _conflict_landing(db, op.uid, now_ms), outcome.replayed,
            canonical, outcome.known, outcome.reads)
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
            [(eff.uid, r.base_hash, r.after_hash, r.old_text, r.new_text,
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


def expected_now(db: Db, expect: Sequence[ExpectedBlock]
                 ) -> dict[BlockUid, Sha256Hex | None]:
    """The hash of each expectation's own kind as stored now, None when no
    block has the uid: the text hash for text and absent, the subtree hash
    (through subtree_rows, the walk the card's reader shares) for subtree."""
    now: dict[BlockUid, Sha256Hex | None] = {}
    for e in expect:
        if e.kind == "subtree":
            rows = subtree_rows(db, e.uid)
            now[e.uid] = (subtree_hash((r.uid, r.text) for r in rows)
                          if rows else None)
        else:
            row = db.select_one("SELECT text FROM blocks WHERE uid = ?",
                                (e.uid,))
            now[e.uid] = None if row is None else text_hash(row["text"])
    return now


def apply_batch(db: Db, judged: JudgedBatch,
                now_ms: int) -> AppliedBatch:
    """Apply a batch inside the caller's transaction. The text and title
    judges have run already (`ops_core.judge_batch`), before the caller
    took the write lock; nothing here judges them again. Planning can
    still raise `OpError` (a depth cap, a move cycle)."""
    batch = judged.batch
    broadcast_ops: list[dict[str, object]] = []
    skipped: list[SkippedOp] = []
    stale = stale_titles(db, batch.seen_seq)
    is_stale: TitleMatch | None = None
    stale_canonical = title_reader(db) if stale else None
    if stale_canonical is not None:

        def is_stale(raw: str) -> bool:
            return stale_canonical(normalize_title(raw)) in stale
    replay = BatchReplay(MAX_BATCH_REPLAY_WORK, stale_canonical)
    for index, op in enumerate(batch.ops):
        sent = op
        if is_stale is not None:
            if isinstance(op, CreatePageOp) and is_stale(op.page_title):
                # the replica's local page goes through dropStrandedLocalPages
                continue
            op = unlink_stale_text(op, is_stale)
        ctx = _context_for(db, op, now_ms, is_stale, replay=replay)
        effects = plan_op(index, op, ctx)
        replayed: tuple[RewriteStep, ...] = ()
        replay_canonical = normalize_title
        known: Mapping[StepKey, str] = {}
        if isinstance(ctx, TextEditContext):
            replayed = ctx.outcome.replayed
            replay_canonical = ctx.outcome.canonical
            known = ctx.outcome.known
            replay.allowance -= ctx.outcome.reads
        elif isinstance(ctx, TextConflictContext):
            replayed = ctx.replayed
            replay_canonical = ctx.canonical
            known = ctx.known
            replay.allowance -= ctx.reads
        elif isinstance(ctx, ReplayOverLimitContext):
            replay.allowance -= ctx.reads
        if replayed or (is_stale is not None and op is not sent):
            effects += rewrite_effects(
                sent, effects, stale, stale_canonical or replay_canonical,
                replayed,
                ctx.outcome.text if isinstance(ctx, TextEditContext) else None,
                known)
        for eff in effects:
            if isinstance(eff, RecordRewrite):
                eff = RecordRewrite(eff.uid,
                                    replay.recorded(db, eff.uid, eff.rewrites))
            _execute(db, eff, now_ms)
        if isinstance(ctx, (*SKIPPED_CONTEXTS, ReplayOverLimitContext)):
            skipped.append(skip_report(index, op, ctx))
        else:
            broadcast_ops.append(_broadcast_op(db, op, ctx))
    return AppliedBatch(broadcast_ops, skipped)
