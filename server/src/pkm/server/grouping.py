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


def group_by_page(rows: Sequence[Mapping]) -> list[dict]:
    """Rows of `uid, text, page_id, page_title` -> page groups. Shared by
    query results, todos and unlinked references, whose items are the bare
    `{uid, text}` pair."""
    groups: list[dict] = []
    index: dict[int, dict] = {}
    for r in rows:
        group = index.get(r["page_id"])
        if group is None:
            group = {"page_id": r["page_id"], "page_title": r["page_title"],
                     "items": []}
            index[r["page_id"]] = group
            groups.append(group)
        group["items"].append({"uid": r["uid"], "text": r["text"]})
    return groups


def group_backlinks(rows: Sequence[Mapping],
                    ancestors: Mapping[str, list[str]]) -> list[dict]:
    """Rows of `uid, text, src_page_id, src_page_title` -> page groups whose
    items also carry the block's breadcrumb trail."""
    groups: list[dict] = []
    index: dict[int, dict] = {}
    for r in rows:
        group = index.get(r["src_page_id"])
        if group is None:
            group = {"page_id": r["src_page_id"],
                     "page_title": r["src_page_title"], "items": []}
            index[r["src_page_id"]] = group
            groups.append(group)
        group["items"].append({
            "uid": r["uid"],
            "text": r["text"],
            "breadcrumbs": list(ancestors.get(r["uid"], [])),
        })
    return groups
