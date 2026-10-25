# pattern: Functional Core
"""Rewrite and plan the unlinking that deleting a page performs.

Deleting a page turns every inbound title link into plain text and every
block ref into the page's block copied in place. Spans come from the same
scanners `refs.extract()` uses (bracket_spans, tag_spans,
attribute_title_span), never a second grammar, and are spliced back to
front on `strip_code()` output whose offsets index the original text, as
`rename.py` does. The delete never touches a leading `Title::` attribute; a
rewrite that would add or change one, a query macro naming the page, a
rewrite that would still reference the page, and one whose inlined copies
would put the block over a text limit are reported as blockers instead.
The length limit is judged on the inlined text before unlinking, from the
splice's projected length, so a copy too long to store is never built.
The stale path (`unlink_stale_refs`) has no blockers to report, so
`defuse_attribute` fences a leading attribute naming the page in backticks.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Callable, Iterator, Literal, Mapping, Sequence

from pkm.contracts.ops import BlockUid, MAX_BLOCK_TEXT_CHARS
from pkm.export.resolve import find_query_macros
from pkm.refs import (
    BLOCK_REF_TOKEN,
    BracketSpan,
    CanonicalTitle,
    attribute_title_span,
    bracket_spans,
    extract,
    parse_block_uid,
    strip_code,
    tag_spans,
)
from pkm.spans import Span, splice, spliced_length
from pkm.text_limits import rewrite_text_limit_violation
from pkm.todo import with_state

# Given a title as written, is it the deleted page.
TitleMatch = Callable[[str], bool]

_ALIAS_LABEL = re.compile(r"\[([^\[\]\n]*)\]\(\Z")
_NEWLINE_RUN = re.compile(r"[ \t\r]*\n\s*")
_REF_OR_EMBED = re.compile(
    rf"\{{\{{\s*(?:\[\[)?embed(?:\]\])?\s*:\s*\(\(({BLOCK_REF_TOKEN})\)\)\s*\}}\}}"
    rf"|\(\(({BLOCK_REF_TOKEN})\)\)"
)

def _unlink_tags(
    text: str, clean: str, is_target: TitleMatch, start: int, stop: int,
    spans: list[Span],
) -> None:
    for tag in tag_spans(clean, start, stop):
        if is_target(tag.raw_title):
            spans.append((tag.start, tag.end, tag.raw_title))


def _unlink_bracket(
    text: str, clean: str, is_target: TitleMatch, bracket: BracketSpan,
    spans: list[Span],
) -> None:
    inner = text[bracket.inner_start:bracket.inner_end]
    if bracket.is_tag:
        spans.append((bracket.start - 1, bracket.end, inner))
        return
    alias = _ALIAS_LABEL.search(clean, 0, bracket.start)
    if alias is not None and clean[bracket.end:bracket.end + 1] == ")":
        # The label replaces the whole `[label](` run, so spans already
        # collected inside it are dropped and its tags are unlinked here:
        # once the brackets go, a `#tag` at the label's start reads as one.
        spans[:] = [s for s in spans if s[0] < alias.start()]
        label_start, label_end = alias.span(1)
        before = clean[alias.start() - 1:alias.start()]
        probe = before + clean[label_start:label_end]
        label = text[label_start:label_end]
        for tag in sorted(tag_spans(probe, len(before)), key=lambda t: -t.start):
            if is_target(tag.raw_title):
                a, b = tag.start - len(before), tag.end - len(before)
                label = label[:a] + tag.raw_title + label[b:]
        spans.append((alias.start(), bracket.end + 1, label))
        return
    spans.append((bracket.start, bracket.end, inner))


def _unlink_range(
    text: str, clean: str, is_target: TitleMatch, start: int, stop: int,
    brackets: Sequence[BracketSpan], spans: list[Span],
) -> None:
    """Outer match wins; an unmatched run is descended so nested links are
    reached. Nothing overlaps, so the caller can splice back to front.

    The descent keeps its own stack rather than recursing: no write path
    bounds `[[` nesting, so block text can nest past the recursion limit.
    Runs are still reached left to right, outer before inner, which
    `_unlink_bracket` relies on: an alias drops the spans already collected
    from its label onward, so a span to its right must not have been
    collected yet."""
    # Each frame is a window still to walk: where its next gap starts,
    # where the window stops, and the runs in it not yet reached.
    stack: list[tuple[int, int, Iterator[BracketSpan]]] = [
        (start, stop, iter(brackets))]
    while stack:
        index, window_stop, rest = stack.pop()
        bracket = next(rest, None)
        if bracket is None:
            _unlink_tags(text, clean, is_target, index, window_stop, spans)
            continue
        _unlink_tags(text, clean, is_target, index, bracket.start, spans)
        stack.append((bracket.end, window_stop, rest))
        if is_target(clean[bracket.inner_start:bracket.inner_end]):
            _unlink_bracket(text, clean, is_target, bracket, spans)
        else:
            stack.append((bracket.inner_start, bracket.inner_end,
                          iter(bracket.children)))


def _unlink_pass(text: str, is_target: TitleMatch) -> str:
    clean = strip_code(text)
    spans: list[Span] = []
    _unlink_range(
        text, clean, is_target, 0, len(clean), bracket_spans(clean, text), spans
    )
    return splice(text, spans)


def unlink_title_refs(text: str, is_target: TitleMatch) -> str:
    """Turn every link, tag and aliased link to the target into plain text.

    Repeated until nothing changes: a nested legacy link (`[[[[AI]]]]`,
    `[[ [[AI]] ]]`) loses one layer per pass, and the outer layer would
    otherwise re-derive the page. Every pass that changes the text makes it
    shorter, so the length bounds the loop."""
    for _ in range(len(text) + 1):
        unlinked = _unlink_pass(text, is_target)
        if unlinked == text:
            break
        text = unlinked
    return text


def defuse_attribute(text: str, is_target: TitleMatch) -> str:
    """Keep a leading `Target:: v` from re-creating the page: the name is
    code-fenced in place (`` `Target`:: v ``), which `extract` reads no ref
    from. A name holding a backtick is no attribute (`refs.holds_backtick`),
    so it comes back unchanged like any other text."""
    attribute = attribute_title_span(strip_code(text), text)
    if attribute is None or not is_target(attribute.raw_title):
        return text
    name_end = attribute.start + len(attribute.raw_title)
    return (text[:attribute.start] + "`" + text[attribute.start:name_end]
            + "`" + text[name_end:])


def unlink_stale_refs(text: str, is_target: TitleMatch) -> str:
    """`unlink_title_refs` plus the leading attribute it never touches: what
    a stale offline text gets, since a rewrite of it may not leave the page
    referenced. A real delete refuses attribute blocks instead."""
    return defuse_attribute(unlink_title_refs(text, is_target), is_target)


def block_ref_spans(text: str, copies: Mapping[BlockUid, str]) -> list[Span]:
    """The spans `inline_block_refs` splices: each `((uid))` or whole embed
    macro for a uid in `copies`, replaced by that copy (one string shared by
    every ref to it)."""
    if not copies:
        return []
    spans: list[Span] = []
    for match in _REF_OR_EMBED.finditer(strip_code(text)):
        uid = parse_block_uid(match.group(1) or match.group(2))
        if uid is not None and uid in copies:
            spans.append((match.start(), match.end(), copies[uid]))
    return spans


def inline_block_refs(text: str, copies: Mapping[BlockUid, str]) -> str:
    """Replace `((uid))` and a whole embed macro for each uid in `copies`."""
    return splice(text, block_ref_spans(text, copies))


def plain_copy(text: str) -> str:
    """The block's text as a copy: no task marker, no leading attribute, and
    newlines folded to single spaces. Refs are left for the caller."""
    text = with_state(text, None)
    attribute = attribute_title_span(strip_code(text), text)
    if attribute is not None:
        text = text[attribute.end:].lstrip()
    return _NEWLINE_RUN.sub(" ", text)


def apply_delete_rewrite(
    text: str, is_target: TitleMatch, copies: Mapping[BlockUid, str]
) -> str:
    return unlink_title_refs(inline_block_refs(text, copies), is_target)


# query: a query macro names the page; used_as_attribute: the block's
# leading `Name::` attribute is the page, which a delete cannot rewrite and
# the next edit would recreate; attribute: the rewrite would change the
# block's leading attribute; residual: the rewritten text would still
# reference the page or one of its blocks; limit: the copies inlined would
# carry the block over a text limit, or further past one
# (text_limits.rewrite_text_limit_violation). The length is judged first on
# the projected inlined text before unlinking, and a page block whose own
# copy would pass the cap blocks every block that refers to it.
BlockerReason = Literal["query", "used_as_attribute", "attribute", "residual",
                        "limit"]


@dataclass(frozen=True)
class DeleteBlocker:
    uid: BlockUid
    page_title: CanonicalTitle
    text: str
    reason: BlockerReason


@dataclass(frozen=True)
class SourceBlock:
    uid: BlockUid
    page_title: CanonicalTitle
    text: str


@dataclass(frozen=True)
class DeletePlan:
    rewrites: Mapping[BlockUid, str]
    unlinked: frozenset[BlockUid]
    inlined: Mapping[BlockUid, Mapping[BlockUid, str]]
    links: int
    link_pages: int
    block_refs: int
    block_ref_pages: int
    blockers: tuple[DeleteBlocker, ...]


class _Copies:
    """The copy of each page block a source refers to, built on first use
    and kept for the next source. A copy nothing refers to is never built:
    each can be up to the cap, and a page of small blocks that each repeat
    a long block's ref would otherwise force their total."""

    def __init__(self, is_target: TitleMatch,
                 page_blocks: Mapping[BlockUid, str]) -> None:
        self._is_target = is_target
        self._plain = {uid: plain_copy(text)
                       for uid, text in page_blocks.items()}
        self._blanks = {uid: "" for uid in page_blocks}
        self._built: dict[BlockUid, tuple[str | None, int]] = {}

    def get(self, uid: BlockUid) -> tuple[str | None, int]:
        """The copy of page block `uid` and its projected length: the
        splice of the refs it holds, before deeper refs are blanked and
        links unlinked, which only shorten it. That length is the work
        building the copy costs, and the copy is None, never built, when
        it is over the cap."""
        if uid not in self._built:
            plain = self._plain[uid]
            spans = block_ref_spans(plain, self._plain)
            projected = spliced_length(plain, spans)
            copy = None
            if projected <= MAX_BLOCK_TEXT_CHARS:
                text = inline_block_refs(splice(plain, spans), self._blanks)
                copy = unlink_title_refs(text, self._is_target)
            self._built[uid] = (copy, projected)
        return self._built[uid]


def _attribute_raw(text: str) -> str | None:
    span = attribute_title_span(strip_code(text), text)
    return None if span is None else span.raw_title


def _still_refs_page(
    is_target: TitleMatch, page_blocks: Mapping[BlockUid, str], rewritten: str,
) -> bool:
    parsed = extract(rewritten)
    return any(is_target(ref.title) for ref in parsed.refs) \
        or any(uid in page_blocks for uid in parsed.block_refs)


def _source_blocker_reason(
    is_target: TitleMatch, source: SourceBlock,
) -> BlockerReason | None:
    """A blocker the source's own text shows, before any rewrite."""
    clean = strip_code(source.text)
    for _start, _end, expr in find_query_macros(clean):
        if any(is_target(ref.title) for ref in extract(expr).refs):
            return "query"
    if any(is_target(ref.title) for ref in extract(source.text).refs
           if ref.kind == "attribute"):
        return "used_as_attribute"
    return None


def _rewrite_blocker_reason(
    is_target: TitleMatch, page_blocks: Mapping[BlockUid, str],
    source: SourceBlock, rewritten: str,
) -> BlockerReason | None:
    """A blocker only the rewritten text shows."""
    # A rewrite that adds or retitles the leading attribute would turn the
    # block into a property block and create the page it names.
    if _attribute_raw(source.text) != _attribute_raw(rewritten):
        return "attribute"
    if _still_refs_page(is_target, page_blocks, rewritten):
        return "residual"
    return None


def _over_length(text: str, length: int) -> bool:
    """Is `length` over the cap and longer than `text`?"""
    return length > MAX_BLOCK_TEXT_CHARS and length > len(text)


def _inline_copies(
    source: SourceBlock, referenced: Sequence[BlockUid], copies: _Copies,
) -> dict[BlockUid, str] | None:
    """The copies `source` inlines, or None when inlining them would carry
    it over the length cap, or further past it. Each copy counts at its
    projected length (`_Copies.get`), before the passes that shorten it,
    and the source is judged before unlinking; no text that size is
    built. Those passes can take out any amount of text, so this refuses
    some texts that would come back under the cap.

    Copies are fetched one at a time, and fetching stops once the length
    so far is past the cap: the rest could only add to it. Counting each
    copy before it shortens bounds the work, since a copy that blanks
    down to "" still costs its projected length to build. A copy over the
    cap refuses the source outright."""
    places = Counter(uid for _start, _end, uid in
                     block_ref_spans(source.text, {u: u for u in referenced}))
    # the source without its refs, then each copy once per place it lands
    length = spliced_length(source.text, block_ref_spans(
        source.text, {u: "" for u in referenced}))
    applied: dict[BlockUid, str] = {}
    for uid in referenced:
        copy, projected = copies.get(uid)
        if copy is None:
            return None
        applied[uid] = copy
        length += places[uid] * projected
        if _over_length(source.text, length):
            return None
    return applied


def plan_page_delete(
    is_target: TitleMatch,
    page_blocks: Mapping[BlockUid, str],
    sources: Sequence[SourceBlock],
) -> DeletePlan:
    copies = _Copies(is_target, page_blocks)
    rewrites: dict[BlockUid, str] = {}
    unlinked: set[BlockUid] = set()
    inlined: dict[BlockUid, Mapping[BlockUid, str]] = {}
    blockers: list[DeleteBlocker] = []
    link_pages: set[str] = set()
    ref_pages: set[str] = set()
    links = block_refs = 0
    for source in sources:
        parsed = extract(source.text)
        # a leading `Title::` attribute naming the page is not rewritten,
        # so a block holding only that is not a link the delete removes
        if any(is_target(ref.title) for ref in parsed.refs
               if ref.kind != "attribute"):
            links += 1
            link_pages.add(source.page_title)
        referenced = list(dict.fromkeys(
            u for u in parsed.block_refs if u in page_blocks))
        if referenced:
            block_refs += 1
            ref_pages.add(source.page_title)
        reason = _source_blocker_reason(is_target, source)
        applied = None if reason is not None else \
            _inline_copies(source, referenced, copies)
        if applied is None:
            # a source blocker, or else the copies pass the length cap
            blockers.append(DeleteBlocker(
                source.uid, source.page_title, source.text, reason or "limit"))
            continue
        pre = inline_block_refs(source.text, applied)
        new = unlink_title_refs(pre, is_target)
        reason = _rewrite_blocker_reason(is_target, page_blocks, source, new)
        if reason is None and \
                rewrite_text_limit_violation(source.text, new) is not None:
            reason = "limit"
        if reason is not None:
            blockers.append(
                DeleteBlocker(source.uid, source.page_title, source.text, reason)
            )
            continue
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
