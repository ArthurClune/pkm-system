# pattern: Imperative Shell
"""POST /api/ops — the only write path. One transaction per batch."""
from __future__ import annotations

import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException

from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.ops_apply import apply_batch
from pkm.server.ops_core import OpBatch, OpError

router = APIRouter(dependencies=[Depends(require_auth)])


@router.post("/api/ops")
async def post_ops(batch: OpBatch,
                   db: sqlite3.Connection = Depends(get_db)) -> dict:
    now = int(time.time() * 1000)
    try:
        apply_batch(db, batch, now)
    except OpError as e:
        db.rollback()
        raise HTTPException(status_code=400,
                            detail={"index": e.index, "reason": e.reason})
    db.commit()
    return {"ok": True, "ts": now, "applied": len(batch.ops)}
