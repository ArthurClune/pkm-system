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


class GroupItem(TypedDict):
    uid: object
    text: object


class ChangedItem(TypedDict):
    uid: object
    text: object
    created_at: object
    updated_at: object
    status: object


class BacklinkItem(TypedDict):
    uid: object
    text: object
    breadcrumbs: list[str]


class PageGroup(TypedDict):
    page_id: object
    page_title: object
    items: list[GroupItem]


class ChangedGroup(TypedDict):
    page_id: object
    page_title: object
    items: list[ChangedItem]


class BacklinkGroup(TypedDict):
    page_id: object
    page_title: object
    items: list[BacklinkItem]


def group_by_page(rows: Sequence[Mapping[str, object]]) -> list[PageGroup]:
    """Rows of `uid, text, page_id, page_title` -> page groups. Shared by
    query results, todos and unlinked references, whose items are the bare
    `{uid, text}` pair."""
    groups: list[PageGroup] = []
    index: dict[object, list[GroupItem]] = {}
    for r in rows:
        items = index.get(r["page_id"])
        if items is None:
            items = []
            groups.append({"page_id": r["page_id"],
                           "page_title": r["page_title"], "items": items})
            index[r["page_id"]] = items
        items.append({"uid": r["uid"], "text": r["text"]})
    return groups


def group_changed(rows: Sequence[Mapping[str, object]]) -> list[ChangedGroup]:
    """Rows of `uid, text, page_id, page_title, created_at, updated_at,
    status` -> page groups in first-appearance order, for /api/changed.
    Kept separate from `group_by_page` rather than generalised onto it:
    that shape is a public contract (GroupsPayload) three other routes
    already return; changing its item shape would ripple into all of
    them for one caller's extra fields."""
    groups: list[ChangedGroup] = []
    index: dict[object, list[ChangedItem]] = {}
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


def group_backlinks(rows: Sequence[Mapping[str, object]],
                    ancestors: Mapping[object, list[str]]
                    ) -> list[BacklinkGroup]:
    """Rows of `uid, text, src_page_id, src_page_title` -> page groups whose
    items also carry the block's breadcrumb trail."""
    groups: list[BacklinkGroup] = []
    index: dict[object, list[BacklinkItem]] = {}
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
