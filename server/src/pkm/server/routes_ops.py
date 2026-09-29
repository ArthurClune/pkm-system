# pattern: Imperative Shell
"""POST /api/ops — the only write path. One transaction per batch."""
from __future__ import annotations

import json
import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException, Request

from pkm.contracts.ops import OpBatch
from pkm.server import notify
from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.ops_apply import apply_batch
from pkm.server.ops_core import OpError, batch_replay_hash, batch_request_hash

router = APIRouter(dependencies=[Depends(require_auth)])


@router.post("/api/ops")
async def post_ops(request: Request,
                   batch: OpBatch,
                   db: sqlite3.Connection = Depends(get_db)) -> dict:
    """One SQLite transaction covers the batch_id dedupe check through the
    commit, so a concurrent delete_page/rename_page/cleanup_journal commit
    (their own connections, on the threadpool) can no longer land between
    the dedupe read and this batch's writes. A write lock the busy timeout
    could not take (a concurrent writer already holds it) returns 503 with
    Retry-After rather than surfacing the raw sqlite3.OperationalError."""
    now = int(time.time() * 1000)
    try:
        db.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError as exc:
        if "locked" not in str(exc):
            raise
        raise HTTPException(status_code=503, headers={"Retry-After": "1"},
                            detail="database busy, retry") from exc
    rhash = batch_request_hash(batch)
    replay_hash = batch_replay_hash(batch)
    row = db.execute(
        "SELECT request_hash, response FROM applied_batches"
        " WHERE batch_id = ?", (batch.batch_id,)).fetchone()
    if row is not None:
        # request_hash holds one of two kinds (pkm-95ss): the strict hash,
        # for a row written before this change (a pre-deploy retry must
        # still replay it), or the replay hash, for one written after
        # (tolerant of base_text_hash/page_title the worker fills into only
        # one copy of a batch when a lost enqueue reply leaves the client
        # retrying with the other). Either match means "same intent,
        # replay"; neither means a genuinely different payload reused the
        # batch_id.
        if row["request_hash"] not in (rhash, replay_hash):
            db.rollback()
            # same dict shape as the 400 OpError detail below, so
            # clients parse one error contract (pkm-x7a5)
            raise HTTPException(
                status_code=409,
                detail={"index": None,
                        "reason": "batch_id was already used with"
                                  " different ops"})
        db.rollback()
        return json.loads(row["response"])  # replay: stored ack, no effects
    try:
        result = apply_batch(db, batch, now)
    except OpError as e:
        db.rollback()
        raise HTTPException(status_code=400,
                            detail={"index": e.index, "reason": e.reason})
    # Read inside the batch's own write transaction, so this is exactly the
    # journal max including the batch's rows. A replica compares it with a
    # sync window's latest_seq: a window whose latest_seq has reached it
    # already carries this batch (pkm-ur2n). Acks stored before this field
    # existed replay without it; clients treat a missing seq as unknown.
    seq = db.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
    # `applied` counts every op processed, skipped ones included; `skipped`
    # lists the ops whose target no longer exists (ops_core.skip_report).
    # It is sent only when non-empty: clients already read a missing list
    # as empty (acks stored before the field existed replay without it),
    # and every clean write's ack stays byte-for-byte what it was.
    response = {"ok": True, "ts": now, "applied": len(batch.ops), "seq": seq}
    if result.skipped:
        response["skipped"] = result.skipped
    # No IntegrityError branch here: BEGIN IMMEDIATE has been held since
    # before the dedupe SELECT above, so a second submission of this same
    # batch_id cannot reach this INSERT concurrently -- it blocks on the
    # write lock this transaction holds, and finds the row through the
    # ordinary dedupe SELECT once this transaction commits and releases it.
    db.execute(
        "INSERT INTO applied_batches VALUES (?,?,?,?)",
        (batch.batch_id, replay_hash, json.dumps(response), now))
    db.commit()
    await request.app.state.hub.broadcast({
        "client_id": batch.client_id,
        "ts": now,
        "ops": result.broadcast_ops,
    })
    await notify.nudge(request, db)
    return response
