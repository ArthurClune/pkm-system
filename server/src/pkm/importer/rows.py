# pattern: Functional Core
"""Flatten a parsed Export into SQL row tuples, deriving refs and
creating implicit pages for referenced-but-never-created titles."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

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
        text = transform_text(b.text)
        parsed = extract(text)
        blocks.append((b.uid, pid, parent_uid, order_idx, text, b.heading,
                       0 if b.open else 1, b.created_at, b.edited_at))
        for r in parsed.refs:
            refs.append((b.uid, page_id(r.title), r.kind))
        counts["block_ref"] += len(parsed.block_refs)
        counts["embed"] += parsed.embeds
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
