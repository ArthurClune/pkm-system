# pattern: Imperative Shell
"""Post-commit WS nudges. Invariant (spec section 1): every transaction
that advances changes.seq emits a nudge -- strictly AFTER a successful
commit. Nudges are best-effort signals; the client's cursor pull is the
correctness mechanism, and Hub.broadcast drops connections whose send
fails, so a lost nudge becomes a reconnect + catch-up pull."""
from __future__ import annotations

import sqlite3

import anyio.from_thread
from fastapi import Request


def _seq_frame(db: sqlite3.Connection) -> dict:
    seq = db.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
    return {"type": "seq", "seq": seq}


async def nudge(request: Request, db: sqlite3.Connection) -> None:
    """From async routes, after db.commit()."""
    await request.app.state.hub.broadcast(_seq_frame(db))


def nudge_threadpool(request: Request, db: sqlite3.Connection) -> None:
    """From sync-def routes, after db.commit(). Starlette runs these in an
    anyio worker thread, so from_thread.run reaches the event loop."""
    frame = _seq_frame(db)
    anyio.from_thread.run(request.app.state.hub.broadcast, frame)
