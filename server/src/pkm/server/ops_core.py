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


def batch_request_hash(batch: OpBatch) -> str:
    """Canonical content hash binding a batch_id to one payload forever
    (spec section 1): replay with a different payload is rejected, so a
    buggy client can't silently swap the ops behind an acknowledged id."""
    canon = json.dumps([op.model_dump() for op in batch.ops],
                       sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


def conflict_copy_text(lost_text: str) -> str:
    """Overwritten text preserved as an ordinary block, [[conflict]]-tagged
    so it is findable via search and the conflict page's backlinks."""
    return f"[[conflict]] {lost_text}"


def orphan_conflict_text(text: str) -> str:
    return f"[[conflict]] (original block deleted) {text}"


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
    conflict_uid: str | None = None      # fresh uid for a conflict copy
    daily_page_id: int | None = None     # orphan landing page
    daily_append_idx: int | None = None  # next top-level idx there


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


Effect = Union[ShiftSiblings, InsertBlock, UpdateText, SetParent,
               DeleteBlocks, SetCollapsed, SetHeading, SetViewType,
               ReindexRefs, TouchPage, SetPageId]


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
        # page/parent are gone -> conflict block appended to today's daily
        # page rather than dropping the edit (spec section 2, check 1)
        if (ctx.conflict_uid is None or ctx.daily_page_id is None
                or ctx.daily_append_idx is None):
            raise OpError(index, "conflict context missing")
        text = orphan_conflict_text(op.text)
        return (InsertBlock(ctx.conflict_uid, ctx.daily_page_id, None,
                            ctx.daily_append_idx, text, None),
                ReindexRefs(ctx.conflict_uid, text),
                TouchPage(ctx.daily_page_id))
    if ctx.block is None:
        raise OpError(index, f"block not found: {op.uid}")
    if isinstance(op, UpdateTextOp):
        base_effects = (UpdateText(op.uid, op.text),
                        ReindexRefs(op.uid, op.text),
                        TouchPage(ctx.block.page_id))
        if op.base_text_hash is None:
            return base_effects                      # check 3: legacy
        if ctx.current_text is None or ctx.order_idx is None \
                or ctx.conflict_uid is None:
            raise OpError(index, "conflict context missing")
        if op.text == ctx.current_text:
            return ()                                # check 2: identical
        if text_hash(ctx.current_text) == op.base_text_hash:
            return base_effects                      # check 4: clean apply
        # check 5: concurrent edit -- incoming wins, loser preserved as a
        # sibling right after the target
        lost = conflict_copy_text(ctx.current_text)
        idx = ctx.order_idx + 1
        return (ShiftSiblings(ctx.block.page_id, ctx.block.parent_uid, idx),
                InsertBlock(ctx.conflict_uid, ctx.block.page_id,
                            ctx.block.parent_uid, idx, lost, None),
                ReindexRefs(ctx.conflict_uid, lost),
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
