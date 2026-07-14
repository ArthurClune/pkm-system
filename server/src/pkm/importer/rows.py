# pattern: Functional Core
"""Flatten a parsed Export into SQL row tuples, deriving refs and
creating implicit pages for referenced-but-never-created titles.

Roam mermaid component blocks ({{[[mermaid]]}} with diagram-source child
blocks, see pkm.importer.mermaid) are converted to a single fenced block
here, before ref-extraction runs: the fence text replaces the component
block's own text, and its children are consumed (not walked/emitted as
their own block rows)."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from pkm.importer.mermaid import convert_to_fence
from pkm.importer.parse_export import Block, Export
from pkm.refs import extract


@dataclass(frozen=True)
class Rows:
    pages: list[tuple]
    blocks: list[tuple]
    refs: list[tuple]
    implicit_page_count: int
    block_ref_count: int
    embed_count: int


def to_rows(export: Export, transform_text: Callable[[str], str]) -> Rows:
    pages: list[tuple] = []
    blocks: list[tuple] = []
    refs: list[tuple] = []
    page_ids: dict[str, int] = {}
    counts = {"block_ref": 0, "embed": 0}

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
        fence = convert_to_fence(b.text, b.children)
        text = transform_text(fence if fence is not None else b.text)
        parsed = extract(text)  # runs on final text, so a fence has no [[mermaid]] ref
        blocks.append((b.uid, pid, parent_uid, order_idx, text, b.heading,
                       0 if b.open else 1, b.created_at, b.edited_at,
                       b.view_type))
        for r in parsed.refs:
            refs.append((b.uid, page_id(r.title), r.kind))
        counts["block_ref"] += len(parsed.block_refs)
        counts["embed"] += parsed.embeds
        if fence is None:  # children consumed into the fence otherwise
            for i, child in enumerate(b.children):
                walk(child, pid, b.uid, i)

    for p in export.pages:
        pid = page_ids[p.title]
        for i, child in enumerate(p.children):
            walk(child, pid, None, i)

    return Rows(pages=pages, blocks=blocks, refs=refs,
                implicit_page_count=len(pages) - explicit,
                block_ref_count=counts["block_ref"],
                embed_count=counts["embed"])
