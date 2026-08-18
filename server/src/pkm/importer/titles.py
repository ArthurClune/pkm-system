# pattern: Functional Core
"""Pure sanitization of imported page-title syntax."""
from __future__ import annotations

from dataclasses import dataclass
from typing import AbstractSet, Literal, Mapping, NamedTuple, Sequence

from pkm.importer.parse_export import Block, Export, Page
from pkm.refs import (
    extract,
    is_blank_title,
    normalize_title,
    title_syntax_reason,
)
from pkm.rename import rewrite_title_refs_map

ImportTitleErrorReason = Literal["malformed_syntax", "blank"]


@dataclass(frozen=True)
class ImportTitleChange:
    """One changed title spelling and every location where it appeared."""

    original_title: str
    sanitized_title: str
    locations: tuple[str, ...]
    merged: bool


@dataclass(frozen=True)
class SanitizedImport:
    """A rebuilt export and its deterministic title-change records."""

    export: Export
    title_changes: tuple[ImportTitleChange, ...]


class ImportTitleError(ValueError):
    """A title that cannot be safely sanitized during import."""

    original_title: str
    location: str
    reason: ImportTitleErrorReason

    def __init__(
        self,
        original_title: str,
        *,
        location: str,
        reason: ImportTitleErrorReason,
    ) -> None:
        """Record the refused title, its export location, and refusal reason."""
        self.original_title = original_title
        self.location = location
        self.reason = reason
        super().__init__(f'{reason}: {original_title!r}')


def _strip_brackets(
    title: str,
    *,
    original_title: str,
    location: str,
    index: int = 0,
    nested: bool = False,
) -> tuple[str, int]:
    visible: list[str] = []
    while index < len(title):
        if title.startswith("[[", index):
            inner, index = _strip_brackets(
                title,
                original_title=original_title,
                location=location,
                index=index + 2,
                nested=True,
            )
            visible.append(inner)
            continue
        if title.startswith("]]", index):
            if not nested:
                raise ImportTitleError(
                    original_title,
                    location=location,
                    reason="malformed_syntax",
                )
            return "".join(visible), index + 2
        visible.append(title[index])
        index += 1

    if nested:
        raise ImportTitleError(
            original_title,
            location=location,
            reason="malformed_syntax",
        )
    return "".join(visible), index


def sanitize_import_title(title: str, *, location: str) -> str:
    """Remove balanced Roam title markers or refuse an unsafe result."""
    without_brackets, _ = _strip_brackets(
        title,
        original_title=title,
        location=location,
    )
    result = normalize_title(without_brackets.replace("#", ""))
    if is_blank_title(result):
        raise ImportTitleError(title, location=location, reason="blank")
    if title_syntax_reason(result) is not None:
        raise ImportTitleError(
            title,
            location=location,
            reason="malformed_syntax",
        )
    return result


def _record_location(
    locations: dict[str, list[str]], title: str, location: str
) -> None:
    title_locations = locations.setdefault(title, [])
    if location not in title_locations:
        title_locations.append(location)


def _walk_blocks(blocks: tuple[Block, ...]) -> tuple[Block, ...]:
    return tuple(block for root in blocks for block in _walk_block(root))


def _walk_block(block: Block) -> tuple[Block, ...]:
    return (block,) + tuple(
        descendant
        for child in block.children
        for descendant in _walk_block(child)
    )


def _rewrite_block(block: Block, title_map: dict[str, str]) -> Block:
    # Every lookup normalizes first, which reaches both halves of title_map's
    # key set -- see _collect_title_locations for why that is safe.
    return Block(
        uid=block.uid,
        text=rewrite_title_refs_map(
            block.text, title_map, normalize=normalize_title
        ),
        heading=block.heading,
        view_type=block.view_type,
        open=block.open,
        created_at=block.created_at,
        edited_at=block.edited_at,
        children=tuple(_rewrite_block(child, title_map) for child in block.children),
    )


def _collect_title_locations(export: Export) -> dict[str, list[str]]:
    """Every title spelling the export mentions, and where each was seen.

    Page titles come first so a page's own location wins the one that decides
    the refusal message; block refs are recorded in walk order after them.

    The two kinds of key are spelled differently, and _rewrite_block depends
    on it. A page title is recorded raw, so a key here can hold control
    whitespace that extract() would never report; a block ref is recorded as
    extract() normalized it. The rewriter looks up normalized spellings only,
    so a raw key is reached through its normalized twin -- which exists for
    any spelling extract() recognizes, and the rewriter recognizes nothing
    else: both read the grammar out of refs (bracket_spans, tag_spans,
    attribute_title_span), so neither can find a ref the other missed. A raw
    key with no twin is one no block mentions, and only the page's own
    retitling looks it up.
    """
    locations: dict[str, list[str]] = {}
    for index, page in enumerate(export.pages):
        _record_location(locations, page.title, f"page[{index}]")

    for page in export.pages:
        for block in _walk_blocks(page.children):
            for ref in extract(block.text).refs:
                _record_location(locations, ref.title, f"block {block.uid}")
    for block in _walk_blocks(export.orphan_blocks):
        for ref in extract(block.text).refs:
            _record_location(locations, ref.title, f"block {block.uid}")
    return locations


class _PageRebuild(NamedTuple):
    """One page as the import found it and as sanitization rebuilt it."""

    original: Page
    rebuilt: Page


def _merge_sanitized_pages(
    rebuilt_sources: Sequence[_PageRebuild],
) -> tuple[tuple[Page, ...], set[str]]:
    """Collapse pages that sanitized to one title; report which titles merged.

    Survivor is the source that already carried the sanitized spelling, else
    the first in export order: its timestamps are kept and its blocks lead,
    with the other sources' blocks following in export order.
    """
    grouped: dict[str, list[_PageRebuild]] = {}
    for source in rebuilt_sources:
        grouped.setdefault(source.rebuilt.title, []).append(source)

    merged_pages: list[Page] = []
    merged_titles: set[str] = set()
    for sanitized_title, sources in grouped.items():
        if len(sources) > 1:
            merged_titles.add(sanitized_title)
        survivor_index = next(
            (
                index
                for index, source in enumerate(sources)
                if source.original.title == sanitized_title
            ),
            0,
        )
        survivor = sources[survivor_index].rebuilt
        ordered_sources = [sources[survivor_index]] + [
            source
            for index, source in enumerate(sources)
            if index != survivor_index
        ]
        merged_pages.append(
            Page(
                title=sanitized_title,
                created_at=survivor.created_at,
                edited_at=survivor.edited_at,
                children=tuple(
                    child
                    for source in ordered_sources
                    for child in source.rebuilt.children
                ),
            )
        )
    return tuple(merged_pages), merged_titles


def _title_changes(
    title_map: Mapping[str, str],
    locations: Mapping[str, list[str]],
    merged_pages_titles: AbstractSet[str],
) -> tuple[ImportTitleChange, ...]:
    """One record per changed spelling, in sorted original-title order.

    A title is `merged` when pages collapsed onto it or when several
    spellings did -- two refs reaching one page count even if no page moved.
    """
    spellings_by_sanitized: dict[str, set[str]] = {}
    for original_title, sanitized_title in title_map.items():
        spellings_by_sanitized.setdefault(sanitized_title, set()).add(original_title)
    merged_titles = merged_pages_titles | {
        sanitized_title
        for sanitized_title, spellings in spellings_by_sanitized.items()
        if len(spellings) > 1
    }
    return tuple(
        ImportTitleChange(
            original_title=original_title,
            sanitized_title=sanitized_title,
            locations=tuple(locations[original_title]),
            merged=sanitized_title in merged_titles,
        )
        for original_title, sanitized_title in sorted(title_map.items())
        if original_title != sanitized_title
    )


def sanitize_export_titles(export: Export) -> SanitizedImport:
    """Sanitize all imported title identities before rows or I/O are created."""
    locations = _collect_title_locations(export)
    title_map = {
        title: sanitize_import_title(title, location=title_locations[0])
        for title, title_locations in locations.items()
    }
    rebuilt_sources = [
        _PageRebuild(
            original=page,
            rebuilt=Page(
                title=title_map[page.title],
                created_at=page.created_at,
                edited_at=page.edited_at,
                children=tuple(
                    _rewrite_block(child, title_map) for child in page.children
                ),
            ),
        )
        for page in export.pages
    ]
    rebuilt_pages, merged_pages_titles = _merge_sanitized_pages(rebuilt_sources)
    return SanitizedImport(
        export=Export(
            pages=rebuilt_pages,
            orphan_block_count=export.orphan_block_count,
            skipped_entities=export.skipped_entities,
            attr_counts=dict(export.attr_counts),
            orphan_blocks=tuple(
                _rewrite_block(block, title_map) for block in export.orphan_blocks
            ),
        ),
        title_changes=_title_changes(title_map, locations, merged_pages_titles),
    )
