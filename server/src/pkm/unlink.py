# pattern: Functional Core
"""Rewrite and plan the unlinking that deleting a page performs.

Deleting a page turns every inbound title link into plain text and every
block ref into the page's block copied in place. Spans come from the same
scanners `refs.extract()` uses (bracket_spans, tag_spans,
attribute_title_span), never a second grammar, and are spliced back to
front on `strip_code()` output whose offsets index the original text, as
`rename.py` does. A leading `Title::` attribute is never touched; a rewrite
that would create one, and a query macro naming the page, are reported as
blockers instead.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Literal, Mapping, Sequence

from pkm.export.resolve import find_query_macros
from pkm.refs import (
    BLOCK_REF_TOKEN,
    BracketSpan,
    attribute_title_span,
    bracket_spans,
    extract,
    strip_code,
    tag_spans,
)
from pkm.todo import with_state

# Given a title as written, is it the deleted page.
TitleMatch = Callable[[str], bool]

_ALIAS_LABEL = re.compile(r"\[([^\[\]\n]*)\]\($")
_NEWLINE_RUN = re.compile(r"[ \t]*\n\s*")
_REF_OR_EMBED = re.compile(
    rf"\{{\{{\s*(?:\[\[)?embed(?:\]\])?\s*:\s*\(\(({BLOCK_REF_TOKEN})\)\)\s*\}}\}}"
    rf"|\(\(({BLOCK_REF_TOKEN})\)\)"
)

Span = tuple[int, int, str]


def _splice(text: str, spans: list[Span]) -> str:
    for start, end, replacement in sorted(spans, reverse=True):
        text = text[:start] + replacement + text[end:]
    return text


def _unlink_tags(
    text: str, clean: str, is_target: TitleMatch, start: int, stop: int,
    spans: list[Span],
) -> None:
    for tag in tag_spans(clean, start, stop):
        if is_target(tag.raw_title):
            spans.append((tag.start, tag.end, tag.raw_title))


def _unlink_bracket(
    text: str, clean: str, bracket: BracketSpan, spans: list[Span]
) -> None:
    inner = text[bracket.inner_start:bracket.inner_end]
    if bracket.is_tag:
        spans.append((bracket.start - 1, bracket.end, inner))
        return
    alias = _ALIAS_LABEL.search(clean, 0, bracket.start)
    if alias is not None and clean[bracket.end:bracket.end + 1] == ")":
        label = text[alias.start(1):alias.end(1)]
        spans.append((alias.start(), bracket.end + 1, label))
        return
    spans.append((bracket.start, bracket.end, inner))


def _unlink_range(
    text: str, clean: str, is_target: TitleMatch, start: int, stop: int,
    brackets: Sequence[BracketSpan], spans: list[Span],
) -> None:
    """Outer match wins; an unmatched run is descended so nested links are
    reached. Nothing overlaps, so the caller can splice back to front."""
    index = start
    for bracket in brackets:
        _unlink_tags(text, clean, is_target, index, bracket.start, spans)
        if is_target(clean[bracket.inner_start:bracket.inner_end]):
            _unlink_bracket(text, clean, bracket, spans)
        else:
            _unlink_range(
                text, clean, is_target, bracket.inner_start,
                bracket.inner_end, bracket.children, spans,
            )
        index = bracket.end
    _unlink_tags(text, clean, is_target, index, stop, spans)


def unlink_title_refs(text: str, is_target: TitleMatch) -> str:
    """Turn every link, tag and aliased link to the target into plain text."""
    clean = strip_code(text)
    spans: list[Span] = []
    _unlink_range(
        text, clean, is_target, 0, len(clean), bracket_spans(clean), spans
    )
    return _splice(text, spans)


def inline_block_refs(text: str, copies: Mapping[str, str]) -> str:
    """Replace `((uid))` and a whole embed macro for each uid in `copies`."""
    if not copies:
        return text
    spans: list[Span] = []
    for match in _REF_OR_EMBED.finditer(strip_code(text)):
        uid = match.group(1) or match.group(2)
        if uid in copies:
            spans.append((match.start(), match.end(), copies[uid]))
    return _splice(text, spans)


def plain_copy(text: str) -> str:
    """The block's text as a copy: no task marker, no leading attribute, and
    newlines folded to single spaces. Refs are left for the caller."""
    text = with_state(text, None)
    attribute = attribute_title_span(strip_code(text))
    if attribute is not None:
        text = text[attribute.end:].lstrip()
    return _NEWLINE_RUN.sub(" ", text)


def apply_delete_rewrite(
    text: str, is_target: TitleMatch, copies: Mapping[str, str]
) -> str:
    return unlink_title_refs(inline_block_refs(text, copies), is_target)


BlockerReason = Literal["query", "attribute"]


@dataclass(frozen=True)
class DeleteBlocker:
    uid: str
    page_title: str
    text: str
    reason: BlockerReason


@dataclass(frozen=True)
class SourceBlock:
    uid: str
    page_title: str
    text: str


@dataclass(frozen=True)
class DeletePlan:
    rewrites: Mapping[str, str]
    unlinked: frozenset[str]
    inlined: Mapping[str, Mapping[str, str]]
    links: int
    link_pages: int
    block_refs: int
    block_ref_pages: int
    blockers: tuple[DeleteBlocker, ...]


def _build_copies(
    is_target: TitleMatch, page_blocks: Mapping[str, str]
) -> dict[str, str]:
    plain = {uid: plain_copy(text) for uid, text in page_blocks.items()}
    blanks = {uid: "" for uid in page_blocks}
    copies: dict[str, str] = {}
    for uid, text in plain.items():
        text = inline_block_refs(text, plain)
        text = inline_block_refs(text, blanks)
        copies[uid] = unlink_title_refs(text, is_target)
    return copies


def _blocker_reason(
    is_target: TitleMatch, source: SourceBlock, copies: Mapping[str, str]
) -> BlockerReason | None:
    clean = strip_code(source.text)
    for _start, _end, expr in find_query_macros(clean):
        if any(is_target(ref.title) for ref in extract(expr).refs):
            return "query"
    before = attribute_title_span(clean)
    if before is not None and is_target(before.raw_title):
        return None
    rewritten = apply_delete_rewrite(source.text, is_target, copies)
    after = attribute_title_span(strip_code(rewritten))
    if after is not None and is_target(after.raw_title):
        return "attribute"
    return None


def plan_page_delete(
    is_target: TitleMatch,
    page_blocks: Mapping[str, str],
    sources: Sequence[SourceBlock],
) -> DeletePlan:
    copies = _build_copies(is_target, page_blocks)
    rewrites: dict[str, str] = {}
    unlinked: set[str] = set()
    inlined: dict[str, Mapping[str, str]] = {}
    blockers: list[DeleteBlocker] = []
    link_pages: set[str] = set()
    ref_pages: set[str] = set()
    links = block_refs = 0
    for source in sources:
        parsed = extract(source.text)
        if any(is_target(ref.title) for ref in parsed.refs):
            links += 1
            link_pages.add(source.page_title)
        applied = {u: copies[u] for u in parsed.block_refs if u in copies}
        if applied:
            block_refs += 1
            ref_pages.add(source.page_title)
        reason = _blocker_reason(is_target, source, applied)
        if reason is not None:
            blockers.append(
                DeleteBlocker(source.uid, source.page_title, source.text, reason)
            )
            continue
        pre = inline_block_refs(source.text, applied)
        new = unlink_title_refs(pre, is_target)
        if new != source.text:
            rewrites[source.uid] = new
        if new != pre:
            unlinked.add(source.uid)
        if applied:
            inlined[source.uid] = applied
    return DeletePlan(
        rewrites=rewrites,
        unlinked=frozenset(unlinked),
        inlined=inlined,
        links=links,
        link_pages=len(link_pages),
        block_refs=block_refs,
        block_ref_pages=len(ref_pages),
        blockers=tuple(blockers),
    )
