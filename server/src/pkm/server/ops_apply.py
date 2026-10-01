# pattern: Imperative Shell
"""Read SQLite into per-kind op contexts and execute planned effects.
Runs inside the caller's transaction; never commits or rolls back."""
from __future__ import annotations

import dataclasses
import secrets
import sqlite3
from collections.abc import Collection
from datetime import date

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import (CreateOp, CreatePageOp, DeleteOp, MoveOp,
                               OpBatch, UpdateTextOp)
from pkm.refs import CanonicalTitle
from pkm.server.ops_core import (SKIPPED_CONTEXTS, BlockContext, BlockInfo,
                                 BlockRewrite, ConflictLanding, CreateContext,
                                 DeleteBlocks, DeleteConflictContext,
                                 DeleteContext, Effect,
                                 ExistingHeader, FreshHeader, InsertBlock,
                                 JournalBlock, LandedSkipContext, MoveContext,
                                 OpContext, OpError, PageContext,
                                 RecordConflictHeader, ReindexRefs,
                                 SetCollapsed, SetHeading, SetPageId,
                                 SetParent, SetViewType, ShiftSiblings, Skip,
                                 SkipContext, SkippedContext,
                                 StuckMoveContext, SubtreeRow,
                                 TextConflictContext,
                                 TextEditContext, TouchPage, UpdateText,
                                 classify_skip, classify_text_edit,
                                 delete_diverged,
                                 find_op_title_violation, plan_op,
                                 skip_report)
from pkm.server.store import (BlankTitleError, fetch_page,
                              get_or_create_page, reindex_refs_for_text)
from pkm.server.sync_meta import read_title

# Fallback title for an op's page_title that normalizes to "" (e.g. a
# whitespace-only string -- pydantic's min_length=1 lets that through). The
# ops path must never reject a batch over this (an offline client
# replays queued batches, and a rejected one wedges its queue permanently),
# so instead of raising BlankTitleError up to the caller it resolves to this
# fixed, always-valid title -- get_or_create semantics, so repeated blank
# titles all land on the same page rather than minting one each.
UNTITLED_PAGE_TITLE = "Untitled"


def _new_uid() -> str:
    # 12 chars of [A-Za-z0-9_-]: fits UID_RE. Retry until the first char is
    # alphanumeric so a conflict header/child uid is never unaddressable
    # via a bare CLI argument the same way a client-minted uid could be.
    while True:
        uid = secrets.token_urlsafe(9)
        if uid[0].isalnum():
            return uid


def _resolve_page(db: sqlite3.Connection, title: str,
                  now_ms: int) -> sqlite3.Row:
    """get_or_create_page for op page_title fields: falls back to
    UNTITLED_PAGE_TITLE rather than propagating BlankTitleError (see
    module docstring above)."""
    try:
        return get_or_create_page(db, title, now_ms)
    except BlankTitleError:
        return get_or_create_page(db, UNTITLED_PAGE_TITLE, now_ms)


def _hint_page_exists(db: sqlite3.Connection, page_title: str | None) -> bool:
    """Does check 1's page_title hint name a page that exists now?
    Canonicalized the way get_or_create_page looks pages up. A hint whose
    page was renamed or deleted since the client saw it simply doesn't
    exist: block_rewrites can't map it to the new title, being keyed by
    referencing block, with rows only where some block referenced the page."""
    if page_title is None:
        return False
    return fetch_page(db, read_title(db, page_title)) is not None


def _block_info(db: sqlite3.Connection, uid: str) -> BlockInfo | None:
    row = db.execute(
        "SELECT uid, page_id, parent_uid FROM blocks WHERE uid = ?",
        (uid,)).fetchone()
    if row is None:
        return None
    return BlockInfo(row["uid"], row["page_id"], row["parent_uid"])


def _block_rewrites(db: sqlite3.Connection,
                    uid: str) -> tuple[BlockRewrite, ...]:
    """Every recorded rename/merge rewrite of this block, newest first --
    the order `ops_core.replay_title_rewrites` walks the chain in."""
    rows = db.execute(
        "SELECT base_hash, after_hash, old_title, new_title"
        " FROM block_rewrites WHERE uid = ?"
        " ORDER BY created_at DESC, rowid DESC", (uid,)).fetchall()
    return tuple(BlockRewrite(row["base_hash"], row["after_hash"],
                              row["old_title"], row["new_title"])
                 for row in rows)


def _parent_chain(db: sqlite3.Connection, uid: str) -> tuple[str, ...]:
    """uid and every ancestor above it, root last. Each block has exactly one
    parent, so this is a single path -- but a corrupted DB could already
    contain a cycle, so recursion is guarded by a visited-path check (`path`)
    rather than a depth cap: it stops the instant a uid reappears, however
    deep the real hierarchy runs, instead of silently truncating it. The
    comma-delimited path only works as a membership test because UID_RE
    (ops_core.py) bars commas from ever appearing in a uid."""
    rows = db.execute(
        """WITH RECURSIVE chain(uid, parent_uid, path) AS (
              SELECT uid, parent_uid, ',' || uid || ',' FROM blocks
               WHERE uid = ?
              UNION ALL
              SELECT b.uid, b.parent_uid, c.path || b.uid || ','
                FROM chain c JOIN blocks b ON b.uid = c.parent_uid
               WHERE instr(c.path, ',' || b.uid || ',') = 0
            ) SELECT uid FROM chain""", (uid,)).fetchall()
    return tuple(r["uid"] for r in rows)


def _subtree_deepest_first(db: sqlite3.Connection,
                           uid: str) -> tuple[str, ...]:
    """uid and every descendant, deepest first (children before parents, as
    DeleteBlocks and SetPageId both require). Same visited-path guard as
    _parent_chain: a proper tree can't revisit a uid, so the guard only ever
    fires on already-corrupted data, and otherwise traverses to full depth."""
    rows = db.execute(
        """WITH RECURSIVE sub(uid, path, depth) AS (
              SELECT uid, ',' || uid || ',', 0 FROM blocks WHERE uid = ?
              UNION ALL
              SELECT b.uid, s.path || b.uid || ',', s.depth + 1
                FROM sub s JOIN blocks b ON b.parent_uid = s.uid
               WHERE instr(s.path, ',' || b.uid || ',') = 0
            ) SELECT uid FROM sub ORDER BY depth DESC""", (uid,)).fetchall()
    return tuple(r["uid"] for r in rows)


def _subtree_rows(db: sqlite3.Connection,
                  uid: str) -> tuple[SubtreeRow, ...]:
    """uid and every descendant with its parent, position and text, deepest
    first -- what a guarded delete hashes and, on a divergence, copies. The
    same recursive CTE and visited-path guard as _subtree_deepest_first, so
    each row appears once and is reached from uid by construction: the
    walk only ever follows parent -> child links out of rows it already
    holds, and the guard refuses a uid already on the path. Every row
    DeleteBlocks removes is therefore one the copies can reach."""
    rows = db.execute(
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
               ORDER BY depth DESC""", (uid,)).fetchall()
    return tuple(SubtreeRow(r["uid"], r["parent_uid"], r["order_idx"],
                            r["text"]) for r in rows)


def _conflict_header(db: sqlite3.Connection, target_uid: str, day: str,
                     daily_page_id: int) -> tuple[str, int] | None:
    """(header_uid, next child order_idx) of today's conflict header for
    target_uid, or None when there is none or the user has deleted it (or
    moved it off the daily page) since it was recorded."""
    row = db.execute(
        "SELECT h.header_uid FROM conflict_headers h"
        " JOIN blocks b ON b.uid = h.header_uid"
        " WHERE h.target_uid = ? AND h.day = ? AND b.page_id = ?",
        (target_uid, day, daily_page_id)).fetchone()
    if row is None:
        return None
    idx = db.execute(
        "SELECT COALESCE(MAX(order_idx) + 1, 0) FROM blocks"
        " WHERE parent_uid = ?", (row["header_uid"],)).fetchone()[0]
    return row["header_uid"], idx


def _conflict_landing(db: sqlite3.Connection, target_uid: str,
                      now_ms: int,
                      exclude: Collection[str] = ()) -> ConflictLanding:
    """Where text that could not apply to target_uid lands: today's daily
    page, under its existing header for the block or at a fresh top-level
    slot. The day key is the server's local date, same as the daily page.

    An existing header whose uid is in `exclude` is passed over for a fresh
    one: a delete passes the subtree it removes, and a header inside that
    subtree would take the copies down with it. The fresh header is then
    recorded in its place."""
    day = title_for_date(date.today())
    daily = get_or_create_page(db, day, now_ms)
    idx = db.execute(
        "SELECT COALESCE(MAX(order_idx) + 1, 0) FROM blocks"
        " WHERE page_id = ? AND parent_uid IS NULL",
        (daily["id"],)).fetchone()[0]
    existing = _conflict_header(db, target_uid, day, daily["id"])
    if existing is not None and existing[0] in exclude:
        existing = None
    # A fresh header uid is minted only when there's no existing header to
    # append under: minting one anyway would be a uid neither this apply nor
    # any later one ever uses. It is minted before the entry uid.
    header = (FreshHeader(_new_uid(), idx) if existing is None
              else ExistingHeader(*existing))
    return ConflictLanding(daily_page_id=daily["id"], daily_title=day,
                           entry_uid=_new_uid(), header=header)


def _skip_context(db: sqlite3.Connection, op, skip: Skip,
                  block: BlockInfo | None, now_ms: int) -> SkippedContext:
    """Context for an op classify_skip flagged. Resolves no op page_title
    (get_or_create would create a page for an op that isn't applied), and
    pays for today's daily page only when an entry lands."""
    if skip.landing_uid is None:
        return SkipContext(skip)
    if skip.kind in ("move_parent_missing", "move_cycle"):
        assert block is not None  # the block exists; its target does not fit
        page_title = _require_page_title(db, block.page_id)
        subtree = _subtree_deepest_first(db, op.uid)
        return StuckMoveContext(
            skip, _conflict_landing(db, skip.landing_uid, now_ms),
            page_title, subtree)
    hint_page_exists = (isinstance(op, (CreateOp, UpdateTextOp))
                        and _hint_page_exists(db, op.page_title))
    return LandedSkipContext(
        skip, _conflict_landing(db, skip.landing_uid, now_ms),
        hint_page_exists)


def _context_for(db: sqlite3.Connection, op, now_ms: int) -> OpContext:
    """Read what `op` needs, classify it once (classify_skip, then
    classify_text_edit for a hashed edit), and return the context type
    that classification calls for."""
    if isinstance(op, CreatePageOp):
        page = _resolve_page(db, op.page_title, now_ms)
        return PageContext(page["id"])
    block = _block_info(db, op.uid)
    parent_uid = (op.parent_uid if isinstance(op, (CreateOp, MoveOp))
                  else None)
    parent = _block_info(db, parent_uid) if parent_uid else None
    # a move's target chain: what classify_skip's cycle test reads
    chain = (_parent_chain(db, parent.uid)
             if isinstance(op, MoveOp) and block is not None
             and parent is not None else ())
    skip = classify_skip(op, block is not None, parent is not None, chain)
    if skip is not None:
        return _skip_context(db, op, skip, block, now_ms)
    if isinstance(op, CreateOp):
        # Under a live parent the block lands on the parent's page, so the
        # op's page_title is never resolved: a title gone stale since
        # another device moved the parent would get_or_create an empty
        # page. It places only a top-level create.
        page_id = (parent.page_id if parent is not None
                   else _resolve_page(db, op.page_title, now_ms)["id"])
        return CreateContext(uid_taken=block is not None, page_id=page_id)
    assert block is not None  # classify_skip covered its absence
    if isinstance(op, MoveOp):
        # same rule as create: page_title places only a top-level move
        page_id = (_resolve_page(db, op.page_title, now_ms)["id"]
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
        row = db.execute(
            "SELECT b.text, p.title FROM blocks b"
            " JOIN pages p ON p.id = b.page_id WHERE b.uid = ?",
            (op.uid,)).fetchone()
        rewrites = _block_rewrites(db, op.uid)
        outcome = classify_text_edit(op.text, op.base_text_hash,
                                     row["text"], rewrites)
        if outcome.kind != "conflict":
            return TextEditContext(block, outcome)
        # only a real conflict pays for today's daily page and its extra
        # queries
        return TextConflictContext(
            block, outcome.text, row["text"], row["title"],
            _conflict_landing(db, op.uid, now_ms))
    return BlockContext(block)


def _execute(db: sqlite3.Connection, eff: Effect, now_ms: int) -> None:
    if isinstance(eff, ShiftSiblings):
        db.execute(
            "UPDATE blocks SET order_idx = order_idx + 1"
            " WHERE page_id = ? AND parent_uid IS ? AND order_idx >= ?",
            (eff.page_id, eff.parent_uid, eff.from_idx))
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
    elif isinstance(eff, JournalBlock):
        # the same row the blocks triggers write (schema.py SERVER_DDL)
        db.execute(
            "INSERT INTO changes(kind, entity_id, deleted)"
            " VALUES ('block', ?, ?)", (eff.uid, int(eff.deleted)))
    else:
        raise AssertionError(f"unhandled effect: {eff!r}")


def _page_title(db: sqlite3.Connection, page_id: int) -> CanonicalTitle | None:
    row = db.execute("SELECT title FROM pages WHERE id = ?",
                     (page_id,)).fetchone()
    return row["title"] if row is not None else None


def _require_page_title(db: sqlite3.Connection, page_id: int) -> CanonicalTitle:
    title = _page_title(db, page_id)
    if title is None:
        raise AssertionError(
            f"authoritative page title missing after applied op: page_id={page_id}"
        )
    return title


def _broadcast_page_title(db: sqlite3.Connection, op,
                          ctx: OpContext) -> str | None:
    if isinstance(ctx, (CreateContext, PageContext)):
        return _require_page_title(db, ctx.page_id)
    if not isinstance(ctx, MoveContext):
        return None
    assert isinstance(op, MoveOp)
    row = db.execute("SELECT page_id FROM blocks WHERE uid = ?",
                     (op.uid,)).fetchone()
    if row is None:
        raise AssertionError(
            f"applied move block missing before broadcast: uid={op.uid}"
        )
    if op.page_title is None and row["page_id"] == ctx.block.page_id:
        return None
    return _require_page_title(db, row["page_id"])


def _broadcast_op(db: sqlite3.Connection, op, ctx: OpContext) -> dict:
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
    broadcast_ops: list[dict]
    skipped: list[dict]


def apply_batch(db: sqlite3.Connection, batch: OpBatch,
                now_ms: int) -> AppliedBatch:
    """Apply a batch inside the caller's transaction."""
    violation = find_op_title_violation(batch.ops)
    if violation is not None:
        raise OpError(
            violation.op_index,
            f"unsupported {violation.source} title syntax: {violation.title!r}",
        )
    broadcast_ops: list[dict] = []
    skipped: list[dict] = []
    for index, op in enumerate(batch.ops):
        ctx = _context_for(db, op, now_ms)
        for eff in plan_op(index, op, ctx):
            _execute(db, eff, now_ms)
        if isinstance(ctx, SKIPPED_CONTEXTS):
            skipped.append(skip_report(index, op, ctx))
        else:
            broadcast_ops.append(_broadcast_op(db, op, ctx))
    return AppliedBatch(broadcast_ops, skipped)
