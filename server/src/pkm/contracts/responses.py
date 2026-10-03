# pattern: Functional Core
"""Pydantic models describing the JSON route contracts. Most are declared as
`response_model=` on read routes so the shapes reach OpenAPI and, from there,
web/src/api/types.d.ts. The routes still return plain dicts of the same shape;
these models are the contract, not a payload redesign.

They are also what `PkmClient` validates every response with, so a payload
that drifts from this file fails on the client with a named field rather
than as a KeyError inside a renderer.

Keep every field required (no defaults): the routes always populate them, and
optionality here would surface as `?:` in the generated TypeScript."""
from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Annotated, Literal, NewType

from pydantic import BaseModel, BeforeValidator, Field

from pkm.changed import ChangeStatus
from pkm.contracts.brands import brand
from pkm.contracts.ops import (BatchId, BlockUid, HeadingLevel, OpKind, OrderIdx,
                               PageId, Sha256Hex, SidebarEntryId, ViewType)
from pkm.goodlinks import GoodlinksId
from pkm.refs import CanonicalTitle, RefKind


def _roam_heading_zero_as_none(value: object) -> object:
    """Roam's export writes :block/heading 0 for "no heading"; older
    imports stored it as-is, and some of those rows are still live. 0
    means the same thing a null heading means everywhere else, so a
    stored 0 reads as None rather than failing Literal[1,2,3] validation.
    Nothing on the write path can produce a 0 (CreateOp/SetHeadingOp.heading
    only accepts 1-3 or null), so this is a read-side-only accommodation."""
    return None if value == 0 else value


# Only for a field read back out of SQLite, never for a client-supplied
# write (CreateOp/SetHeadingOp keep plain HeadingLevel | None).
StoredHeading = Annotated[HeadingLevel | None,
                         BeforeValidator(_roam_heading_zero_as_none)]


class PageMeta(BaseModel):
    id: PageId
    title: CanonicalTitle
    created_at: int | None
    updated_at: int | None


class BlockNode(BaseModel):
    uid: BlockUid
    text: str
    heading: StoredHeading
    view_type: ViewType | None
    collapsed: bool
    order_idx: OrderIdx
    created_at: int | None
    updated_at: int | None
    children: list[BlockNode]


def walk_blocks(nodes: Sequence[BlockNode]) -> Iterator[BlockNode]:
    """Every block in a page's tree, in document (pre-)order. Lives with
    the model rather than with either of the two callers that search a
    fetched page -- the planners and the renderers -- which had a private
    copy each."""
    for n in nodes:
        yield n
        yield from walk_blocks(n.children)


class BacklinkItem(BaseModel):
    uid: BlockUid
    text: str
    breadcrumbs: list[str]


class BacklinkGroup(BaseModel):
    page_id: PageId
    page_title: CanonicalTitle
    items: list[BacklinkItem]


class Backlinks(BaseModel):
    groups: list[BacklinkGroup]
    total_pages: int
    offset: int
    limit: int


class BlockBacklinksPayload(BaseModel):
    """GET /api/block/{uid}/backlinks: every block referencing ((uid)),
    grouped like page backlinks. Unpaginated by design -- counts are small
    and nothing user-visible truncates silently."""
    groups: list[BacklinkGroup]


class BlockRefText(BaseModel):
    text: str
    page_title: CanonicalTitle


class BlockRefsPayload(BaseModel):
    """GET /api/block-refs: on-demand ((uid)) resolution."""
    block_ref_texts: dict[BlockUid, BlockRefText]


class PagePayload(BaseModel):
    page: PageMeta
    blocks: list[BlockNode]
    backlinks: Backlinks
    block_ref_texts: dict[BlockUid, BlockRefText]
    block_ref_counts: dict[BlockUid, int]


class RenamePageResponse(BaseModel):
    """POST /api/page/{title}/rename: which branch ran, and the title the
    page now lives under (normalized, so it can differ from the requested
    one). `result` is a Literal so the web client can switch on it."""
    result: Literal["renamed", "merged"]
    title: CanonicalTitle


class GroupItem(BaseModel):
    uid: BlockUid
    text: str


class BlockGroup(BaseModel):
    page_id: PageId
    page_title: CanonicalTitle
    items: list[GroupItem]


class GroupsPayload(BaseModel):
    """Shared by /api/unlinked and /api/todos."""
    groups: list[BlockGroup]
    total: int


class QueryPayload(GroupsPayload):
    """GET /api/query: groups plus per-operand match counts so an empty
    result is steerable (bad query shape vs genuinely nothing)."""
    ref_counts: dict[CanonicalTitle, int]


class ChangedItem(BaseModel):
    uid: BlockUid
    text: str
    created_at: int | None
    updated_at: int | None
    status: ChangeStatus


class ChangedGroup(BaseModel):
    page_id: PageId
    page_title: CanonicalTitle
    items: list[ChangedItem]


class ChangedPayload(BaseModel):
    """GET /api/changed: blocks whose updated_at falls in [since, until),
    grouped by page in the order each page was first touched. `since`/
    `until` echo the resolved window (epoch ms) so a caller can see what
    was actually queried, not just what it asked for."""
    groups: list[ChangedGroup]
    total: int
    since: int
    until: int


class JournalDay(BaseModel):
    """One day of the journal scroll, complete: the day renders from this
    alone. `backlinks` is a preview page of the day's linked references
    -- carried here because fetching them per day turned a scroll
    of N days into N page reads."""

    date: str
    title: CanonicalTitle
    exists: bool
    blocks: list[BlockNode]
    backlinks: Backlinks


class JournalPayload(BaseModel):
    days: list[JournalDay]
    block_ref_texts: dict[BlockUid, BlockRefText]
    block_ref_counts: dict[BlockUid, int]


class CurrentWorkPage(BaseModel):
    id: PageId
    title: CanonicalTitle
    updated_at: int


class CurrentWorkSection(BaseModel):
    id: str
    title: str
    pages: list[CurrentWorkPage]


class CurrentWorkPayload(BaseModel):
    sections: list[CurrentWorkSection]


class SearchPageHit(BaseModel):
    id: PageId
    title: CanonicalTitle


class SearchBlockHit(BaseModel):
    uid: BlockUid
    page_title: CanonicalTitle
    snippet: str


class SearchPayload(BaseModel):
    pages: list[SearchPageHit]
    blocks: list[SearchBlockHit]


class TitlesPayload(BaseModel):
    titles: list[CanonicalTitle]


class SidebarNavEntry(BaseModel):
    id: SidebarEntryId
    title: CanonicalTitle


class SidebarNavPayload(BaseModel):
    entries: list[SidebarNavEntry]


class AssetUploadResponse(BaseModel):
    sha256: Sha256Hex
    filename: str
    mime: str
    size: int
    url: str
    existing: bool


class AssetRef(BaseModel):
    uid: BlockUid
    page_title: CanonicalTitle


class AssetSearchItem(BaseModel):
    sha256: Sha256Hex
    filename: str
    mime: str
    size: int
    created_at: int | None
    url: str
    description: str | None
    status: Literal["described", "failed", "pending"]
    describe_error: str | None
    refs: list[AssetRef]


class AssetSearchPayload(BaseModel):
    total: int
    assets: list[AssetSearchItem]


class DescribeStatusPayload(BaseModel):
    enabled: bool
    reason: str | None


class ScanPayload(BaseModel):
    queued: int
    enabled: bool
    reason: str | None


class LocalCheckProblem(BaseModel):
    uid: BlockUid
    page: CanonicalTitle
    href: str
    status: Literal["missing", "evicted", "invalid"]


class LocalCheckPayload(BaseModel):
    """GET /api/local/check: every /api/local/ href found in block text,
    classified against the disk. `enabled` is False when no
    local_docs_root is configured."""
    enabled: bool
    total: int
    ok: int
    problems: list[LocalCheckProblem]


class GoodlinksResolveRequest(BaseModel):
    """POST /api/goodlinks/resolve body. `save` lets the slash command add
    a page GoodLinks does not have yet; the migration script never sets it."""
    url: str = Field(min_length=1, max_length=2000)
    save: bool = False


class GoodlinksLink(BaseModel):
    """POST /api/goodlinks/resolve: the GoodLinks link a URL resolved to.
    `created` is True when the request saved it just now."""
    id: GoodlinksId
    title: str
    url: str
    added_at: str
    created: bool


class GoodlinksArticle(BaseModel):
    """GET /api/goodlinks/{link_id}: metadata plus the sanitised reader HTML
    in one payload, so the reader overlay makes a single request."""
    id: GoodlinksId
    title: str
    url: str
    added_at: str
    html: str


class GoodlinksCheckProblem(BaseModel):
    uid: BlockUid
    page: CanonicalTitle
    href: str
    status: Literal["missing", "invalid"]


class GoodlinksCheckPayload(BaseModel):
    """GET /api/goodlinks/check: every /api/goodlinks/ href found in block
    text, checked against the GoodLinks library. `enabled` is False when
    no API key is configured."""
    enabled: bool
    total: int
    ok: int
    problems: list[GoodlinksCheckProblem]

class SyncRef(BaseModel):
    target_page_id: PageId
    kind: RefKind


class SyncBlock(BaseModel):
    uid: BlockUid
    page_id: PageId
    parent_uid: BlockUid | None
    order_idx: OrderIdx
    text: str
    heading: StoredHeading
    view_type: ViewType | None
    collapsed: int
    created_at: int | None
    updated_at: int | None
    refs: list[SyncRef]


class SyncPage(BaseModel):
    id: PageId
    title: CanonicalTitle
    created_at: int | None
    updated_at: int | None


class SyncSidebarEntry(BaseModel):
    id: SidebarEntryId
    title: CanonicalTitle
    order_idx: int


# The changes-journal sequence number (`changes.seq`), distinct from a
# plain int so a reset counter or a local lane seq can never pass as a
# sync cursor. Minted only where a route reads MAX(seq) from the changes
# table (routes_sync.py, routes_ops.py, sync_core.dedupe_window,
# notify.seq_frame); the web's twin brand is `SyncSeq` in
# web/src/api/brands.ts.
SyncSeq = NewType("SyncSeq", int)
brand(SyncSeq)


# Matches the changes table's CHECK(kind IN (...)) in schema.py.
EntityKind = Literal["block", "page", "sidebar"]


class SyncTombstone(BaseModel):
    kind: EntityKind
    entity_id: str


class AppliedBatch(BaseModel):
    """One of the client's pending batches (the `pending` query param of
    /api/sync/changes and /api/sync/snapshot) that the payload already holds:
    its applied_batches row is in the same read transaction that hydrated the
    payload, and a batch's writes commit with that row. `seq` and `skipped`
    are its stored ack's, read through OpsAck, so an ack stored before those
    fields existed reads as None / []."""
    batch_id: BatchId
    seq: SyncSeq | None
    skipped: list[SkippedOp]


class ChangesPayload(BaseModel):
    reset: bool = False
    generation: str
    plain_space_title_canonicalization: bool
    next_since: SyncSeq
    latest_seq: SyncSeq
    pages: list[SyncPage]
    blocks: list[SyncBlock]
    sidebar: list[SyncSidebarEntry]
    tombstones: list[SyncTombstone]
    # The second exception to "keep every field required", like OpsAck's
    # seq/skipped: a client must also read a server that predates the field,
    # so the generated TypeScript marks it optional. Empty when the request
    # named no pending batches.
    applied_batches: list[AppliedBatch] = Field(default_factory=list)


class BlockPayload(BaseModel):
    """GET /api/block/{uid}: one block's subtree with page context."""
    page: PageMeta
    block: BlockNode
    breadcrumbs: list[str]
    block_ref_texts: dict[BlockUid, BlockRefText]


class SnapshotPayload(BaseModel):
    generation: str
    plain_space_title_canonicalization: bool
    seq: SyncSeq
    pages: list[SyncPage]
    blocks: list[SyncBlock]
    sidebar: list[SyncSidebarEntry]
    # optional for the same reason as ChangesPayload.applied_batches
    applied_batches: list[AppliedBatch] = Field(default_factory=list)


# The three Claude aliases plus z.ai's GLM. Lives here (not
# assistant/policy.py) so the policy module -- which also needs it -- can
# import it without the contracts package depending on assistant.
AssistantModel = Literal["sonnet", "opus", "haiku", "glm"]

# Both live here, not in assistant/service.py or assistant/events.py, for the
# same reason AssistantModel does: assistant/* already depends on contracts,
# and a NewType used by a pydantic field needs to be importable without that
# dependency running backwards.
#
# ConversationId is minted once, in AssistantService.create (secrets.token_hex).
ConversationId = NewType("ConversationId", str)
brand(ConversationId)
# ConfirmId is minted once per pending tool confirmation, in
# ClaudeConversation.can_use_tool -- a local counter, not the Claude Agent
# SDK's own tool_use id (a different value entirely, on ToolUseBlock/
# ToolResultBlock), which the field used to be misnamed after.
ConfirmId = NewType("ConfirmId", str)
brand(ConfirmId)


class AssistantConversation(BaseModel):
    id: ConversationId
    model: AssistantModel


class AssistantAck(BaseModel):
    ok: bool = True


class AssistantModels(BaseModel):
    models: list[AssistantModel]
    default: AssistantModel


class TitleMigrationPage(BaseModel):
    page_id: PageId
    title: CanonicalTitle


class TitleMigrationBlocker(BaseModel):
    page_id: PageId
    title: CanonicalTitle
    reason: Literal["all_space", "forbidden_syntax"]


class TitleMigrationGroup(BaseModel):
    canonical_title: CanonicalTitle
    survivor: TitleMigrationPage
    sources: list[TitleMigrationPage]
    has_clean_twin: bool
    block_count: int
    inbound_ref_count: int
    sidebar_count: int


class TitleMigrationAuditPayload(BaseModel):
    active: bool
    digest: Sha256Hex
    groups: list[TitleMigrationGroup]
    blockers: list[TitleMigrationBlocker]


class TitleMigrationApplyRequest(BaseModel):
    # Same 64-lowercase-hex shape as contracts.ops.SHA256_HEX_RE, spelled
    # out again rather than shared: pydantic's pattern validator uses a
    # regex engine that rejects SHA256_HEX_RE's `\Z` anchor, so a body
    # field's pattern stays a plain `$`-anchored string.
    audit_digest: Sha256Hex = Field(pattern=r"^[0-9a-f]{64}$")


class TitleMigrationApplyResponse(BaseModel):
    digest: Sha256Hex
    groups_applied: int
    pages_retitled: int
    pages_merged: int
    blocks_moved: int
    blocks_rewritten: int
    generation: str


# -- Write acks ----------------------------------------------------------
#
# `AssetDeleteAck` is NOT declared as `response_model=` on its route, and
# should not be: no generated client reads it, so attaching it would add a
# component to the published OpenAPI schema for nothing. It exists because
# the CLI/MCP client does read it -- `applied` is printed as "applied N
# ops" on the sibling ack below -- and reading it through a model is what
# makes the read type-checked. tests/test_client_contracts.py asserts it
# still matches what its live route returns, which is the thing a
# `response_model` would otherwise have enforced.
#
# `OpsAck` IS the `response_model` of POST /api/ops: the web reads its
# `seq` and `skipped` through the generated TypeScript type, and a
# replayed stored ack passes through it too, so an ack stored before
# `seq` existed reaches the wire as `seq: null` (the client reads that as
# unknown, so refetches).

SkipReason = Literal["block_not_found", "parent_not_found", "cycle"]


class SkippedOp(BaseModel):
    """One op the server skipped because its block (or, for create/move,
    its parent) no longer exists, or because a move would nest the block
    under itself or its own descendant (`ops_core.skip_report`)."""
    index: int
    op: OpKind
    uid: BlockUid
    reason: SkipReason
    # the daily page the op's note or lost text landed on; None when
    # nothing was written (a collapse/delete no-op, a blank text)
    note_page: CanonicalTitle | None


class OpsAck(BaseModel):
    """POST /api/ops (routes_ops.py)."""
    ok: bool
    ts: int
    # every op processed, skipped ones included
    applied: int
    # The journal max as of this batch's commit. None for an ack stored (and
    # so replayed verbatim) before the field existed. These two fields are
    # the one exception to this module's "keep every field required" rule:
    # acks stored before they existed have to validate, so the generated
    # TypeScript marks them optional, and the web reader tolerates their
    # absence.
    seq: SyncSeq | None = None
    # Empty for an ack stored before the field existed, same as for a batch
    # that skipped nothing.
    skipped: list[SkippedOp] = Field(default_factory=list)


class AssetDeleteAck(BaseModel):
    """DELETE /api/assets/{sha256} (routes_assets.py)."""
    deleted: bool
    refs_removed: int
