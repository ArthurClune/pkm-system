# pattern: Functional Core
"""Import report: everything the importer saw, kept, ignored, or missed."""
from __future__ import annotations

from dataclasses import dataclass

from pkm.importer.parse_export import CONSUMED_ATTRS


@dataclass(frozen=True)
class ImportReport:
    pages: int
    implicit_pages: int
    blocks: int
    refs: int
    orphan_blocks: int
    skipped_entities: int
    block_ref_count: int
    embed_count: int
    assets_total: int
    assets_used: int
    missing_asset_urls: tuple[str, ...]
    attr_counts: dict[str, int]


def render(r: ImportReport) -> str:
    ignored = {a: n for a, n in sorted(r.attr_counts.items())
               if a not in CONSUMED_ATTRS}
    lines = [
        "== import report ==",
        f"pages: {r.pages} ({r.implicit_pages} implicit)",
        f"blocks: {r.blocks}",
        f"refs: {r.refs}",
        f"orphan blocks (unreachable, not imported): {r.orphan_blocks}",
        f"skipped entities (no uid/string): {r.skipped_entities}",
        f"block refs ((...)): {r.block_ref_count}",
        f"embeds: {r.embed_count}",
        f"assets: {r.assets_total} in store, {r.assets_used} referenced",
    ]
    if ignored:
        lines.append("ignored attributes:")
        lines += [f"  {a} ({n})" for a, n in ignored.items()]
    else:
        lines.append("ignored attributes: none")
    if r.missing_asset_urls:
        lines.append("missing asset urls:")
        lines += [f"  {u}" for u in sorted(r.missing_asset_urls)]
    else:
        lines.append("missing asset urls: none")
    return "\n".join(lines) + "\n"
