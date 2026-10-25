# pattern: Functional Core
"""Group block rows into the per-page shape every grouped read payload
shares: `{page_id, page_title, items: [...]}`, groups in first-appearance
order (callers order their rows by page title, then uid).

Backlinks keep their own loop rather than routing through `group_by_page`:
their rows name the page differently (`src_page_*`, since the row's own
page is the reference target) and each item carries a breadcrumb trail,
as positions in its group's list of ancestor texts.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import TypedDict

from pkm.changed import ChangeStatus
from pkm.contracts.ops import BlockUid, PageId
from pkm.contracts.responses import (STALE_BUNDLE_CRUMB, BacklinkGroup,
                                     BacklinkItem, BlockGroup, ChangedGroup,
                                     ChangedItem, GroupItem)
from pkm.refs import CanonicalTitle
from pkm.rows import Row
from pkm.server.tree import Ancestors


class ChangedRow(TypedDict):
    """A `Row`'s fields `group_changed` reads, plus the Python-computed
    `status` (no query column carries it)."""
    uid: BlockUid
    text: str
    page_id: PageId
    page_title: CanonicalTitle
    created_at: int | None
    updated_at: int | None
    status: ChangeStatus


def group_by_page(rows: Sequence[Row]) -> list[BlockGroup]:
    """Rows of `uid, text, page_id, page_title` -> page groups. Shared by
    query results, todos and unlinked references, whose items are the bare
    `{uid, text}` pair."""
    # Models copy the list they are given, so items are collected first
    # and each group is built once, after its rows are all in.
    titles: dict[PageId, CanonicalTitle] = {}
    index: dict[PageId, list[GroupItem]] = {}
    for r in rows:
        items = index.setdefault(r["page_id"], [])
        titles.setdefault(r["page_id"], r["page_title"])
        items.append(GroupItem(uid=r["uid"], text=r["text"]))
    return [BlockGroup(page_id=pid, page_title=titles[pid], items=items)
            for pid, items in index.items()]


def group_changed(rows: Sequence[ChangedRow]) -> list[ChangedGroup]:
    """Rows of `uid, text, page_id, page_title, created_at, updated_at,
    status` -> page groups in first-appearance order, for /api/changed.
    Kept separate from `group_by_page` rather than generalised onto it:
    that shape is a public contract (GroupsPayload) three other routes
    already return; changing its item shape would ripple into all of
    them for one caller's extra fields."""
    titles: dict[PageId, CanonicalTitle] = {}
    index: dict[PageId, list[ChangedItem]] = {}
    for r in rows:
        items = index.setdefault(r["page_id"], [])
        titles.setdefault(r["page_id"], r["page_title"])
        items.append(ChangedItem(
            uid=r["uid"], text=r["text"], created_at=r["created_at"],
            updated_at=r["updated_at"], status=r["status"]))
    return [ChangedGroup(page_id=pid, page_title=titles[pid], items=items)
            for pid, items in index.items()]


def group_backlinks(rows: Sequence[Row],
                    ancestors: Ancestors) -> list[BacklinkGroup]:
    """Rows of `uid, text, src_page_id, src_page_title` -> page groups. Each
    group lists its items' ancestor texts once, in first-appearance order
    (items in row order, each trail root first), and each item names its
    trail by position in that list. The replica's `groupBacklinkRows` must
    number them the same way."""
    titles: dict[PageId, CanonicalTitle] = {}
    index: dict[PageId, list[BacklinkItem]] = {}
    positions: dict[PageId, dict[BlockUid, int]] = {}
    for r in rows:
        items = index.setdefault(r["src_page_id"], [])
        titles.setdefault(r["src_page_id"], r["src_page_title"])
        seen = positions.setdefault(r["src_page_id"], {})
        trail = [seen.setdefault(uid, len(seen))
                 for uid in ancestors.trails.get(r["uid"], [])]
        items.append(BacklinkItem(
            uid=r["uid"], text=r["text"],
            breadcrumbs=[STALE_BUNDLE_CRUMB] if trail else [],
            ancestors=trail))
    return [BacklinkGroup(
        page_id=pid, page_title=titles[pid], items=items,
        ancestor_texts=[ancestors.texts[uid] for uid in positions[pid]])
        for pid, items in index.items()]
