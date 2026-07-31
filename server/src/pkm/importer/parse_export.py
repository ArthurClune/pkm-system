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

    # A block entity referenced by another entity's :block/children is not
    # a root of its own subtree -- if that parent were reachable, the child
    # would already be in `built` too, so an unreached child always means
    # its parent (if any) is itself unreached. Roots are the unreached
    # blocks nobody points to.
    child_of_any = {c for ent in entities.values() for c in ent.get(":block/children", [])}
    orphan_root_eids = sorted(
        (eid for eid in unreached_eids if eid not in child_of_any),
        key=lambda eid: entities[eid][":block/uid"],
    )
    orphan_blocks = tuple(
        block for eid in orphan_root_eids
        if (block := build(eid, frozenset())) is not None
    )

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
