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
from collections.abc import Iterable
from typing import Annotated, Literal, NewType, Union

from pydantic import BaseModel, Field

UID_RE = re.compile(r"^[a-zA-Z0-9_-]{6,32}$")
ViewType = Literal["numbered", "document"]

# A block's heading level; None (kept separate, not part of this alias)
# means plain text. 1-3 only -- the editor offers no deeper levels.
HeadingLevel = Literal[1, 2, 3]

# Every BlockOp's `op` discriminator, widened back to a plain union for
# contexts (SkippedOp.op) that report on an op without being one -- each
# per-op class below still pins its own single-value Literal, which is
# what the discriminated union in BlockOp actually dispatches on.
OpKind = Literal["create", "update_text", "move", "delete", "set_collapsed",
                 "set_heading", "set_view_type", "create_page"]

# A sha256 hex digest, distinct from a plain str so a text can never be
# passed where a hash belongs. Pydantic validates and dumps a NewType as
# its base type, so the wire format is unchanged. Minted only by
# `text_hash` (and its web twin `sha256Hex`); a test literal standing in
# for a hash wraps in `Sha256Hex(...)`.
Sha256Hex = NewType("Sha256Hex", str)


class CreateOp(BaseModel):
    op: Literal["create"]
    uid: str
    # the page for a top-level create (created if absent). Under a live
    # parent the block lands on the parent's page and this is ignored:
    # another device may have moved the parent since the op was queued.
    page_title: str = Field(min_length=1)
    parent_uid: str | None = None
    order_idx: int
    text: str
    heading: HeadingLevel | None = None
    view_type: ViewType | None = None


class UpdateTextOp(BaseModel):
    op: Literal["update_text"]
    uid: str
    text: str
    # sha256 hex of the text this edit was based on. Absent => legacy
    # client, LWW-apply as always. Present => conflict detection per spec
    # section 2 (text hash, not a version counter: structural changes must
    # never manufacture a text conflict).
    base_text_hash: Sha256Hex | None = Field(default=None, min_length=64,
                                              max_length=64)
    # A conflict-header label only: names the page the client believed it
    # was editing, for when the block itself is gone by the time this
    # lands (edit-vs-delete race). Never checked against the target block
    # and never validated as a title -- an unusable hint just falls back
    # to a generic label, it can never fail the op.
    page_title: str | None = None


class MoveOp(BaseModel):
    op: Literal["move"]
    uid: str
    parent_uid: str | None   # required but nullable: null = top level
    order_idx: int
    # cross-page target when parent_uid is null; ignored when parent_uid
    # is set, since the block follows its parent to whatever page that is
    # on now. None = stay on current page.
    page_title: str | None = Field(default=None, min_length=1)


class DeleteOp(BaseModel):
    op: Literal["delete"]
    uid: str
    # sha256 of the subtree this delete was based on (spec section 1):
    # the (uid, text) pairs of the block and its descendants, as of the
    # tree the deleting device last saw. Absent => legacy client or a uid
    # the batch itself created, LWW-apply as always (plain delete, no
    # conflict copy). Present => the server compares against its own
    # current subtree; on a mismatch the delete still wins, but first the
    # subtree's texts land as a conflict copy on today's daily page, so
    # text another device wrote is never silently destroyed.
    base_subtree_hash: Sha256Hex | None = Field(default=None, min_length=64,
                                                 max_length=64)


class SetCollapsedOp(BaseModel):
    op: Literal["set_collapsed"]
    uid: str
    collapsed: bool


class SetHeadingOp(BaseModel):
    op: Literal["set_heading"]
    uid: str
    heading: HeadingLevel | None = None


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
    # Required: id-less batches cannot be
    # deduplicated, so any retry or replay re-applies. Pre-offline clients
    # now fail loudly (422) instead of corrupting silently.
    batch_id: str = Field(min_length=8, max_length=64)
    ops: list[BlockOp] = Field(min_length=1, max_length=500)


def text_hash(text: str) -> Sha256Hex:
    return Sha256Hex(hashlib.sha256(text.encode()).hexdigest())


def subtree_hash(pairs: Iterable[tuple[str, str]]) -> Sha256Hex:
    """Canonical hash of a subtree's (uid, text) pairs, order-independent
    (spec section 1). Each text is hashed on its own rather than
    JSON-encoding the pairs, because Python and JS escape JSON strings
    differently -- text_hash / sha256Hex already agree. Uids are ASCII
    (UID_RE), so both languages' default sorts agree too."""
    canon = "\n".join(f"{uid} {text_hash(text)}" for uid, text in sorted(pairs))
    return Sha256Hex(hashlib.sha256(canon.encode()).hexdigest())
