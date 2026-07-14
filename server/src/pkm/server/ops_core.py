# pattern: Functional Core
"""Block-op models and the pure planner that turns each op + a context
snapshot into effect values. The shell (ops_apply) assembles OpContext
from SQLite and executes the effects; planning itself does no I/O."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field

UID_RE = re.compile(r"^[a-zA-Z0-9_-]{6,32}$")
ViewType = Literal["numbered", "document"]


class CreateOp(BaseModel):
    op: Literal["create"]
    uid: str
    page_title: str = Field(min_length=1)
    parent_uid: str | None = None
    order_idx: int
    text: str
    heading: int | None = Field(default=None, ge=1, le=3)
    view_type: ViewType | None = None


class UpdateTextOp(BaseModel):
    op: Literal["update_text"]
    uid: str
    text: str
    # sha256 hex of the text this edit was based on. Absent => legacy
    # client, LWW-apply as always. Present => conflict detection per spec
    # section 2 (text hash, not a version counter: structural changes must
    # never manufacture a text conflict).
    base_text_hash: str | None = Field(default=None, min_length=64,
                                       max_length=64)


class MoveOp(BaseModel):
    op: Literal["move"]
    uid: str
    parent_uid: str | None   # required but nullable: null = top level
    order_idx: int
    # cross-page target when parent_uid is null; must agree with the
    # parent's page when parent_uid is set. None = stay on current page.
    page_title: str | None = Field(default=None, min_length=1)


class DeleteOp(BaseModel):
    op: Literal["delete"]
    uid: str


class SetCollapsedOp(BaseModel):
    op: Literal["set_collapsed"]
    uid: str
    collapsed: bool


class SetHeadingOp(BaseModel):
    op: Literal["set_heading"]
    uid: str
    heading: int | None = Field(default=None, ge=1, le=3)


class SetViewTypeOp(BaseModel):
    op: Literal["set_view_type"]
    uid: str
    view_type: ViewType


class CreatePageOp(BaseModel):
    """Durable push path for offline page creation (spec section 1): an
    empty page created offline has no block op to carry its title, so page
    creation is itself an op -- get_or_create semantics, safely replayable."""
    op: Literal["create_page"]
    page_title: str = Field(min_length=1)


BlockOp = Annotated[Union[CreateOp, UpdateTextOp, MoveOp, DeleteOp,
                          SetCollapsedOp, SetHeadingOp, SetViewTypeOp,
                          CreatePageOp],
                    Field(discriminator="op")]


class OpBatch(BaseModel):
    client_id: str = Field(min_length=1, max_length=64)
    # Durable client queues retry pushes; batch_id makes the retry safe.
    # Absent => pre-offline client, applied unconditionally as before.
    batch_id: str | None = Field(default=None, min_length=8, max_length=64)
    ops: list[BlockOp] = Field(min_length=1, max_length=500)


def batch_request_hash(batch: OpBatch) -> str:
    """Canonical content hash binding a batch_id to one payload forever
    (spec section 1): replay with a different payload is rejected, so a
    buggy client can't silently swap the ops behind an acknowledged id."""
    canon = json.dumps([op.model_dump() for op in batch.ops],
                       sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


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
        return (SetCollapsed(op.uid, op.collapsed),
                TouchPage(ctx.block.page_id))
    if isinstance(op, SetHeadingOp):
        return (SetHeading(op.uid, op.heading), TouchPage(ctx.block.page_id))
    # SetViewTypeOp (the discriminated union admits nothing else)
    return (SetViewType(op.uid, op.view_type), TouchPage(ctx.block.page_id))
