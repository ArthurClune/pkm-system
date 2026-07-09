# pattern: Functional Core
"""Pure ordering logic for sidebar_entries rows: computing order_idx values
for import and single-entry appends, and validating full-list reorders."""
from __future__ import annotations


def missing_entry_rows(existing_titles: set[str], desired_titles: tuple[str, ...],
                       start_order: int) -> list[tuple[str, int]]:
    rows: list[tuple[str, int]] = []
    order = start_order
    for title in desired_titles:
        if title in existing_titles:
            continue
        rows.append((title, order))
        order += 1
    return rows


def next_order_idx(existing_order_idxs: list[int]) -> int:
    """order_idx for a newly-appended entry: one past the current max."""
    return max(existing_order_idxs, default=-1) + 1


def reorder_is_valid(existing_ids: set[int], new_order: list[int]) -> bool:
    """A reorder must list every current entry id exactly once — no partial
    lists (would orphan entries) and no unknown/duplicate ids."""
    return len(new_order) == len(existing_ids) and set(new_order) == existing_ids
