# pattern: Functional Core
"""Flatten a parsed Export into SQL row tuples, deriving refs and
creating implicit pages for referenced-but-never-created titles.

Roam mermaid component blocks ({{[[mermaid]]}} with diagram-source child
blocks, see pkm.importer.mermaid) are converted to a single fenced block
here, before ref-extraction runs: the fence text replaces the component
block's own text, and its children are consumed (not walked/emitted as
their own block rows) -- unless a descendant that would be dropped is
still targeted by an inbound ((uid)) reference from a block outside the
subtree, in which case the whole subtree is left as ordinary nested
blocks instead. Every candidate ancestor containing a protected nested
component is also kept, so no outer flatten can delete protected rows."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from pkm.importer.mermaid import convert_to_fence
from pkm.importer.mermaid_preservation import plan_mermaid_preservation
from pkm.importer.parse_export import Block, Export
from pkm.refs import extract

# Deterministic landing page for block subtrees the export left unreachable
# from any page (see Export.orphan_blocks): rather than silently dropping
# them, they're attached here with their uid/text/children intact so
# ((uid)) references keep resolving. Suffixed with " (2)", " (3)", ... on
# the rare chance a page already has this exact title.
RECOVERY_PAGE_TITLE = "Import recovery: unreachable blocks"


@dataclass(frozen=True)
class Rows:
    pages: list[tuple]
    blocks: list[tuple]
    refs: list[tuple]
    block_refs: list[tuple]
    implicit_page_count: int
    block_ref_count: int
    embed_count: int
    recovery_page_title: str | None
    # (descendant_uid, external_source_uids) for every mermaid-subtree
    # descendant that was kept as an ordinary nested block, instead of
    # being dropped by flattening, because something outside its own
    # subtree still holds an inbound ((uid)) reference to it.
    mermaid_preserved_refs: tuple[tuple[str, tuple[str, ...]], ...] = ()


def _collect_block_ref_sources(export: Export) -> dict[str, set[str]]:
    """Map every ((uid)) target anywhere in the export to the set of
    source block uids that reference it. Scanned once, up front, over
    every block's original text (including orphan subtrees) so a
    mermaid subtree's flatten-or-keep decision can check for references
    from outside itself before anything is walked or dropped."""
    sources: dict[str, set[str]] = {}

    def scan(b: Block) -> None:
        for target in extract(b.text).block_refs:
            sources.setdefault(target, set()).add(b.uid)
        for child in b.children:
            scan(child)

    for p in export.pages:
        for child in p.children:
            scan(child)
    for orphan in export.orphan_blocks:
        scan(orphan)
    return sources


def _descendant_uids(b: Block) -> set[str]:
    uids: set[str] = set()

    def collect(node: Block) -> None:
        uids.add(node.uid)
        for child in node.children:
            collect(child)

    for child in b.children:
        collect(child)
    return uids


def _collect_mermaid_candidates(
    export: Export,
) -> dict[str, tuple[str, set[str]]]:
    candidates: dict[str, tuple[str, set[str]]] = {}

    def scan(block: Block) -> None:
        fence = convert_to_fence(block.text, block.children)
        if fence is not None:
            candidates[block.uid] = (fence, _descendant_uids(block))
        for child in block.children:
            scan(child)

    for page in export.pages:
        for child in page.children:
            scan(child)
    for orphan in export.orphan_blocks:
        scan(orphan)
    return candidates


def to_rows(export: Export, transform_text: Callable[[str], str]) -> Rows:
    pages: list[tuple] = []
    blocks: list[tuple] = []
    refs: list[tuple] = []
    block_refs: list[tuple] = []
    page_ids: dict[str, int] = {}
    counts = {"block_ref": 0, "embed": 0}
    block_ref_sources = _collect_block_ref_sources(export)
    mermaid_candidates = _collect_mermaid_candidates(export)
    mermaid_plan = plan_mermaid_preservation(
        {
            uid: descendants
            for uid, (_, descendants) in mermaid_candidates.items()
        },
        block_ref_sources,
    )

    def page_id(title: str, created: int | None = None,
                updated: int | None = None) -> int:
        if title not in page_ids:
            page_ids[title] = len(page_ids) + 1
            pages.append((page_ids[title], title, created, updated))
        return page_ids[title]

    explicit = len(export.pages)
    for p in export.pages:  # register explicit pages first, with timestamps
        page_id(p.title, p.created_at, p.edited_at)

    def walk(b: Block, pid: int, parent_uid: str | None, order_idx: int) -> None:
        candidate = mermaid_candidates.get(b.uid)
        fence = (
            candidate[0]
            if candidate is not None
            and b.uid not in mermaid_plan.preserved_component_uids
            else None
        )
        text = transform_text(fence if fence is not None else b.text)
        parsed = extract(text)  # runs on final text, so a fence has no [[mermaid]] ref
        blocks.append((b.uid, pid, parent_uid, order_idx, text, b.heading,
                       0 if b.open else 1, b.created_at, b.edited_at,
                       b.view_type))
        for r in parsed.refs:
            refs.append((b.uid, page_id(r.title), r.kind))
        for target in dict.fromkeys(parsed.block_refs):
            block_refs.append((b.uid, target))
        counts["block_ref"] += len(parsed.block_refs)
        counts["embed"] += parsed.embeds
        if fence is None:  # children consumed into the fence otherwise
            for i, child in enumerate(b.children):
                walk(child, pid, b.uid, i)

    for p in export.pages:
        pid = page_ids[p.title]
        for i, child in enumerate(p.children):
            walk(child, pid, None, i)

    recovery_page_title = None
    if export.orphan_blocks:
        recovery_page_title = RECOVERY_PAGE_TITLE
        n = 2
        while recovery_page_title in page_ids:  # rare title collision
            recovery_page_title = f"{RECOVERY_PAGE_TITLE} ({n})"
            n += 1
        recovery_pid = page_id(recovery_page_title)
        for i, orphan in enumerate(export.orphan_blocks):
            walk(orphan, recovery_pid, None, i)

    implicit_page_count = (
        len(pages) - explicit - (1 if recovery_page_title is not None else 0)
    )

    return Rows(pages=pages, blocks=blocks, refs=refs, block_refs=block_refs,
                implicit_page_count=implicit_page_count,
                block_ref_count=counts["block_ref"],
                embed_count=counts["embed"],
                recovery_page_title=recovery_page_title,
                mermaid_preserved_refs=tuple(
                    (ref.descendant_uid, ref.source_uids)
                    for ref in mermaid_plan.preserved_refs
                ))
