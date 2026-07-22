# pattern: Imperative Shell
"""POST /api/ops — the only write path. One transaction per batch."""
from __future__ import annotations

import json
import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException, Request

from pkm.server import notify
from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.ops_apply import apply_batch
from pkm.server.ops_core import OpBatch, OpError, batch_request_hash

router = APIRouter(dependencies=[Depends(require_auth)])


@router.post("/api/ops")
async def post_ops(request: Request,
                   batch: OpBatch,
                   db: sqlite3.Connection = Depends(get_db)) -> dict:
    now = int(time.time() * 1000)
    rhash = batch_request_hash(batch)
    row = db.execute(
        "SELECT request_hash, response FROM applied_batches"
        " WHERE batch_id = ?", (batch.batch_id,)).fetchone()
    if row is not None:
        if row["request_hash"] != rhash:
            # same dict shape as the 400 OpError detail below, so
            # clients parse one error contract (pkm-x7a5)
            raise HTTPException(
                status_code=409,
                detail={"index": None,
                        "reason": "batch_id was already used with"
                                  " different ops"})
        return json.loads(row["response"])  # replay: stored ack, no effects
    try:
        broadcast_ops = apply_batch(db, batch, now)
    except OpError as e:
        db.rollback()
        raise HTTPException(status_code=400,
                            detail={"index": e.index, "reason": e.reason})
    response = {"ok": True, "ts": now, "applied": len(batch.ops)}
    try:
        db.execute(
            "INSERT INTO applied_batches VALUES (?,?,?,?)",
            (batch.batch_id, rhash, json.dumps(response), now))
    except sqlite3.IntegrityError:
        # two concurrent submissions of the same batch raced; this one
        # loses -- roll back its effects and serve the winner's ack
        db.rollback()
        row = db.execute(
            "SELECT response FROM applied_batches WHERE batch_id = ?",
            (batch.batch_id,)).fetchone()
        assert row is not None
        return json.loads(row["response"])
    db.commit()
    await request.app.state.hub.broadcast({
        "client_id": batch.client_id,
        "ts": now,
        "ops": broadcast_ops,
    })
    await notify.nudge(request, db)
    return response
