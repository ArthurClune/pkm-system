# pattern: Functional Core
"""Group backlink rows by source page and attach breadcrumb trails."""
from __future__ import annotations

from collections.abc import Mapping, Sequence


def group_backlinks(rows: Sequence[Mapping],
                    ancestors: Mapping[str, list[str]]) -> list[dict]:
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
