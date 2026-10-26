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
import secrets
from collections.abc import Iterable
from typing import Annotated, Final, Literal, NewType, Union

from pydantic import Field, model_validator
from pkm.contracts.text import WellFormedModel, well_formed

from pkm.contracts.brands import brand
from pkm.contracts.titles import RawTitle

# A block uid's shape, the body of UID_RE below ({6,32}): a run outside it
# can never have been minted, so render.py, export/markdown.py and
# export/resolve.py import this (through pkm.refs) rather than keeping
# their own ((token)) pattern -- a token too long to be a real uid is then
# plain text on every surface, not just here. Web's grammar/scan.ts mirrors
# it by hand.
BLOCK_REF_TOKEN = r"[a-zA-Z0-9_-]{6,32}"

# `\Z` anchors to the true end of the string; a bare `$` also matches just
# before a trailing "\n", which let a uid like "abcdef\n" slip past a
# `.match()` call site that should have refused it. Every call site uses
# `.fullmatch()` regardless, so the anchor is defense in depth, not the
# only guard. Built from `BLOCK_REF_TOKEN` so the wire-validation
# shape and the ((ref))-recognition shape can't drift apart independently.
UID_RE = re.compile(rf"^{BLOCK_REF_TOKEN}\Z")
ViewType = Literal["numbered", "document"]

# A block's heading level; None (kept separate, not part of this alias)
# means plain text. 1-3 only -- the editor offers no deeper levels.
HeadingLevel = Literal[1, 2, 3]

# What a block_rewrites row records; see the table in schema.py.
RewriteKind = Literal["retitle", "unlink", "inline"]

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
# client and the server (both `new_uid`), and
# Roam's own exported uids.
BlockUid = NewType("BlockUid", str)
brand(BlockUid)


def new_uid() -> BlockUid:
    """A fresh random uid: 12 urlsafe chars, matching UID_RE. The alphabet
    includes '-' and '_', which argparse would treat as an option prefix in
    a bare CLI argument, so retry until the first char is alphanumeric."""
    while True:
        uid = secrets.token_urlsafe(9)
        if uid[0].isalnum():
            return BlockUid(uid)


# pages.id. Minted only by SQLite (an INTEGER PRIMARY KEY) and, for an
# import, by the importer's own row-building counter.
PageId = NewType("PageId", int)
brand(PageId)
# sidebar_entries.id -- its own INTEGER PRIMARY KEY, distinct from PageId
# even though a sidebar entry's title always names a page.
SidebarEntryId = NewType("SidebarEntryId", int)
brand(SidebarEntryId)

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

# A block's sparse sibling order key (blocks.order_idx): where it sits
# among its siblings under its parent (or at the page's top level), not a
# dense array position -- a delete leaves a gap rather than renumbering, so
# two siblings' keys are never assumed adjacent. Minted at a create/move op
# arriving on the wire, at the CLI/MCP planner's own op construction
# (planning.py, batch.py), at every blocks.order_idx row read that feeds a
# typed field, and at descendant_copy_effects' dense renumber (ops_core.py).
OrderIdx = NewType("OrderIdx", int)
brand(OrderIdx)

# The widest order key a create or move op may carry on the wire: the JS
# safe-integer range, the most the web can represent. Nothing mints a
# negative key (a position past the end is the last key plus one, and an
# empty group starts at 0), so the range starts at 0. A sibling shift adds
# one per create, so a key this small can never carry it past int64.
MAX_WIRE_ORDER_IDX = 2 ** 53 - 1
WIRE_ORDER_IDX = Field(ge=0, le=MAX_WIRE_ORDER_IDX)

# The deepest level a create or move may put a block at; a top-level block
# is level 1. An outline 255 levels deep made the page, block and journal
# reads answer 500 (pydantic-core's serialiser has a fixed recursion
# guard), so ops_core.plan_op refuses the batch rather than let one be
# built. shared/fixtures/outline_depth.json pins the web's copy equal.
MAX_OUTLINE_DEPTH: Final = 100

# The longest text, in code points (Python `len`), a write may store in one
# block. Export holds a whole block in memory at once, so its peak scales
# with the largest block; every write path refuses a longer one through
# pkm.text_limits. shared/fixtures/text_limits_parity.json pins the web's
# copy equal.
MAX_BLOCK_TEXT_CHARS: Final = 1_000_000

# The deepest `[[` nesting a write may store (refs.link_nesting_depth). The
# web tokenizer recurses once per nested run whose title names no page, plus
# a few emphasis frames, and overflows its stack near 4,100 levels; 32 is a
# product limit with a wide margin under that (real notes nest 2 deep).
# shared/fixtures/text_limits_parity.json pins the web's copy equal.
MAX_LINK_NESTING: Final = 32

# A sidebar entry's order key (sidebar_entries.order_idx): the server
# assigns it and clients reorder by array position, so it never meets block
# order code -- its own brand keeps a block's OrderIdx from standing in for
# it and the reverse.
SidebarOrderIdx = NewType("SidebarOrderIdx", int)
brand(SidebarOrderIdx)


# The changes-journal sequence number (`changes.seq`), distinct from a
# plain int so a reset counter or a local lane seq can never pass as a
# sync cursor. Minted only where a route reads MAX(seq) from the changes
# table (routes_sync.py, routes_ops.py, sync_core.dedupe_window,
# notify.seq_frame); the web's twin brand is `SyncSeq` in
# web/src/api/brands.ts.
SyncSeq = NewType("SyncSeq", int)
brand(SyncSeq)
# The cursor before any journal row: a client that has synced nothing.
NO_SEQ = SyncSeq(0)


class CreateOp(WellFormedModel):
    op: Literal["create"]
    uid: BlockUid
    # the page for a top-level create (created if absent). Under a live
    # parent the block lands on the parent's page and this is ignored:
    # another device may have moved the parent since the op was queued.
    page_title: RawTitle = Field(min_length=1)
    parent_uid: BlockUid | None = None
    order_idx: OrderIdx = WIRE_ORDER_IDX
    text: str
    heading: HeadingLevel | None = None
    view_type: ViewType | None = None


class UpdateTextOp(WellFormedModel):
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
    page_title: RawTitle | None = None


class MoveOp(WellFormedModel):
    op: Literal["move"]
    uid: BlockUid
    parent_uid: BlockUid | None   # required but nullable: null = top level
    order_idx: OrderIdx = WIRE_ORDER_IDX
    # cross-page target when parent_uid is null; ignored when parent_uid
    # is set, since the block follows its parent to whatever page that is
    # on now. None = stay on current page.
    page_title: RawTitle | None = Field(default=None, min_length=1)


class DeleteOp(WellFormedModel):
    op: Literal["delete"]
    uid: BlockUid
    # sha256 of the subtree this delete was based on (offline-editing-design.md
    # §1): the (uid, text) pairs of the block and its descendants, as of the
    # tree the deleting device last saw. Absent => legacy client or a uid the
    # batch itself created, LWW-apply as always (plain delete, no conflict
    # copy). Present => the server compares against its own current subtree; on
    # a mismatch the delete still wins, but first the subtree's texts land as a
    # conflict copy on today's daily page, so text another device wrote is never
    # silently destroyed.
    base_subtree_hash: Sha256Hex | None = Field(default=None, min_length=64,
                                                 max_length=64)


class SetCollapsedOp(WellFormedModel):
    op: Literal["set_collapsed"]
    uid: BlockUid
    collapsed: bool


class SetHeadingOp(WellFormedModel):
    op: Literal["set_heading"]
    uid: BlockUid
    heading: HeadingLevel | None = None


class SetViewTypeOp(WellFormedModel):
    op: Literal["set_view_type"]
    uid: BlockUid
    view_type: ViewType


class CreatePageOp(WellFormedModel):
    """Durable push path for offline page creation (offline-editing-design.md
    §1): an empty page created offline has no block op to carry its title, so
    page creation is itself an op -- get_or_create semantics, safely
    replayable."""
    op: Literal["create_page"]
    page_title: RawTitle = Field(min_length=1)


BlockOp = Annotated[Union[CreateOp, UpdateTextOp, MoveOp, DeleteOp,
                          SetCollapsedOp, SetHeadingOp, SetViewTypeOp,
                          CreatePageOp],
                    Field(discriminator="op")]


# The most ops one batch carries; the assistant's approval card refuses a
# longer batch before it builds a row for each.
MAX_OPS_PER_BATCH = 500


ExpectKind = Literal["text", "subtree", "absent"]


class ExpectedBlock(WellFormedModel):
    uid: BlockUid
    kind: ExpectKind
    # text_hash of the text ("text") or subtree_hash of the subtree
    # ("subtree") as the approval card showed it; None for "absent".
    shown_hash: Sha256Hex | None = Field(default=None, min_length=64,
                                         max_length=64)

    @model_validator(mode="after")
    def _hash_iff_not_absent(self) -> "ExpectedBlock":
        if (self.shown_hash is None) != (self.kind == "absent"):
            raise ValueError(
                "shown_hash is required unless kind is absent, and must be"
                " null then")
        return self


class OpBatch(WellFormedModel):
    client_id: ClientId = Field(min_length=1, max_length=64)
    # Required: id-less batches cannot be
    # deduplicated, so any retry or replay re-applies. Pre-offline clients
    # now fail loudly (422) instead of corrupting silently.
    batch_id: BatchId = Field(min_length=8, max_length=64)
    ops: list[BlockOp] = Field(min_length=1, max_length=MAX_OPS_PER_BATCH)
    # The client's sync cursor when the batch's ops were built; absent means
    # built against current server state.
    seen_seq: SyncSeq | None = Field(default=None, ge=SyncSeq(0))
    # Blocks that must still be as an approval card showed them for the
    # batch to apply; checked before any op runs. Not part of the
    # idempotency hashes, which cover ops only.
    expect: list[ExpectedBlock] = Field(default_factory=list,
                                        max_length=MAX_OPS_PER_BATCH)

    @model_validator(mode="after")
    def _expect_uids_unique(self) -> "OpBatch":
        uids = [e.uid for e in self.expect]
        if len(set(uids)) != len(uids):
            raise ValueError("expect names a uid more than once")
        return self


def text_hash(text: str) -> Sha256Hex:
    """sha256 of `text`'s UTF-8, read as the web's TextEncoder reads it: a
    lone surrogate hashes as U+FFFD (see pkm.contracts.text). Total, so a
    text from anywhere (a stored row, a CLI argument) hashes as it would
    once it went through the contract."""
    return Sha256Hex(hashlib.sha256(well_formed(text).encode()).hexdigest())


def subtree_hash(pairs: Iterable[tuple[str, str]]) -> Sha256Hex:
    """Canonical hash of a subtree's (uid, text) pairs, order-independent
    (offline-editing-design.md §1). Each text is hashed on its own rather than
    JSON-encoding the pairs, because Python and JS escape JSON strings
    differently -- text_hash / sha256Hex already agree. Uids are ASCII
    (UID_RE), so both languages' default sorts agree too."""
    canon = "\n".join(f"{uid} {text_hash(text)}" for uid, text in sorted(pairs))
    return Sha256Hex(hashlib.sha256(well_formed(canon).encode()).hexdigest())
