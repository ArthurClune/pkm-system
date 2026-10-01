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

from pkm.contracts.brands import brand
from pkm.refs import BLOCK_REF_TOKEN

# `\Z` anchors to the true end of the string; a bare `$` also matches just
# before a trailing "\n", which let a uid like "abcdef\n" slip past a
# `.match()` call site that should have refused it. Every call site uses
# `.fullmatch()` regardless, so the anchor is defense in depth, not the
# only guard. Built from `refs.BLOCK_REF_TOKEN` so the wire-validation
# shape and the ((ref))-recognition shape can't drift apart independently.
UID_RE = re.compile(rf"^{BLOCK_REF_TOKEN}\Z")
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
# its base type, so the wire format is unchanged; `brand` carries the name
# to the web's generated types. Minted by `text_hash`/`subtree_hash` (and
# their web twin `sha256Hex`), by `assets_core.sha256_hex` for
# content-addressed asset files, and by `title_migration._plan_digest`; a
# test literal standing in for a hash wraps in `Sha256Hex(...)`.
Sha256Hex = NewType("Sha256Hex", str)
brand(Sha256Hex)

# The shape every Sha256Hex value must have on the wire: 64 lowercase hex
# characters, nothing else. `\Z` anchors to the true end of the string for
# the same reason UID_RE does above; call sites use `.fullmatch()`
# regardless. Shared so an asset sha arriving as a route param (which, unlike
# a pydantic body field, gets no Field(pattern=...) for free) validates
# against the same shape everywhere, rather than each route re-declaring its
# own copy. Pydantic's own pattern validator uses a different regex engine
# that rejects `\Z` (see TitleMigrationApplyRequest.audit_digest), so a
# body field still spells its pattern out as a plain `$`-anchored string.
SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}\Z")

# A block's uid: validated against UID_RE above wherever one is minted or
# looked up, not on every value this type touches -- a BlockUid arriving
# on the wire (CreateOp.uid etc.) is shape-checked only on a create
# (ops_core.plan_op) or a skipped op (ops_core.impossible_uid_reason); an
# op addressing an existing block never re-checks its uid's shape. Minted
# by the web (web/src/uid.ts's newUid, most uids in practice), the CLI/MCP
# client (client.api.new_uid), the server (ops_apply._new_uid), and
# Roam's own exported uids. Not brand()ed: pydantic validates and dumps a
# NewType as its base type regardless, so the wire format is unchanged,
# but the generated TypeScript still sees a plain string.
BlockUid = NewType("BlockUid", str)
# pages.id. Minted only by SQLite (an INTEGER PRIMARY KEY) and, for an
# import, by the importer's own row-building counter.
PageId = NewType("PageId", int)
# sidebar_entries.id -- its own INTEGER PRIMARY KEY, distinct from PageId
# even though a sidebar entry's title always names a page.
SidebarEntryId = NewType("SidebarEntryId", int)

# The per-tab sync identity (web's sync/opQueue.ts `clientId`, minted once
# per tab) and the replay-dedup key shared by an OpBatch and the pending_ops
# row it came from (web's `batchId`, the CLI/MCP's `_batch_id`). Both are
# bare uid-shaped strings minted by the same web newUid() and placed next to
# each other in one request body -- distinct NewTypes so the two can never
# swap at a call site. batch_id is also the primary key of applied_batches
# (schema.py), read back there as a plain str dedupe lookup, never
# re-validated as this type.
ClientId = NewType("ClientId", str)
brand(ClientId)

BatchId = NewType("BatchId", str)
brand(BatchId)


class CreateOp(BaseModel):
    op: Literal["create"]
    uid: BlockUid
    # the page for a top-level create (created if absent). Under a live
    # parent the block lands on the parent's page and this is ignored:
    # another device may have moved the parent since the op was queued.
    page_title: str = Field(min_length=1)
    parent_uid: BlockUid | None = None
    order_idx: int
    text: str
    heading: HeadingLevel | None = None
    view_type: ViewType | None = None


class UpdateTextOp(BaseModel):
    op: Literal["update_text"]
    uid: BlockUid
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
    uid: BlockUid
    parent_uid: BlockUid | None   # required but nullable: null = top level
    order_idx: int
    # cross-page target when parent_uid is null; ignored when parent_uid
    # is set, since the block follows its parent to whatever page that is
    # on now. None = stay on current page.
    page_title: str | None = Field(default=None, min_length=1)


class DeleteOp(BaseModel):
    op: Literal["delete"]
    uid: BlockUid
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
    uid: BlockUid
    collapsed: bool


class SetHeadingOp(BaseModel):
    op: Literal["set_heading"]
    uid: BlockUid
    heading: HeadingLevel | None = None


class SetViewTypeOp(BaseModel):
    op: Literal["set_view_type"]
    uid: BlockUid
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
    client_id: ClientId = Field(min_length=1, max_length=64)
    # Required: id-less batches cannot be
    # deduplicated, so any retry or replay re-applies. Pre-offline clients
    # now fail loudly (422) instead of corrupting silently.
    batch_id: BatchId = Field(min_length=8, max_length=64)
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
