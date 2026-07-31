# pattern: Functional Core
"""Transform a parsed Roam EDN export into a tree of Pages and Blocks."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pkm.edn import Tagged

CONSUMED_ATTRS: frozenset[str] = frozenset({
    ":node/title", ":block/uid", ":block/string", ":block/order",
    ":block/children", ":block/heading", ":block/open",
    ":children/view-type",
    ":create/time", ":edit/time",
})


@dataclass(frozen=True)
class Block:
    uid: str
    text: str
    heading: int | None
    view_type: Literal["numbered", "document"] | None
    open: bool
    created_at: int | None
    edited_at: int | None
    children: tuple["Block", ...]


@dataclass(frozen=True)
class Page:
    title: str
    created_at: int | None
    edited_at: int | None
    children: tuple[Block, ...]


@dataclass(frozen=True)
class Export:
    pages: tuple[Page, ...]
    orphan_block_count: int
    skipped_entities: int
    attr_counts: dict[str, int]
    # Root blocks of every subtree unreachable from a page, each with its
    # own internal structure intact (uid/text/children), so a caller can
    # recover them instead of discarding them. orphan_block_count counts
    # every block in these subtrees, not just the roots.
    orphan_blocks: tuple[Block, ...] = ()


def _view_type(value: Any) -> Literal["numbered", "document"] | None:
    if value == ":numbered":
        return "numbered"
    if value == ":document":
        return "document"
    return None


def parse_export(db: object) -> Export:
    if not (isinstance(db, Tagged) and db.tag == "datascript/DB"
            and isinstance(db.value, dict)):
        raise ValueError("input is not a #datascript/DB export")
    schema = db.value.get(":schema", {})
    datoms = db.value.get(":datoms", [])
    many = {a for a, spec in schema.items()
            if isinstance(spec, dict)
            and spec.get(":db/cardinality") == ":db.cardinality/many"}

    entities: dict[int, dict[str, Any]] = {}
    attr_counts: dict[str, int] = {}
    for e, a, v, *_ in datoms:
        attr_counts[a] = attr_counts.get(a, 0) + 1
        ent = entities.setdefault(e, {})
        if a in many:
            ent.setdefault(a, []).append(v)
        else:
            ent[a] = v

    def is_block(ent: dict[str, Any]) -> bool:
        return ":block/uid" in ent and ":block/string" in ent

    built: dict[int, Block] = {}

    def build(eid: int, trail: frozenset[int]) -> Block | None:
        if eid in trail:  # cycle guard: a child that is its own ancestor
            return None
        if eid in built:
            return built[eid]
        ent = entities.get(eid, {})
        if not is_block(ent):
            return None
        block = Block(
            uid=ent[":block/uid"],
            text=ent[":block/string"],
            heading=ent.get(":block/heading"),
            view_type=_view_type(ent.get(":children/view-type")),
            open=bool(ent.get(":block/open", True)),
            created_at=ent.get(":create/time"),
            edited_at=ent.get(":edit/time"),
            children=_children(ent, trail | {eid}),
        )
        built[eid] = block
        return block

    def _children(ent: dict[str, Any], trail: frozenset[int]) -> tuple[Block, ...]:
        kids = ent.get(":block/children", [])
        ordered = sorted(kids, key=lambda c: entities.get(c, {}).get(":block/order", 0))
        return tuple(b for c in ordered if (b := build(c, trail)) is not None)

    pages = []
    for eid, ent in entities.items():
        if ":node/title" not in ent:
            continue
        pages.append(Page(
            title=ent[":node/title"],
            created_at=ent.get(":create/time"),
            edited_at=ent.get(":edit/time"),
            children=_children(ent, frozenset({eid})),
        ))

    # `built` already holds exactly the blocks reached by walking down from
    # a page (populated by the `build` calls above), keyed by entity id.
    reached_eids = set(built.keys())
    all_block_eids = {eid for eid, ent in entities.items() if is_block(ent)}
    unreached_eids = all_block_eids - reached_eids

    # A parent pointer only counts if it comes from a real (is_block)
    # entity: a stringless entity (uid but no :block/string, one of
    # skipped_entities below) fails is_block and so is never even visited
    # by build() -- it returns None before recursing into :block/children
    # at all -- which would hide that entity's own real, text-bearing
    # children just as thoroughly as if nothing pointed to them.
    parent_of: dict[int, int] = {
        c: eid for eid, ent in entities.items() if is_block(ent)
        for c in ent.get(":block/children", [])
    }

    def uid_of(eid: int) -> str:
        return entities[eid][":block/uid"]

    # Pass 1: an unreached block with no (valid) parent is a genuine root.
    # build()'s ordinary top-down recursion from each one is duplicate-free
    # by construction -- it only ever descends into :block/children, so it
    # can never visit the same eid twice by a different path.
    natural_roots = sorted((eid for eid in unreached_eids if eid not in parent_of),
                           key=uid_of)
    orphan_blocks_list = [
        block for eid in natural_roots
        if (block := build(eid, frozenset())) is not None
    ]

    # Pass 2: anything still unbuilt has a parent that is itself unreached
    # (by pass 1's construction), which can only happen inside a cycle (A's
    # only pointer is from B, B's only pointer is from A, ... with maybe
    # ordinary subtrees hanging off any cycle member in the forward
    # direction). Naively rooting at whichever leftover eid sorts first
    # would often pick a hanging descendant rather than the cycle itself
    # -- e.g. child C of cycle member A: rooting at C alone misses A and B
    # entirely, and rooting at A afterwards would then attach the
    # already-built C a second time, as A's own child, emitting it twice.
    # Walking each leftover eid's parent chain until a node repeats always
    # lands on an actual cycle member (every leftover eid has a parent, so
    # the walk can't run off the end, and it's finite so it must repeat);
    # build()'s existing ancestor-trail cycle guard then prunes the
    # closing back-edge, and rooting there reaches the whole component --
    # the cycle plus every subtree hanging off it -- in one pass.
    remaining = sorted((eid for eid in unreached_eids if eid not in built), key=uid_of)
    for start in remaining:
        if start in built:
            continue
        seen: list[int] = []
        cursor = start
        while cursor not in seen:
            seen.append(cursor)
            cursor = parent_of[cursor]
        if (block := build(cursor, frozenset())) is not None:
            orphan_blocks_list.append(block)

    orphan_blocks = tuple(orphan_blocks_list)

    # Count skipped entities: those with uid but no string (excluding pages)
    skipped_entities = len({ent[":block/uid"] for ent in entities.values()
                            if ":block/uid" in ent and not is_block(ent) and ":node/title" not in ent})

    return Export(
        pages=tuple(sorted(pages, key=lambda p: p.title)),
        orphan_block_count=len(unreached_eids),
        skipped_entities=skipped_entities,
        attr_counts=attr_counts,
        orphan_blocks=orphan_blocks,
    )
