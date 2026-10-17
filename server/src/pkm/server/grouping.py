# pattern: Functional Core
"""Group block rows into the per-page shape every grouped read payload
shares: `{page_id, page_title, items: [...]}`, groups in first-appearance
order (callers order their rows by page title, then uid).

Backlinks keep their own loop rather than routing through `group_by_page`:
their rows name the page differently (`src_page_*`, since the row's own
page is the reference target) and each item carries a breadcrumb trail.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TypedDict

from pkm.changed import ChangeStatus
from pkm.contracts.ops import BlockUid, PageId
from pkm.refs import CanonicalTitle
from pkm.rows import Row
from pkm.schema import SchemaRow


class GroupedBlock(TypedDict):
    uid: BlockUid
    text: str


class ChangedItem(TypedDict):
    uid: BlockUid
    text: str
    created_at: int | None
    updated_at: int | None
    status: ChangeStatus


class BacklinkItem(TypedDict):
    uid: BlockUid
    text: str
    breadcrumbs: list[str]


class PageGroup(TypedDict):
    page_id: PageId
    page_title: CanonicalTitle
    items: list[GroupedBlock]


class ChangedGroup(TypedDict):
    page_id: PageId
    page_title: CanonicalTitle
    items: list[ChangedItem]


class BacklinkGroup(TypedDict):
    page_id: PageId
    page_title: CanonicalTitle
    items: list[BacklinkItem]


def group_by_page(rows: Sequence[Row]) -> list[PageGroup]:
    """Rows of `uid, text, page_id, page_title` -> page groups. Shared by
    query results, todos and unlinked references, whose items are the bare
    `{uid, text}` pair."""
    groups: list[PageGroup] = []
    index: dict[PageId, list[GroupedBlock]] = {}
    for r in rows:
        items = index.get(r["page_id"])
        if items is None:
            items = []
            groups.append({"page_id": r["page_id"],
                           "page_title": r["page_title"], "items": items})
            index[r["page_id"]] = items
        items.append({"uid": r["uid"], "text": r["text"]})
    return groups


def group_changed(rows: Sequence[SchemaRow]) -> list[ChangedGroup]:
    """Rows of `uid, text, page_id, page_title, created_at, updated_at,
    status` -> page groups in first-appearance order, for /api/changed.
    Kept separate from `group_by_page` rather than generalised onto it:
    that shape is a public contract (GroupsPayload) three other routes
    already return; changing its item shape would ripple into all of
    them for one caller's extra fields."""
    groups: list[ChangedGroup] = []
    index: dict[PageId, list[ChangedItem]] = {}
    for r in rows:
        items = index.get(r["page_id"])
        if items is None:
            items = []
            groups.append({"page_id": r["page_id"],
                           "page_title": r["page_title"], "items": items})
            index[r["page_id"]] = items
        items.append({
            "uid": r["uid"], "text": r["text"],
            "created_at": r["created_at"], "updated_at": r["updated_at"],
            "status": r["status"],
        })
    return groups


def group_backlinks(rows: Sequence[Row],
                    ancestors: Mapping[BlockUid, list[str]]
                    ) -> list[BacklinkGroup]:
    """Rows of `uid, text, src_page_id, src_page_title` -> page groups whose
    items also carry the block's breadcrumb trail."""
    groups: list[BacklinkGroup] = []
    index: dict[PageId, list[BacklinkItem]] = {}
    for r in rows:
        items = index.get(r["src_page_id"])
        if items is None:
            items = []
            groups.append({"page_id": r["src_page_id"],
                           "page_title": r["src_page_title"], "items": items})
            index[r["src_page_id"]] = items
        items.append({
            "uid": r["uid"],
            "text": r["text"],
            "breadcrumbs": list(ancestors.get(r["uid"], [])),
        })
    return groups
