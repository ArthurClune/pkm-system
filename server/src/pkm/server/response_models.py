# pattern: Functional Core
"""Pydantic models describing the JSON read responses. Declared as
`response_model=` on the read routes so the shapes reach OpenAPI and, from
there, web/src/api/types.d.ts. The routes still return plain dicts of the same
shape; these models are the contract, not a payload redesign.

Keep every field required (no defaults): the routes always populate them, and
optionality here would surface as `?:` in the generated TypeScript."""
from __future__ import annotations

from pydantic import BaseModel


class PageMeta(BaseModel):
    id: int
    title: str
    created_at: int | None
    updated_at: int | None


class BlockNode(BaseModel):
    uid: str
    text: str
    heading: int | None
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
