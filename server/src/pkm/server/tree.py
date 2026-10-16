# pattern: Functional Core
"""Assemble flat block rows into a nested tree; collect ((block-ref)) uids."""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import TypedDict

from pkm.refs import extract


class TreeNode(TypedDict):
    """One block of a build_tree() result. Scalar fields are passed through
    from the row as read, so they are `object` here."""
    uid: object
    text: object
    heading: object
    view_type: object
    collapsed: bool
    order_idx: object
    created_at: object
    updated_at: object
    children: list[TreeNode]


def _order_idx(row: Mapping[str, object]) -> int:
    idx = row["order_idx"]
    assert isinstance(idx, int)
    return idx


def build_tree(rows: Sequence[Mapping[str, object]]) -> list[TreeNode]:
    known = {r["uid"] for r in rows}
    by_parent: dict[object, list[Mapping[str, object]]] = {}
    for r in rows:
        parent = r["parent_uid"] if r["parent_uid"] in known else None
        by_parent.setdefault(parent, []).append(r)

    def nodes(parent: object) -> list[TreeNode]:
        items = by_parent.get(parent, [])
        if parent is None:
            # Separate normal roots from orphans (blocks with missing parents)
            normal = [r for r in items if r["parent_uid"] is None]
            orphans = [r for r in items if r["parent_uid"] is not None]
            children = sorted(normal, key=_order_idx) + sorted(orphans, key=_order_idx)
        else:
            children = sorted(items, key=_order_idx)
        return [{
            "uid": r["uid"],
            "text": r["text"],
            "heading": r["heading"],
            "view_type": r["view_type"],
            "collapsed": bool(r["collapsed"]),
            "order_idx": r["order_idx"],
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
            "children": nodes(r["uid"]),
        } for r in children]

    return nodes(None)


def find_node(nodes: Sequence[TreeNode], uid: str) -> TreeNode | None:
    """Depth-first search of a build_tree() result for the node with `uid`."""
    for node in nodes:
        if node["uid"] == uid:
            return node
        found = find_node(node["children"], uid)
        if found is not None:
            return found
    return None


def collect_block_ref_uids(texts: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for text in texts:
        for uid in extract(text).block_refs:
            if uid not in seen:
                seen.add(uid)
                out.append(uid)
    return out
