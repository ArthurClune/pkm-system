# pattern: Functional Core
"""Assemble flat block rows into a nested tree; collect ((block-ref)) uids."""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import TypedDict

from pkm.contracts.ops import BlockUid, OrderIdx, ViewType
from pkm.contracts.responses import StoredHeading
from pkm.refs import extract
from pkm.rows import Row, heading_level


class TreeNode(TypedDict):
    """One block of a build_tree() result; the same fields as
    `contracts.BlockNode`."""
    uid: BlockUid
    text: str
    heading: StoredHeading
    view_type: ViewType | None
    collapsed: bool
    order_idx: OrderIdx
    created_at: int | None
    updated_at: int | None
    children: list[TreeNode]


def build_tree(rows: Sequence[Row]) -> list[TreeNode]:
    known = {r["uid"] for r in rows}
    by_parent: dict[BlockUid | None, list[Row]] = {}
    for r in rows:
        parent = r["parent_uid"] if r["parent_uid"] in known else None
        by_parent.setdefault(parent, []).append(r)

    def nodes(parent: BlockUid | None) -> list[TreeNode]:
        items = by_parent.get(parent, [])
        if parent is None:
            # Separate normal roots from orphans (blocks with missing parents)
            normal = [r for r in items if r["parent_uid"] is None]
            orphans = [r for r in items if r["parent_uid"] is not None]
            children = sorted(normal, key=lambda r: r["order_idx"]) + sorted(orphans, key=lambda r: r["order_idx"])
        else:
            children = sorted(items, key=lambda r: r["order_idx"])
        return [{
            "uid": r["uid"],
            "text": r["text"],
            "heading": heading_level(r["heading"]),
            "view_type": r["view_type"],
            "collapsed": bool(r["collapsed"]),
            "order_idx": r["order_idx"],
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
            "children": nodes(r["uid"]),
        } for r in children]

    return nodes(None)


def find_node(nodes: Sequence[TreeNode], uid: BlockUid) -> TreeNode | None:
    """Depth-first search of a build_tree() result for the node with `uid`."""
    for node in nodes:
        if node["uid"] == uid:
            return node
        found = find_node(node["children"], uid)
        if found is not None:
            return found
    return None


def collect_block_ref_uids(texts: Iterable[str]) -> list[BlockUid]:
    seen: set[BlockUid] = set()
    out: list[BlockUid] = []
    for text in texts:
        for uid in extract(text).block_refs:
            if uid not in seen:
                seen.add(uid)
                out.append(uid)
    return out
