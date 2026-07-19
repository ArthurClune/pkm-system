# pattern: Functional Core
"""Pydantic models describing the JSON read responses. Declared as
`response_model=` on the read routes so the shapes reach OpenAPI and, from
there, web/src/api/types.d.ts. The routes still return plain dicts of the same
shape; these models are the contract, not a payload redesign.

Keep every field required (no defaults): the routes always populate them, and
optionality here would surface as `?:` in the generated TypeScript."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

ViewType = Literal["numbered", "document"]


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


class GroupItem(BaseModel):
    uid: str
    text: str


class BlockGroup(BaseModel):
    page_id: int
    page_title: str
    items: list[GroupItem]


class GroupsPayload(BaseModel):
    """Shared by /api/unlinked and /api/query."""
    groups: list[BlockGroup]
    total: int


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
    seq: int
    pages: list[SyncPage]
    blocks: list[SyncBlock]
    sidebar: list[SyncSidebarEntry]
