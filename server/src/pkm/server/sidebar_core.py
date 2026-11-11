# pattern: Functional Core
"""Pure ordering logic for sidebar_entries rows: the order_idx of an
appended entry, and whether a full-list reorder is valid."""
from __future__ import annotations

from pkm.contracts.ops import SidebarEntryId, SidebarOrderIdx


def next_order_idx(existing_order_idxs: list[SidebarOrderIdx]) -> SidebarOrderIdx:
    """order_idx for a newly-appended entry: one past the current max."""
    return SidebarOrderIdx(max(existing_order_idxs, default=-1) + 1)


def reorder_is_valid(existing_ids: set[SidebarEntryId],
                     new_order: list[SidebarEntryId]) -> bool:
    """A reorder must list every current entry id exactly once — no partial
    lists (would orphan entries) and no unknown/duplicate ids."""
    return len(new_order) == len(existing_ids) and set(new_order) == existing_ids
