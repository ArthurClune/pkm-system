# pattern: Functional Core
"""The write contract: the block ops POST /api/ops accepts, as pydantic
models. Clients (the web app's sync queue, the CLI/MCP planners) build
them; the server validates the same models on the way in, so one
definition fixes the wire format for both.

Deliberately holds no planning or persistence logic -- that lives in
`pkm.server.ops_core`, which imports these. `text_hash` is here because
both halves must agree on how `base_text_hash` is computed for the
concurrent-edit guard to mean anything."""
from __future__ import annotations

import hashlib
import re
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
    # Required since 2026-07-22 (bean pkm-ri5b): id-less batches cannot be
    # deduplicated, so any retry or replay re-applies. Pre-offline clients
    # now fail loudly (422) instead of corrupting silently.
    batch_id: str = Field(min_length=8, max_length=64)
    ops: list[BlockOp] = Field(min_length=1, max_length=500)


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()
