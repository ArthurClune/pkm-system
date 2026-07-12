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


class CreateOp(BaseModel):
    op: Literal["create"]
    uid: str
    page_title: str = Field(min_length=1)
    parent_uid: str | None = None
    order_idx: int
    text: str
    heading: int | None = Field(default=None, ge=1, le=3)


class UpdateTextOp(BaseModel):
    op: Literal["update_text"]
    uid: str
    text: str


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


BlockOp = Annotated[Union[CreateOp, UpdateTextOp, MoveOp, DeleteOp,
                          SetCollapsedOp, SetHeadingOp],
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
               DeleteBlocks, SetCollapsed, SetHeading, ReindexRefs, TouchPage,
               SetPageId]


def plan_op(index: int, op: BlockOp, ctx: OpContext) -> tuple[Effect, ...]:
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
                            op.text, op.heading),
                ReindexRefs(op.uid, op.text),
                TouchPage(ctx.page_id))
    if ctx.block is None:
        raise OpError(index, f"block not found: {op.uid}")
    if isinstance(op, UpdateTextOp):
        return (UpdateText(op.uid, op.text),
                ReindexRefs(op.uid, op.text),
                TouchPage(ctx.block.page_id))
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
    # SetHeadingOp (the discriminated union admits nothing else)
    return (SetHeading(op.uid, op.heading), TouchPage(ctx.block.page_id))
