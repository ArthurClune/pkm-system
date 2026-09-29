# pattern: Functional Core
"""The hashes that bind a batch_id to one payload. applied_batches keeps
them across deploys, so the canonical form of an op may only grow in ways
that leave every older op's hash unchanged."""
from __future__ import annotations

import hashlib
import json

from pkm.contracts.ops import BlockOp, OpBatch, UpdateTextOp


def batch_request_hash(batch: OpBatch) -> str:
    """Canonical content hash binding a batch_id to one payload forever
    (spec section 1): replay with a different payload is rejected, so a
    buggy client can't silently swap the ops behind an acknowledged id."""
    canon = json.dumps([_canonical_op(op) for op in batch.ops],
                       sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


def _canonical_op(op: BlockOp) -> dict:
    """The op as hashed. applied_batches keeps these hashes across deploys,
    so an op that doesn't use a field added later must hash as it did
    before the field existed: any new optional op field is left out here
    while it is unset. Only those fields -- a blanket exclude_none would
    re-hash older fields' None, such as a hashless edit's base_text_hash."""
    dump = op.model_dump()
    if isinstance(op, UpdateTextOp) and op.page_title is None:
        del dump["page_title"]
    return dump


def batch_replay_hash(batch: OpBatch) -> str:
    """Like `batch_request_hash`, but tolerant of base_text_hash and
    page_title on update_text ops (pkm-95ss): the worker fills these
    into the durable copy of a batch when the client omitted them,
    but a lost enqueue reply leaves the client's in-memory fallback-lane
    copy of the SAME batch_id with the original, unfilled ops. Both
    copies eventually reach the server; they carry the same intent, so
    the same batch_id replaying with only these guard/label fields
    differing must not 409. Stored in applied_batches.request_hash for
    rows written after this change -- see routes_ops.py for how a row
    holding the (older) strict hash still replays."""
    canon = json.dumps([_canonical_replay_op(op) for op in batch.ops],
                       sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


def _canonical_replay_op(op: BlockOp) -> dict:
    """`_canonical_op`, minus base_text_hash/page_title on update_text:
    guard/label metadata that never changes which op is applied (see
    `batch_replay_hash`)."""
    dump = _canonical_op(op)
    if isinstance(op, UpdateTextOp):
        dump.pop("base_text_hash", None)
        dump.pop("page_title", None)
    return dump
