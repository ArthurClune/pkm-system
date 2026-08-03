# pattern: Functional Core
"""Pydantic models describing the JSON route contracts. Most are declared as
`response_model=` on read routes so the shapes reach OpenAPI and, from there,
web/src/api/types.d.ts. The routes still return plain dicts of the same shape;
these models are the contract, not a payload redesign.

They are also what `PkmClient` validates every response with, so a payload
that drifts from this file fails on the client with a named field rather
than as a KeyError inside a renderer (pkm-0wr8).

Keep every field required (no defaults): the routes always populate them, and
optionality here would surface as `?:` in the generated TypeScript."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from pkm.contracts.ops import ViewType


class PageMeta(BaseModel):
    id: int
    title: str
    created_at: int | None
    updated_at: int | None


class BlockNode(BaseModel):
    uid: str
    text: str
    heading: int | None
    view_type: ViewType | None
    collapsed: bool
    order_idx: int
    created_at: int | None
    updated_at: int | None
    children: list[BlockNode]


class BacklinkItem(BaseModel):
    uid: str
    text: str
    breadcrumbs: list[str]


class BacklinkGroup(BaseModel):
    page_id: int
    page_title: str
    items: list[BacklinkItem]


class Backlinks(BaseModel):
    groups: list[BacklinkGroup]
    total_pages: int
    offset: int
    limit: int


class BlockRefText(BaseModel):
    text: str
    page_title: str


class BlockRefsPayload(BaseModel):
    """GET /api/block-refs: on-demand ((uid)) resolution."""
    block_ref_texts: dict[str, BlockRefText]


class PagePayload(BaseModel):
    page: PageMeta
    blocks: list[BlockNode]
    backlinks: Backlinks
    block_ref_texts: dict[str, BlockRefText]


class RenamePageResponse(BaseModel):
    """POST /api/page/{title}/rename: which branch ran, and the title the
    page now lives under (normalized, so it can differ from the requested
    one). `result` is a Literal so the web client can switch on it."""
    result: Literal["renamed", "merged"]
    title: str


class GroupItem(BaseModel):
    uid: str
    text: str


class BlockGroup(BaseModel):
    page_id: int
    page_title: str
    items: list[GroupItem]


class GroupsPayload(BaseModel):
    """Shared by /api/unlinked and /api/todos."""
    groups: list[BlockGroup]
    total: int


class QueryPayload(GroupsPayload):
    """GET /api/query: groups plus per-operand match counts so an empty
    result is steerable (bad query shape vs genuinely nothing)."""
    ref_counts: dict[str, int]


class JournalDay(BaseModel):
    date: str
    title: str
    exists: bool
    blocks: list[BlockNode]


class JournalPayload(BaseModel):
    days: list[JournalDay]
    block_ref_texts: dict[str, BlockRefText]


class CurrentWorkPage(BaseModel):
    id: int
    title: str
    updated_at: int


class CurrentWorkSection(BaseModel):
    id: str
    title: str
    pages: list[CurrentWorkPage]


class CurrentWorkPayload(BaseModel):
    sections: list[CurrentWorkSection]


class SearchPageHit(BaseModel):
    id: int
    title: str


class SearchBlockHit(BaseModel):
    uid: str
    page_title: str
    snippet: str


class SearchPayload(BaseModel):
    pages: list[SearchPageHit]
    blocks: list[SearchBlockHit]


class TitlesPayload(BaseModel):
    titles: list[str]


class SidebarNavEntry(BaseModel):
    id: int
    title: str


class SidebarNavPayload(BaseModel):
    entries: list[SidebarNavEntry]


class AssetUploadResponse(BaseModel):
    sha256: str
    filename: str
    mime: str
    size: int
    url: str
    existing: bool


class AssetRef(BaseModel):
    uid: str
    page_title: str


class AssetSearchItem(BaseModel):
    sha256: str
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


class SyncRef(BaseModel):
    target_page_id: int
    kind: str


class SyncBlock(BaseModel):
    uid: str
    page_id: int
    parent_uid: str | None
    order_idx: int
    text: str
    heading: int | None
    view_type: ViewType | None
    collapsed: int
    created_at: int | None
    updated_at: int | None
    refs: list[SyncRef]


class SyncPage(BaseModel):
    id: int
    title: str
    created_at: int | None
    updated_at: int | None


class SyncSidebarEntry(BaseModel):
    id: int
    title: str
    order_idx: int


class SyncTombstone(BaseModel):
    kind: str
    entity_id: str


class ChangesPayload(BaseModel):
    reset: bool = False
    generation: str
    plain_space_title_canonicalization: bool
    next_since: int
    latest_seq: int
    pages: list[SyncPage]
    blocks: list[SyncBlock]
    sidebar: list[SyncSidebarEntry]
    tombstones: list[SyncTombstone]


class BlockPayload(BaseModel):
    """GET /api/block/{uid}: one block's subtree with page context."""
    page: PageMeta
    block: BlockNode
    breadcrumbs: list[str]
    block_ref_texts: dict[str, BlockRefText]


class SnapshotPayload(BaseModel):
    generation: str
    plain_space_title_canonicalization: bool
    seq: int
    pages: list[SyncPage]
    blocks: list[SyncBlock]
    sidebar: list[SyncSidebarEntry]


class AssistantConversation(BaseModel):
    id: str
    model: str


class AssistantAck(BaseModel):
    ok: bool = True


class TitleMigrationPage(BaseModel):
    page_id: int
    title: str


class TitleMigrationBlocker(BaseModel):
    page_id: int
    title: str
    reason: Literal["all_space", "forbidden_syntax"]


class TitleMigrationGroup(BaseModel):
    canonical_title: str
    survivor: TitleMigrationPage
    sources: list[TitleMigrationPage]
    has_clean_twin: bool
    block_count: int
    inbound_ref_count: int
    sidebar_count: int


class TitleMigrationAuditPayload(BaseModel):
    active: bool
    digest: str
    groups: list[TitleMigrationGroup]
    blockers: list[TitleMigrationBlocker]


class TitleMigrationApplyRequest(BaseModel):
    audit_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class TitleMigrationApplyResponse(BaseModel):
    digest: str
    groups_applied: int
    pages_retitled: int
    pages_merged: int
    blocks_moved: int
    blocks_rewritten: int
    generation: str


# -- Write acks ----------------------------------------------------------
#
# The two below are NOT declared as `response_model=` on their routes, and
# should not be: no generated client reads them (the web app ignores both
# bodies), so attaching them would add components to the published OpenAPI
# schema for nothing. They exist because the CLI/MCP client does read them
# -- `applied` is printed as "applied N ops" -- and reading them through a
# model is what makes the read type-checked. tests/test_client_contracts.py
# asserts each one still matches what its live route returns, which is the
# thing a `response_model` would otherwise have enforced.

class OpsAck(BaseModel):
    """POST /api/ops (routes_ops.py)."""
    ok: bool
    ts: int
    applied: int


class AssetDeleteAck(BaseModel):
    """DELETE /api/assets/{sha256} (routes_assets.py)."""
    deleted: bool
    refs_removed: int
