# pattern: Imperative Shell
"""Assemble OpContext snapshots from SQLite and execute planned effects.
Runs inside the caller's transaction; never commits or rolls back."""
from __future__ import annotations

import secrets
import sqlite3
from datetime import date

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import (CreateOp, CreatePageOp, DeleteOp, MoveOp,
                               OpBatch, UpdateTextOp)
from pkm.refs import extract
from pkm.server.ops_core import (BlockInfo, DeleteBlocks, Effect, InsertBlock,
                                 OpContext, OpError, ReindexRefs, SetCollapsed,
                                 SetHeading, SetPageId, SetParent, SetViewType,
                                 ShiftSiblings, TouchPage, UpdateText,
                                 find_op_title_violation, plan_op)
from pkm.server.store import BlankTitleError, get_or_create_page, index_ref

# Fallback title for an op's page_title that normalizes to "" (e.g. a
# whitespace-only string -- pydantic's min_length=1 lets that through). The
# ops path must never reject a batch over this (pkm-hjhy: an offline client
# replays queued batches, and a rejected one wedges its queue permanently),
# so instead of raising BlankTitleError up to the caller it resolves to this
# fixed, always-valid title -- get_or_create semantics, so repeated blank
# titles all land on the same page rather than minting one each.
UNTITLED_PAGE_TITLE = "Untitled"


def _new_uid() -> str:
    # 12 chars of [A-Za-z0-9_-]: fits UID_RE. Retry until the first char is
    # alphanumeric so a conflict-sibling uid is never unaddressable via a
    # bare CLI argument the same way a client-minted uid could be
    # (pkm-y5yv).
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


def _block_info(db: sqlite3.Connection, uid: str) -> BlockInfo | None:
    row = db.execute(
        "SELECT uid, page_id, parent_uid FROM blocks WHERE uid = ?",
        (uid,)).fetchone()
    if row is None:
        return None
    return BlockInfo(row["uid"], row["page_id"], row["parent_uid"])


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


def _context_for(db: sqlite3.Connection, op, now_ms: int) -> OpContext:
    if isinstance(op, CreatePageOp):
        page = _resolve_page(db, op.page_title, now_ms)
        return OpContext(page_id=page["id"])
    block = _block_info(db, op.uid)
    if isinstance(op, CreateOp):
        page = _resolve_page(db, op.page_title, now_ms)
        parent = _block_info(db, op.parent_uid) if op.parent_uid else None
        return OpContext(block=block, page_id=page["id"], parent=parent)
    if isinstance(op, MoveOp):
        parent = _block_info(db, op.parent_uid) if op.parent_uid else None
        chain = _parent_chain(db, op.parent_uid) if op.parent_uid else ()
        page_id = (_resolve_page(db, op.page_title, now_ms)["id"]
                   if op.page_title is not None else None)
        return OpContext(block=block, parent=parent, parent_chain=chain,
                         page_id=page_id,
                         subtree=_subtree_deepest_first(db, op.uid))
    if isinstance(op, DeleteOp):
        return OpContext(block=block,
                         subtree=_subtree_deepest_first(db, op.uid))
    if isinstance(op, UpdateTextOp) and op.base_text_hash is not None:
        conflict_uid = _new_uid()
        if block is None:
            daily = get_or_create_page(
                db, title_for_date(date.today()), now_ms)
            idx = db.execute(
                "SELECT COALESCE(MAX(order_idx) + 1, 0) FROM blocks"
                " WHERE page_id = ? AND parent_uid IS NULL",
                (daily["id"],)).fetchone()[0]
            return OpContext(block=None, conflict_uid=conflict_uid,
                             daily_page_id=daily["id"],
                             daily_append_idx=idx)
        row = db.execute(
            "SELECT text, order_idx FROM blocks WHERE uid = ?",
            (op.uid,)).fetchone()
        return OpContext(block=block, current_text=row["text"],
                         order_idx=row["order_idx"],
                         conflict_uid=conflict_uid)
    return OpContext(block=block)


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
        # pkm-r7k8: collapse/expand is UI state, not a real change -- no
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
        db.execute("DELETE FROM refs WHERE src_block_uid = ?", (eff.uid,))
        for ref in extract(eff.text).refs:
            index_ref(db, eff.uid, ref.title, ref.kind, now_ms)
    elif isinstance(eff, TouchPage):
        db.execute("UPDATE pages SET updated_at = ? WHERE id = ?",
                   (now_ms, eff.page_id))
    elif isinstance(eff, SetPageId):
        db.executemany(
            "UPDATE blocks SET page_id = ?, updated_at = ? WHERE uid = ?",
            [(eff.page_id, now_ms, u) for u in eff.uids])
    else:
        raise AssertionError(f"unhandled effect: {eff!r}")


def _page_title(db: sqlite3.Connection, page_id: int) -> str | None:
    row = db.execute("SELECT title FROM pages WHERE id = ?",
                     (page_id,)).fetchone()
    return row["title"] if row is not None else None


def _require_page_title(db: sqlite3.Connection, page_id: int) -> str:
    title = _page_title(db, page_id)
    if title is None:
        raise AssertionError(
            f"authoritative page title missing after applied op: page_id={page_id}"
        )
    return title


def _broadcast_page_title(db: sqlite3.Connection, op,
                          ctx: OpContext) -> str | None:
    if isinstance(op, (CreateOp, CreatePageOp)) and ctx.page_id is not None:
        return _require_page_title(db, ctx.page_id)
    if not isinstance(op, MoveOp) or ctx.block is None:
        return None
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


def apply_batch(db: sqlite3.Connection, batch: OpBatch,
                now_ms: int) -> list[dict]:
    """Apply a batch inside the caller's transaction and return the ops as
    they should be broadcast (see _broadcast_op)."""
    violation = find_op_title_violation(batch.ops)
    if violation is not None:
        raise OpError(
            violation.op_index,
            f"unsupported {violation.source} title syntax: {violation.title!r}",
        )
    broadcast_ops: list[dict] = []
    for index, op in enumerate(batch.ops):
        ctx = _context_for(db, op, now_ms)
        for eff in plan_op(index, op, ctx):
            _execute(db, eff, now_ms)
        broadcast_ops.append(_broadcast_op(db, op, ctx))
    return broadcast_ops
