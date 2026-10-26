# pattern: Imperative Shell
"""POST /api/ops — the only write path. One transaction per batch."""
from __future__ import annotations

import sqlite3
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from pkm.contracts.ops import OpBatch
from pkm.contracts.responses import OpsAck
from pkm.database import Db
from pkm.server import notify
from pkm.server.notify import OpsFrame
from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.ops_apply import apply_batch, expected_now
from pkm.server.ops_core import OpError, judge_batch
from pkm.server.ops_expect import unmet_expectation
from pkm.server.ops_hash import batch_replay_hash, batch_request_hash
from pkm.server.sync_meta import latest_seq

router = APIRouter(dependencies=[Depends(require_auth)])


def _stored_ack(db: Db, batch: OpBatch) -> OpsAck | None:
    """The ack stored for `batch.batch_id`, or None when none is. A stored
    batch replays its ack verbatim; one stored with other ops is a 409.
    The caller rolls back whatever transaction it holds first."""
    row = db.select_one(
        "SELECT request_hash, response FROM applied_batches"
        " WHERE batch_id = ?", (batch.batch_id,))
    if row is None:
        return None
    # request_hash holds one of two kinds: the strict hash,
    # for a row written before this change (a pre-deploy retry must
    # still replay it), or the replay hash, for one written after
    # (tolerant of base_text_hash/page_title the worker fills into only
    # one copy of a batch when a lost enqueue reply leaves the client
    # retrying with the other). Either match means "same intent,
    # replay"; neither means a genuinely different payload reused the
    # batch_id.
    if row["request_hash"] not in (batch_request_hash(batch),
                                   batch_replay_hash(batch)):
        # same dict shape as the 400 OpError detail, so clients parse
        # one error contract
        raise HTTPException(
            status_code=409,
            detail={"index": None,
                    "reason": "batch_id was already used with"
                              " different ops"})
    # replay: the stored ack, passed through OpsAck like a fresh one, so
    # a row stored before seq/skipped existed gains seq: null / [] here
    return OpsAck.model_validate_json(row["response"])


@router.post("/api/ops", response_model=OpsAck)
async def post_ops(request: Request,
                   batch: OpBatch,
                   db: Db = Depends(get_db)) -> OpsAck:
    """One SQLite transaction covers the batch_id dedupe check through the
    commit, so a concurrent delete_page/rename_page/cleanup_journal commit
    (their own connections, on the threadpool) can no longer land between
    the dedupe read and this batch's writes. A write lock the busy timeout
    could not take (a concurrent writer already holds it) returns 503 with
    Retry-After rather than surfacing the raw sqlite3.OperationalError. The
    batch applies only if every `expect` entry still holds, checked in the
    same transaction after the dedupe, else 412 and nothing is written.

    The text-limit and title judges (`judge_batch`) run first, in the
    threadpool: off the write lock, so one large batch's refusal never
    holds every other write, and off the event loop. A refused batch is
    looked up before its 400, without the write lock (a committed row is
    visible to a plain read). One already applied, whose ack was lost and
    which a deploy has since put over a limit, replays its stored ack: a
    400 would make the client discard edits the server holds."""
    try:
        judged = await run_in_threadpool(judge_batch, batch)
    except OpError as e:
        # hashing a large batch is the judges' kind of work: off the loop
        stored = await run_in_threadpool(_stored_ack, db, batch)
        if stored is not None:
            return stored
        raise HTTPException(status_code=400,
                            detail={"index": e.index, "reason": e.reason})
    now = int(time.time() * 1000)
    try:
        db.begin_immediate()
    except sqlite3.OperationalError as exc:
        if "locked" not in str(exc):
            raise
        raise HTTPException(status_code=503, headers={"Retry-After": "1"},
                            detail="database busy, retry") from exc
    replay_hash = batch_replay_hash(batch)
    try:
        stored = _stored_ack(db, batch)
    except HTTPException:
        db.rollback()
        raise
    if stored is not None:
        db.rollback()
        return stored
    if batch.expect:
        reason = unmet_expectation(batch.expect,
                                   expected_now(db, batch.expect))
        if reason is not None:
            db.rollback()
            raise HTTPException(status_code=412,
                                detail={"index": None, "reason": reason})
    try:
        result = apply_batch(db, judged, now)
    except OpError as e:
        db.rollback()
        raise HTTPException(status_code=400,
                            detail={"index": e.index, "reason": e.reason})
    # Read inside the batch's own write transaction, so this is exactly the
    # journal max including the batch's rows. A replica compares it with a
    # sync window's latest_seq: a window whose latest_seq has reached it
    # already carries this batch. Acks stored before this field
    # existed replay without it; clients treat a missing seq as unknown.
    seq = latest_seq(db)
    # `applied` counts every op processed, skipped ones included; `skipped`
    # lists every op whose target no longer exists (ops_core.skip_report),
    # and is empty for a clean batch.
    response = OpsAck(ok=True, ts=now, applied=len(batch.ops), seq=seq,
                      skipped=result.skipped)
    # No IntegrityError branch here: BEGIN IMMEDIATE has been held since
    # before the dedupe SELECT above, so a second submission of this same
    # batch_id cannot reach this INSERT concurrently -- it blocks on the
    # write lock this transaction holds, and finds the row through the
    # ordinary dedupe SELECT once this transaction commits and releases it.
    db.execute(
        "INSERT INTO applied_batches VALUES (?,?,?,?)",
        (batch.batch_id, replay_hash, response.model_dump_json(), now))
    db.commit()
    await request.app.state.hub.broadcast(OpsFrame(
        client_id=batch.client_id, ts=now, ops=result.broadcast_ops))
    await notify.nudge(request, db)
    return response
