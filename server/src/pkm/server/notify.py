# pattern: Imperative Shell
"""Post-commit WS nudges. Invariant (offline-editing-design.md §1): every
transaction that advances changes.seq emits a nudge -- strictly AFTER a
successful commit. Nudges are best-effort signals; the client's cursor pull
is the correctness mechanism, and Hub.broadcast drops connections whose send
fails, so a lost nudge becomes a reconnect + catch-up pull."""
from __future__ import annotations

import sqlite3
from typing import Literal

import anyio.from_thread
from fastapi import Request
from pydantic import BaseModel

from pkm.contracts.ops import ClientId
from pkm.contracts.responses import SyncSeq


class SeqFrame(BaseModel):
    """The WS nudge frame. WS messages sit outside OpenAPI, so this model
    is their schema -- `SyncSeq` is tagged with `brand()` for consistency
    with the HTTP wire fields, but gen-types never sees this model, so the
    web's `WsSeq.seq` (sync/socket.ts) is narrowed to `Brands.SyncSeq` by
    hand.

    ``force`` is reserved for committed metadata/generation changes that do
    not necessarily advance ``changes.seq``. Its seq is always the real
    journal maximum; clients pull at their unchanged cursor and discover the
    generation mismatch without inventing a cursor value that could collide
    with a future journal row.
    """
    type: Literal["seq"] = "seq"
    seq: SyncSeq
    force: bool = False
    generation: str | None = None

    def wire(self) -> dict[str, object]:
        """The JSON the socket carries: `force` only when set, and no null
        fields."""
        return self.model_dump(
            exclude={"force"} if not self.force else set(),
            exclude_none=True,
        )


class OpsFrame(BaseModel):
    """The WS frame that echoes a committed batch's applied ops to the
    other clients (the writer's own `client_id` lets it skip the echo)."""
    client_id: ClientId
    ts: int
    ops: list[dict[str, object]]

    def wire(self) -> dict[str, object]:
        return self.model_dump()


Frame = SeqFrame | OpsFrame


def seq_frame(
    db: sqlite3.Connection,
    *,
    force: bool = False,
    generation: str | None = None,
) -> SeqFrame:
    if force and generation is None:
        raise ValueError("forced seq frame requires a generation")
    seq = SyncSeq(db.execute(
        "SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0])
    return SeqFrame(seq=seq, force=force, generation=generation)


async def nudge(request: Request, db: sqlite3.Connection) -> None:
    """From async routes, after db.commit()."""
    await request.app.state.hub.broadcast(seq_frame(db))


def nudge_threadpool(
    request: Request,
    db: sqlite3.Connection,
    *,
    force: bool = False,
    generation: str | None = None,
) -> None:
    """From sync-def routes, after db.commit(). Starlette runs these in an
    anyio worker thread, so from_thread.run reaches the event loop."""
    frame = seq_frame(db, force=force, generation=generation)
    anyio.from_thread.run(request.app.state.hub.broadcast, frame)


def commit_and_nudge_threadpool(request: Request, db: sqlite3.Connection) -> None:
    """Pairs commit + nudge for sync-def routes, whose writes touch a
    changes-journaled table (blocks/pages/sidebar_entries, schema.py
    SERVER_DDL) -- a bare `db.commit()` silently drops the nudge that
    should follow it. Async routes have no equivalent helper (no call
    sites need one): call `db.commit()` then `await nudge(request, db)`
    directly."""
    db.commit()
    nudge_threadpool(request, db)
