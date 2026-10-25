# pattern: Functional Core
"""Assemble flat block rows into a nested tree; collect ((block-ref)) uids;
walk parent links into breadcrumb trails."""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import NamedTuple

from pkm.contracts.ops import BlockUid
from pkm.contracts.responses import BlockNode
from pkm.refs import extract
from pkm.rows import Row, heading_level


def build_tree(rows: Sequence[Row]) -> list[BlockNode]:
    known = {r["uid"] for r in rows}
    by_parent: dict[BlockUid | None, list[Row]] = {}
    for r in rows:
        parent = r["parent_uid"] if r["parent_uid"] in known else None
        by_parent.setdefault(parent, []).append(r)

    def nodes(parent: BlockUid | None) -> list[BlockNode]:
        items = by_parent.get(parent, [])
        if parent is None:
            # Separate normal roots from orphans (blocks with missing parents)
            normal = [r for r in items if r["parent_uid"] is None]
            orphans = [r for r in items if r["parent_uid"] is not None]
            children = sorted(normal, key=lambda r: r["order_idx"]) + sorted(orphans, key=lambda r: r["order_idx"])
        else:
            children = sorted(items, key=lambda r: r["order_idx"])
        return [BlockNode(
            uid=r["uid"],
            text=r["text"],
            heading=heading_level(r["heading"]),
            view_type=r["view_type"],
            collapsed=bool(r["collapsed"]),
            order_idx=r["order_idx"],
            created_at=r["created_at"],
            updated_at=r["updated_at"],
            children=nodes(r["uid"]),
        ) for r in children]

    return nodes(None)


def find_node(nodes: Sequence[BlockNode], uid: BlockUid) -> BlockNode | None:
    """Depth-first search of a build_tree() result for the node with `uid`."""
    for node in nodes:
        if node.uid == uid:
            return node
        found = find_node(node.children, uid)
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


def ancestor_trails(starts: Sequence[BlockUid],
                    blocks: Mapping[BlockUid, tuple[BlockUid | None, str]]
                    ) -> dict[BlockUid, list[BlockUid]]:
    """Each start's breadcrumb trail of ancestor uids, root first, from
    `uid -> (parent_uid, text)`: the parent links followed up to a uid
    missing from `blocks` or one already on the trail (the start counts),
    so a corrupt parent cycle ends rather than repeating. Starts with no
    ancestor in `blocks` are absent. Trails hold uids, not texts: a
    response carries each ancestor's text once, however many trails pass
    through it."""
    out: dict[BlockUid, list[BlockUid]] = {}
    for start in starts:
        if start not in blocks:
            continue
        seen = {start}
        trail: list[BlockUid] = []
        parent = blocks[start][0]
        while parent is not None and parent in blocks and parent not in seen:
            seen.add(parent)
            trail.append(parent)
            parent = blocks[parent][0]
        if trail:
            trail.reverse()
            out[start] = trail
    return out


class Ancestors(NamedTuple):
    """Breadcrumb trails as uids, and the text of every uid on a trail,
    each once. `grouping.group_backlinks` turns them into the wire shape:
    per group, an `ancestor_texts` list, and per item, `ancestors` as
    positions in it."""
    trails: dict[BlockUid, list[BlockUid]]
    texts: dict[BlockUid, str]


def ancestors_of(starts: Sequence[BlockUid],
                 blocks: Mapping[BlockUid, tuple[BlockUid | None, str]]
                 ) -> Ancestors:
    """`ancestor_trails` plus the texts its trails name, each once."""
    trails = ancestor_trails(starts, blocks)
    texts = {uid: blocks[uid][1]
             for trail in trails.values() for uid in trail}
    return Ancestors(trails, texts)
