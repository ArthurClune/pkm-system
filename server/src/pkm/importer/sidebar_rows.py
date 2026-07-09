# pattern: Functional Core
"""Compute which sidebar entries a fixed ordered import list is missing from
an existing set of titles, continuing order_idx from the given start."""
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
