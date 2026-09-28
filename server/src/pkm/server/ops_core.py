# pattern: Functional Core
"""The pure op planner: each op + a context snapshot in, effect values
out. The shell (ops_apply) assembles OpContext from SQLite and executes
the effects; planning itself does no I/O.

The op models themselves live in `pkm.contracts.ops` -- they are the wire
contract every client builds against, so they must not sit behind
`pkm.server` (pkm-0wr8)."""
from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Union

from pkm.contracts.ops import (UID_RE, BlockOp, CreateOp, CreatePageOp,
                               DeleteOp, MoveOp, OpBatch, SetCollapsedOp,
                               SetHeadingOp, UpdateTextOp, ViewType,
                               text_hash)
from pkm.refs import TitleSyntaxReason, extract, title_syntax_reason
from pkm.rename import rewrite_title_refs_map

# Most renames a stale edit can be behind. Each step is one recorded
# rewrite of the same block, so the bound only matters for a block renamed
# through a long chain while one device stayed offline; past it the edit
# falls back to the ordinary conflict path.
MAX_REPLAYED_REWRITES = 10


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


def conflict_label(page_title: str | None) -> str:
    """`[[title]]` for a usable page-title hint, else the generic label.
    Usable = present, non-blank after stripping, and syntactically valid
    (spec section 2) -- an unusable hint can never fail the op, it just
    falls back to the generic label."""
    if (page_title is None or not page_title.strip()
            or title_syntax_reason(page_title) is not None):
        return "(page unknown)"
    return f"[[{page_title}]]"


def overwritten_header_text(page_title: str, uid: str) -> str:
    """Header for check 5: the live block's own page, read straight from
    its row -- always a real title, never a client-supplied hint."""
    return f"[[conflict]] [[{page_title}]] — overwritten by (({uid}))"


def orphan_header_text(page_title: str | None) -> str:
    """Header for check 1: page_title is the client's op.page_title hint,
    which may be missing or unusable."""
    return (f"[[conflict]] {conflict_label(page_title)} — edit to a block "
           "the server no longer has")


class OpError(ValueError):
    def __init__(self, index: int, reason: str):
        super().__init__(f"op {index}: {reason}")
        self.index = index
        self.reason = reason


@dataclass(frozen=True)
class OpTitleViolation:
    op_index: int
    source: Literal["page_title", "reference"]
    title: str
    reason: TitleSyntaxReason


def find_op_title_violation(
    ops: Sequence[BlockOp],
) -> OpTitleViolation | None:
    for op_index, op in enumerate(ops):
        page_title: str | None = None
        if isinstance(op, (CreateOp, CreatePageOp)):
            page_title = op.page_title
        elif isinstance(op, MoveOp):
            page_title = op.page_title
        if page_title is not None:
            reason = title_syntax_reason(page_title)
            if reason is not None:
                return OpTitleViolation(
                    op_index, "page_title", page_title, reason
                )
        if isinstance(op, (CreateOp, UpdateTextOp)):
            for ref in extract(op.text).refs:
                reason = title_syntax_reason(ref.title)
                if reason is not None:
                    return OpTitleViolation(
                        op_index, "reference", ref.title, reason
                    )
    return None


@dataclass(frozen=True)
class BlockRewrite:
    """One title a rename, merge or the title migration rewrote in one
    block, with the sha256 of that block's text either side of the whole
    rewrite. Rows of the server-only `block_rewrites` table, handed to the
    planner as data (pkm-x5w0)."""
    base_hash: str
    after_hash: str
    old_title: str
    new_title: str


def _rewrite_steps(
    rewrites: Sequence[BlockRewrite],
) -> list[tuple[str, str, dict[str, str]]]:
    """Regroup records into the rewrites they came from: records sharing a
    before/after hash pair were one pass over the block, so their titles
    replay as one map."""
    steps: list[tuple[str, str, dict[str, str]]] = []
    by_hashes: dict[tuple[str, str], dict[str, str]] = {}
    for record in rewrites:
        key = (record.base_hash, record.after_hash)
        titles = by_hashes.get(key)
        if titles is None:
            titles = {}
            by_hashes[key] = titles
            steps.append((record.base_hash, record.after_hash, titles))
        titles[record.old_title] = record.new_title
    return steps


def replay_title_rewrites(
    text: str,
    base_hash: str,
    rewrites: Sequence[BlockRewrite],
) -> tuple[str, str]:
    """Re-apply the renames this block already went through to an edit made
    before them, returning the edit's text and base hash as they would read
    had the device seen those renames first.

    A rename or merge rewrites `[[Old]]` in every referencing block. An
    offline device that had edited one of those blocks pushes its own text
    with the pre-rename hash, and plain last-write-wins would let that text
    win verbatim -- re-creating the page the rename had emptied. Following
    the recorded chain instead makes the edit an edit of the rewritten text,
    which then meets the ordinary conflict rules unchanged: it applies
    cleanly if nothing else touched the block, and conflicts under the *new*
    title if something did.

    Each step is consumed, so a record can never be replayed twice however
    the hashes line up; `MAX_REPLAYED_REWRITES` bounds the walk regardless.
    `rewrites` is newest-record-first, which decides the winner in the
    unlikely case that two rewrites share a base hash (a block edited back
    to a previous text, then renamed again).
    """
    steps = _rewrite_steps(rewrites)
    for _ in range(MAX_REPLAYED_REWRITES):
        match = next((s for s in steps if s[0] == base_hash), None)
        if match is None:
            break
        steps = [s for s in steps if s is not match]
        text = rewrite_title_refs_map(text, match[2])
        base_hash = match[1]
    return text, base_hash


@dataclass(frozen=True)
class BlockInfo:
    uid: str
    page_id: int
    parent_uid: str | None


@dataclass(frozen=True)
class OpContext:
    block: BlockInfo | None = None        # row for op.uid, if it exists
    page_id: int | None = None            # create: resolved target page
    parent: BlockInfo | None = None       # create/move: target parent row
    parent_chain: tuple[str, ...] = ()    # move: target parent + its ancestors
    subtree: tuple[str, ...] = ()         # delete/move: op.uid subtree (delete: deepest first)
    # update_text conflict handling (spec section 2); populated by the
    # shell only when the op carries base_text_hash
    current_text: str | None = None      # target's text right now
    order_idx: int | None = None         # target's order_idx
    page_title: str | None = None        # live block's page title (unused for missing blocks)
    conflict_uid: str | None = None      # fresh uid for a conflict header (becomes the header uid when one is created)
    conflict_child_uid: str | None = None  # fresh uid for the conflict entry (lost text) block
    daily_page_id: int | None = None     # today's daily page
    daily_append_idx: int | None = None  # next top-level idx there (new header)
    daily_title: str | None = None       # today's daily page title (for RecordConflictHeader)
    conflict_header_uid: str | None = None       # today's live header for op.uid, if any
    conflict_header_next_idx: int | None = None  # next child order_idx under it
    # rename/merge rewrites of op.uid, newest first (replay_title_rewrites)
    block_rewrites: tuple[BlockRewrite, ...] = ()


@dataclass(frozen=True)
class ShiftSiblings:
    page_id: int
    parent_uid: str | None
    from_idx: int


@dataclass(frozen=True)
class InsertBlock:
    uid: str
    page_id: int
    parent_uid: str | None
    order_idx: int
    text: str
    heading: int | None
    view_type: ViewType | None = None


@dataclass(frozen=True)
class UpdateText:
    uid: str
    text: str


@dataclass(frozen=True)
class SetParent:
    uid: str
    parent_uid: str | None
    order_idx: int


@dataclass(frozen=True)
class DeleteBlocks:
    uids: tuple[str, ...]  # deepest first: children always before parents


@dataclass(frozen=True)
class SetCollapsed:
    uid: str
    collapsed: bool


@dataclass(frozen=True)
class SetHeading:
    uid: str
    heading: int | None


@dataclass(frozen=True)
class SetViewType:
    uid: str
    view_type: ViewType


@dataclass(frozen=True)
class ReindexRefs:
    uid: str
    text: str


@dataclass(frozen=True)
class TouchPage:
    page_id: int


@dataclass(frozen=True)
class SetPageId:
    uids: tuple[str, ...]
    page_id: int


@dataclass(frozen=True)
class RecordConflictHeader:
    """A fresh conflict header was created for target_uid on day: later
    conflicts on the same block that land the same day append under it
    instead of creating another header (spec section 2)."""
    target_uid: str
    day: str
    header_uid: str


Effect = Union[ShiftSiblings, InsertBlock, UpdateText, SetParent,
               DeleteBlocks, SetCollapsed, SetHeading, SetViewType,
               ReindexRefs, TouchPage, SetPageId, RecordConflictHeader]


def conflict_entry_effects(
    target_uid: str, lost_text: str, header_text: str, ctx: OpContext,
) -> tuple[Effect, ...]:
    """Lost text landing in today's daily note (spec section 2): appended
    under today's existing header for this target if there is one,
    otherwise a fresh header is created and recorded so later conflicts on
    the same block land under it too."""
    assert ctx.conflict_child_uid is not None and ctx.daily_page_id is not None
    if ctx.conflict_header_uid is not None:
        assert ctx.conflict_header_next_idx is not None
        return (
            InsertBlock(ctx.conflict_child_uid, ctx.daily_page_id,
                        ctx.conflict_header_uid, ctx.conflict_header_next_idx,
                        lost_text, None),
            ReindexRefs(ctx.conflict_child_uid, lost_text),
            TouchPage(ctx.daily_page_id),
        )
    assert ctx.conflict_uid is not None and ctx.daily_append_idx is not None
    assert ctx.daily_title is not None
    return (
        InsertBlock(ctx.conflict_uid, ctx.daily_page_id, None,
                    ctx.daily_append_idx, header_text, None),
        ReindexRefs(ctx.conflict_uid, header_text),
        InsertBlock(ctx.conflict_child_uid, ctx.daily_page_id, ctx.conflict_uid,
                    0, lost_text, None),
        ReindexRefs(ctx.conflict_child_uid, lost_text),
        RecordConflictHeader(target_uid, ctx.daily_title, ctx.conflict_uid),
        TouchPage(ctx.daily_page_id),
    )


def plan_op(index: int, op: BlockOp, ctx: OpContext) -> tuple[Effect, ...]:
    if isinstance(op, CreatePageOp):
        if ctx.page_id is None:
            raise OpError(index, "page could not be resolved")
        # creation happened in context assembly (get_or_create, same as
        # CreateOp); the journal trigger recorded it. Nothing to execute.
        return ()
    if isinstance(op, CreateOp):
        if not UID_RE.match(op.uid):
            raise OpError(index, f"invalid uid: {op.uid!r}")
        if ctx.block is not None:
            raise OpError(index, f"uid already exists: {op.uid}")
        if ctx.page_id is None:
            raise OpError(index, "page could not be resolved")
        if op.parent_uid is not None:
            if ctx.parent is None:
                raise OpError(index, f"parent not found: {op.parent_uid}")
            if ctx.parent.page_id != ctx.page_id:
                raise OpError(index, "parent is on a different page")
        return (ShiftSiblings(ctx.page_id, op.parent_uid, op.order_idx),
                InsertBlock(op.uid, ctx.page_id, op.parent_uid, op.order_idx,
                            op.text, op.heading, op.view_type),
                ReindexRefs(op.uid, op.text),
                TouchPage(ctx.page_id))
    if (isinstance(op, UpdateTextOp) and op.base_text_hash is not None
            and ctx.block is None):
        # edit-vs-delete race: uid+text is all we have, the deleted row's
        # page/parent are gone -> conflict entry appended under today's
        # daily-note header naming the hint, rather than dropping the edit
        # (spec section 2, check 1)
        if (ctx.conflict_uid is None or ctx.conflict_child_uid is None
                or ctx.daily_page_id is None or ctx.daily_append_idx is None
                or ctx.daily_title is None):
            raise OpError(index, "conflict context missing")
        return conflict_entry_effects(
            op.uid, op.text, orphan_header_text(op.page_title), ctx)
    if ctx.block is None:
        raise OpError(index, f"block not found: {op.uid}")
    if isinstance(op, UpdateTextOp):
        if op.base_text_hash is None:                # check 3: legacy
            return (UpdateText(op.uid, op.text),
                    ReindexRefs(op.uid, op.text),
                    TouchPage(ctx.block.page_id))
        if ctx.current_text is None or ctx.order_idx is None \
                or ctx.conflict_uid is None:
            raise OpError(index, "conflict context missing")
        # Renames this edit predates are replayed over it first, so the
        # checks below compare like with like and no old title can ride a
        # stale edit back in (see replay_title_rewrites).
        text, base_hash = replay_title_rewrites(
            op.text, op.base_text_hash, ctx.block_rewrites)
        base_effects = (UpdateText(op.uid, text),
                        ReindexRefs(op.uid, text),
                        TouchPage(ctx.block.page_id))
        if text == ctx.current_text:
            return ()                                # check 2: identical
        if text_hash(ctx.current_text) == base_hash:
            return base_effects                      # check 4: clean apply
        # check 5: concurrent edit -- incoming wins, loser preserved under
        # today's daily-note conflict header naming the block's page
        if (ctx.conflict_child_uid is None or ctx.daily_page_id is None
                or ctx.daily_append_idx is None or ctx.daily_title is None
                or ctx.page_title is None):
            raise OpError(index, "conflict context missing")
        header_text = overwritten_header_text(ctx.page_title, op.uid)
        return (*conflict_entry_effects(op.uid, ctx.current_text,
                                        header_text, ctx),
                *base_effects)
    if isinstance(op, MoveOp):
        if op.parent_uid is not None:
            if ctx.parent is None:
                raise OpError(index, f"parent not found: {op.parent_uid}")
            if ctx.page_id is not None and ctx.page_id != ctx.parent.page_id:
                raise OpError(index, "page_title does not match parent's page")
            if op.uid in ctx.parent_chain:
                raise OpError(index, "move would create a cycle")
            target_page = ctx.parent.page_id
        else:
            target_page = (ctx.page_id if ctx.page_id is not None
                           else ctx.block.page_id)
        effects: list[Effect] = [
            ShiftSiblings(target_page, op.parent_uid, op.order_idx),
            SetParent(op.uid, op.parent_uid, op.order_idx)]
        if target_page != ctx.block.page_id:
            effects.append(SetPageId(ctx.subtree, target_page))
            effects.append(TouchPage(ctx.block.page_id))
        effects.append(TouchPage(target_page))
        return tuple(effects)
    if isinstance(op, DeleteOp):
        return (DeleteBlocks(ctx.subtree), TouchPage(ctx.block.page_id))
    if isinstance(op, SetCollapsedOp):
        # pkm-r7k8: collapse/expand is UI state, not a real change -- no
        # TouchPage, so it doesn't bump the page's updated_at and pollute
        # "last changed" (unlike every other op planned here).
        return (SetCollapsed(op.uid, op.collapsed),)
    if isinstance(op, SetHeadingOp):
        return (SetHeading(op.uid, op.heading), TouchPage(ctx.block.page_id))
    # SetViewTypeOp (the discriminated union admits nothing else)
    return (SetViewType(op.uid, op.view_type), TouchPage(ctx.block.page_id))
