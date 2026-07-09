# pattern: Imperative Shell
"""Assemble OpContext snapshots from SQLite and execute planned effects.
Runs inside the caller's transaction; never commits or rolls back."""
from __future__ import annotations

import sqlite3

from pkm.refs import extract
from pkm.server.ops_core import (BlockInfo, CreateOp, DeleteBlocks, DeleteOp,
                                 Effect, InsertBlock, MoveOp, OpBatch,
                                 OpContext, ReindexRefs, SetCollapsed,
                                 SetHeading, SetParent, ShiftSiblings,
                                 TouchPage, UpdateText, plan_op)
from pkm.server.store import get_or_create_page

_DEPTH_CAP = 100


def _block_info(db: sqlite3.Connection, uid: str) -> BlockInfo | None:
    row = db.execute(
        "SELECT uid, page_id, parent_uid FROM blocks WHERE uid = ?",
        (uid,)).fetchone()
    if row is None:
        return None
    return BlockInfo(row["uid"], row["page_id"], row["parent_uid"])


def _parent_chain(db: sqlite3.Connection, uid: str) -> tuple[str, ...]:
    rows = db.execute(
        f"""WITH RECURSIVE chain(uid, parent_uid, depth) AS (
              SELECT uid, parent_uid, 0 FROM blocks WHERE uid = ?
              UNION ALL
              SELECT b.uid, b.parent_uid, c.depth + 1
                FROM chain c JOIN blocks b ON b.uid = c.parent_uid
               WHERE c.depth < {_DEPTH_CAP}
            ) SELECT uid FROM chain""", (uid,)).fetchall()
    return tuple(r["uid"] for r in rows)


def _subtree_deepest_first(db: sqlite3.Connection,
                           uid: str) -> tuple[str, ...]:
    rows = db.execute(
        f"""WITH RECURSIVE sub(uid, depth) AS (
              SELECT uid, 0 FROM blocks WHERE uid = ?
              UNION ALL
              SELECT b.uid, s.depth + 1
                FROM sub s JOIN blocks b ON b.parent_uid = s.uid
               WHERE s.depth < {_DEPTH_CAP}
            ) SELECT uid FROM sub ORDER BY depth DESC""", (uid,)).fetchall()
    return tuple(r["uid"] for r in rows)


def _context_for(db: sqlite3.Connection, op, now_ms: int) -> OpContext:
    block = _block_info(db, op.uid)
    if isinstance(op, CreateOp):
        page = get_or_create_page(db, op.page_title, now_ms)
        parent = _block_info(db, op.parent_uid) if op.parent_uid else None
        return OpContext(block=block, page_id=page["id"], parent=parent)
    if isinstance(op, MoveOp):
        parent = _block_info(db, op.parent_uid) if op.parent_uid else None
        chain = _parent_chain(db, op.parent_uid) if op.parent_uid else ()
        return OpContext(block=block, parent=parent, parent_chain=chain)
    if isinstance(op, DeleteOp):
        return OpContext(block=block,
                         subtree=_subtree_deepest_first(db, op.uid))
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
            " heading, collapsed, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,0,?,?)",
            (eff.uid, eff.page_id, eff.parent_uid, eff.order_idx, eff.text,
             eff.heading, now_ms, now_ms))
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
        db.execute(
            "UPDATE blocks SET collapsed = ?, updated_at = ? WHERE uid = ?",
            (int(eff.collapsed), now_ms, eff.uid))
    elif isinstance(eff, SetHeading):
        db.execute(
            "UPDATE blocks SET heading = ?, updated_at = ? WHERE uid = ?",
            (eff.heading, now_ms, eff.uid))
    elif isinstance(eff, ReindexRefs):
        db.execute("DELETE FROM refs WHERE src_block_uid = ?", (eff.uid,))
        for ref in extract(eff.text).refs:
            page = get_or_create_page(db, ref.title, now_ms)
            db.execute("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
                       (eff.uid, page["id"], ref.kind))
    elif isinstance(eff, TouchPage):
        db.execute("UPDATE pages SET updated_at = ? WHERE id = ?",
                   (now_ms, eff.page_id))
    else:
        raise AssertionError(f"unhandled effect: {eff!r}")


def apply_batch(db: sqlite3.Connection, batch: OpBatch, now_ms: int) -> None:
    for index, op in enumerate(batch.ops):
        ctx = _context_for(db, op, now_ms)
        for eff in plan_op(index, op, ctx):
            _execute(db, eff, now_ms)
