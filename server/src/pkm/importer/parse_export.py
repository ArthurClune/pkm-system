# pattern: Functional Core
"""Transform a parsed Roam EDN export into a tree of Pages and Blocks."""
from __future__ import annotations

from dataclasses import dataclass

from pkm.edn import Tagged

CONSUMED_ATTRS: frozenset[str] = frozenset({
    ":node/title", ":block/uid", ":block/string", ":block/order",
    ":block/children", ":block/heading", ":block/open",
    ":create/time", ":edit/time",
})


@dataclass(frozen=True)
class Block:
    uid: str
    text: str
    heading: int | None
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


def parse_export(db: object) -> Export:
    if not (isinstance(db, Tagged) and db.tag == "datascript/DB"):
        raise ValueError("input is not a #datascript/DB export")
    schema = db.value.get(":schema", {})
    datoms = db.value.get(":datoms", [])
    many = {a for a, spec in schema.items()
            if isinstance(spec, dict)
            and spec.get(":db/cardinality") == ":db.cardinality/many"}

    entities: dict[int, dict[str, object]] = {}
    attr_counts: dict[str, int] = {}
    for e, a, v, *_ in datoms:
        attr_counts[a] = attr_counts.get(a, 0) + 1
        ent = entities.setdefault(e, {})
        if a in many:
            ent.setdefault(a, []).append(v)
        else:
            ent[a] = v

    def is_block(ent: dict[str, object]) -> bool:
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
            open=bool(ent.get(":block/open", True)),
            created_at=ent.get(":create/time"),
            edited_at=ent.get(":edit/time"),
            children=_children(ent, trail | {eid}),
        )
        built[eid] = block
        return block

    def _children(ent: dict[str, object], trail: frozenset[int]) -> tuple[Block, ...]:
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

    reached: set[str] = set()

    def walk(b: Block) -> None:
        reached.add(b.uid)
        for c in b.children:
            walk(c)

    for p in pages:
        for b in p.children:
            walk(b)
    all_uids = {ent[":block/uid"] for ent in entities.values() if is_block(ent)}

    # Count skipped entities: those with uid but no string
    skipped_entities = len({ent[":block/uid"] for ent in entities.values()
                            if ":block/uid" in ent and not is_block(ent)})

    return Export(
        pages=tuple(sorted(pages, key=lambda p: p.title)),
        orphan_block_count=len(all_uids - reached),
        skipped_entities=skipped_entities,
        attr_counts=attr_counts,
    )
