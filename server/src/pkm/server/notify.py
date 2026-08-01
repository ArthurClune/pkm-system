# pattern: Imperative Shell
"""Post-commit WS nudges. Invariant (spec section 1): every transaction
that advances changes.seq emits a nudge -- strictly AFTER a successful
commit. Nudges are best-effort signals; the client's cursor pull is the
correctness mechanism, and Hub.broadcast drops connections whose send
fails, so a lost nudge becomes a reconnect + catch-up pull."""
from __future__ import annotations

import sqlite3
from typing import Literal

import anyio.from_thread
from fastapi import Request
from pydantic import BaseModel


class SeqFrame(BaseModel):
    """The WS nudge frame. WS messages sit outside OpenAPI, so this model
    is their schema (spec contract-hardening, pkm-x7a5)."""
    type: Literal["seq"] = "seq"
    seq: int


def seq_frame(db: sqlite3.Connection) -> dict:
    seq = db.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
    return SeqFrame(seq=seq).model_dump()


async def nudge(request: Request, db: sqlite3.Connection) -> None:
    """From async routes, after db.commit()."""
    await request.app.state.hub.broadcast(seq_frame(db))


def nudge_threadpool(request: Request, db: sqlite3.Connection) -> None:
    """From sync-def routes, after db.commit(). Starlette runs these in an
    anyio worker thread, so from_thread.run reaches the event loop."""
    frame = seq_frame(db)
    anyio.from_thread.run(request.app.state.hub.broadcast, frame)


def commit_and_nudge_threadpool(request: Request, db: sqlite3.Connection) -> None:
    """Pairs commit + nudge for sync-def routes, whose writes touch a
    changes-journaled table (blocks/pages/sidebar_entries, schema.py
    SERVER_DDL) -- a bare `db.commit()` is exactly the shape that let
    pkm-getl's journal cleanup slip through with no nudge. Async routes
    have no equivalent helper (YAGNI -- delete on pkm-nn57 final review,
    no call sites): call `db.commit()` then `await nudge(request, db)`
    directly."""
    db.commit()
    nudge_threadpool(request, db)
