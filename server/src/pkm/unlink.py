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
splice's projected length, so a copy too long to store is never built. The
nesting limit and the unlink's work are judged on the spliced text before
unlinking too, a page block's copy and each source with its copies in
(`text_limits.unlink_refused`), since the unlink's passes grow with the
depth (`unlink_title_refs`). An unlink whose passes run out before it
settles leaves a link, so the source is `residual`.
The stale path (`unlink_stale_refs`) has no blockers to report, so
`defuse_attribute` fences a leading attribute naming the page in backticks,
and a link the passes left is fenced too (`_fence_title_refs`).
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Callable, Final, Iterator, Literal, Mapping, Sequence

from pkm.contracts.ops import BlockUid, MAX_BLOCK_TEXT_CHARS
from pkm.export.resolve import find_query_macros
from pkm.refs import (
    BLOCK_REF_TOKEN,
    BracketSpan,
    CanonicalTitle,
    attribute_title_span,
    bracket_spans,
    extract,
    link_nesting_depth,
    parse_block_uid,
    strip_code,
    tag_spans,
)
from pkm.spans import Span, splice, spliced_length
from pkm.text_limits import rewrite_text_limit_violation, unlink_refused
from pkm.todo import with_state

# Given a title as written, is it the deleted page.
TitleMatch = Callable[[str], bool]

# Most copy text one page delete may count over all its referring blocks,
# each copy at its projected length once per place it lands. It bounds the
# copy work a delete does under the write lock however many blocks refer to
# the page. The rest grows with the page's and the referrers' own text and
# the copy text counted, times the unlink's passes: at most the depth plus
# three per text, and each text unlinked is held to
# `text_limits.MAX_UNLINK_WORK` in depth times length. It sits far above
# what a page written by hand needs; a referrer past it is refused as
# `limit`.
MAX_DELETE_COPY_CHARS: Final = 4 * MAX_BLOCK_TEXT_CHARS

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


def _alias_label(clean: str, end: int) -> tuple[int, int] | None:
    """The label of a `[label](` ending at `end`, as its start and end, or
    None. A label holds no `[`, `]` or newline, so its `[` is the last one
    before the `](`, and the look back stops at the run before it. A
    search from the text's start for every link made the unlink quadratic
    in its links."""
    label_end = end - 2
    if label_end < 0 or clean[label_end:end] != "](":
        return None
    opening = clean.rfind("[", 0, label_end)
    if opening == -1:
        return None
    label_start = opening + 1
    if clean.find("]", label_start, label_end) != -1 or \
            clean.find("\n", label_start, label_end) != -1:
        return None
    return label_start, label_end


def _unlink_bracket(
    text: str, clean: str, is_target: TitleMatch, bracket: BracketSpan,
    spans: list[Span],
) -> None:
    inner = text[bracket.inner_start:bracket.inner_end]
    if bracket.is_tag:
        spans.append((bracket.start - 1, bracket.end, inner))
        return
    alias = _alias_label(clean, bracket.start)
    if alias is not None and clean[bracket.end:bracket.end + 1] == ")":
        # The label replaces the whole `[label](` run, so spans already
        # collected inside it are dropped and its tags are unlinked here:
        # once the brackets go, a `#tag` at the label's start reads as one.
        # Spans are collected in order of their start, so those are the
        # last ones; rebuilding the list per alias was quadratic.
        label_start, label_end = alias
        alias_start = label_start - 1
        while spans and spans[-1][0] >= alias_start:
            spans.pop()
        before = clean[alias_start - 1:alias_start]
        probe = before + clean[label_start:label_end]
        label = text[label_start:label_end]
        for tag in sorted(tag_spans(probe, len(before)), key=lambda t: -t.start):
            if is_target(tag.raw_title):
                a, b = tag.start - len(before), tag.end - len(before)
                label = label[:a] + tag.raw_title + label[b:]
        spans.append((alias_start, bracket.end + 1, label))
        return
    spans.append((bracket.start, bracket.end, inner))


def _fence_tags(
    text: str, clean: str, is_target: TitleMatch, start: int, stop: int,
    spans: list[Span],
) -> None:
    for tag in tag_spans(clean, start, stop):
        if is_target(tag.raw_title):
            name = text[tag.start + 1:tag.end]
            spans.append((tag.start + 1, tag.end, f"`{name}`"))


def _fence_bracket(
    text: str, clean: str, is_target: TitleMatch, bracket: BracketSpan,
    spans: list[Span],
) -> None:
    inner = text[bracket.inner_start:bracket.inner_end]
    spans.append((bracket.inner_start, bracket.inner_end, f"`{inner}`"))


def _unlink_range(
    text: str, clean: str, is_target: TitleMatch, start: int, stop: int,
    brackets: Sequence[BracketSpan], spans: list[Span], fence: bool = False,
) -> None:
    """Outer match wins; an unmatched run is descended so nested links are
    reached. Nothing overlaps, so the caller can splice back to front.
    With `fence`, each match keeps its brackets and has its title fenced
    in backticks instead (`_fence_title_refs`).

    The descent keeps its own stack rather than recursing: no write path
    bounds `[[` nesting, so block text can nest past the recursion limit.
    Runs are still reached left to right, outer before inner, which
    `_unlink_bracket` relies on: an alias drops the spans already collected
    from its label onward, so a span to its right must not have been
    collected yet."""
    on_tags = _fence_tags if fence else _unlink_tags
    on_bracket = _fence_bracket if fence else _unlink_bracket
    # Each frame is a window still to walk: where its next gap starts,
    # where the window stops, and the runs in it not yet reached.
    stack: list[tuple[int, int, Iterator[BracketSpan]]] = [
        (start, stop, iter(brackets))]
    while stack:
        index, window_stop, rest = stack.pop()
        bracket = next(rest, None)
        if bracket is None:
            on_tags(text, clean, is_target, index, window_stop, spans)
            continue
        on_tags(text, clean, is_target, index, bracket.start, spans)
        stack.append((bracket.end, window_stop, rest))
        if is_target(clean[bracket.inner_start:bracket.inner_end]):
            on_bracket(text, clean, is_target, bracket, spans)
        else:
            stack.append((bracket.inner_start, bracket.inner_end,
                          iter(bracket.children)))


def _unlink_pass(text: str, is_target: TitleMatch,
                 fence: bool = False) -> str:
    clean = strip_code(text)
    spans: list[Span] = []
    _unlink_range(
        text, clean, is_target, 0, len(clean), bracket_spans(clean, text),
        spans, fence)
    return splice(text, spans)


def unlink_settled(text: str, is_target: TitleMatch) -> tuple[str, bool]:
    """`unlink_title_refs`, and whether its last pass found nothing left to
    unlink. False when the passes ran out first: the text may still link
    the target."""
    # A nested legacy link (`[[[[AI]]]]`, `[[ [[AI]] ]]`) loses one layer
    # per pass, so the depth sets the passes that change the text. Two
    # more cover what an unlink exposes: a tag a tag leaves (`##[[AI]]`,
    # then `#AI`), and one a link's `]]` hid once the tag inside it made
    # it a link to the target (`[[\n#AI\n]]#AI`). Then one pass that finds
    # nothing. Nothing bounds the passes otherwise: a
    # title ending in `[` re-forms a link after each one (`[[a[]]` then
    # `[a[]]`), such titles stored before they were refused still exist,
    # and a code span that moves as links go can show another link.
    for _ in range(link_nesting_depth(text) + 3):
        unlinked = _unlink_pass(text, is_target)
        if unlinked == text:
            return text, True
        text = unlinked
    return text, False


def unlink_title_refs(text: str, is_target: TitleMatch) -> str:
    """Turn every link, tag and aliased link to the target into plain text.

    Repeated until nothing changes, for at most the text's `[[` depth plus
    two passes that change it (`unlink_settled`), each reading the whole
    text, so a caller unlinking text it spliced together judges the depth
    times the length first (`text_limits.unlink_refused`). A link the
    passes leave is still a link: a delete reports it `residual`, and a
    stale text has it fenced (`unlink_stale_refs`)."""
    return unlink_settled(text, is_target)[0]


def _fence_title_refs(text: str, is_target: TitleMatch) -> str:
    """`text` with every link, tag and aliased link to the target kept but
    its title fenced in backticks (`[[`a[`]]`, `` #`AI` ``). Nothing is
    removed, so nothing re-forms. A run whose title holds a backtick is no
    run, so a fence that pairs with a stray backtick still leaves none;
    only a run whose title spans a line hides a nested run from the inline
    fence, and the next pass fences that one."""
    for _ in range(link_nesting_depth(text) + 2):
        fenced = _unlink_pass(text, is_target, fence=True)
        if fenced == text:
            break
        text = fenced
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
    referenced. A real delete refuses attribute blocks instead, and reports
    a source whose unlink has not settled; here what the passes left is
    fenced (`_fence_title_refs`)."""
    text, settled = unlink_settled(text, is_target)
    if not settled:
        text = _fence_title_refs(text, is_target)
    return defuse_attribute(text, is_target)


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
# reference the page or one of its blocks, as a link the unlink's passes
# leave does (`unlink_settled`); limit: the copies inlined would carry the
# block over a text limit, or further past one
# (text_limits.rewrite_text_limit_violation). The length is judged first on
# the projected inlined text before unlinking, and a page block whose own
# copy would pass the cap blocks every block that refers to it, as does a
# block whose copies would carry the delete past MAX_DELETE_COPY_CHARS.
# The nesting and the unlink's work are judged next
# (text_limits.unlink_refused), also before unlinking, on each copy and on
# the source with its copies in.
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
        self._spans: dict[BlockUid, list[Span]] = {}
        self._projected: dict[BlockUid, int] = {}
        self._built: dict[BlockUid, str | None] = {}

    def projected(self, uid: BlockUid) -> int:
        """The length of page block `uid`'s copy as the splice of the refs
        it holds, before deeper refs are blanked and links unlinked, which
        only shorten it: the work building the copy costs. Found without
        building it, and once per block: summing a block of many refs again
        for every block that refers to it is work that grows with the
        referrers, which the budget does not count (a block of refs to an
        empty block projects to 0)."""
        if uid not in self._spans:
            self._spans[uid] = block_ref_spans(self._plain[uid], self._plain)
            self._projected[uid] = spliced_length(self._plain[uid],
                                                  self._spans[uid])
        return self._projected[uid]

    def get(self, uid: BlockUid) -> str | None:
        """The copy of page block `uid`, or None when the blocks it splices
        in nest it past the cap, deeper than the block itself, or make its
        unlink too much work (`text_limits.unlink_refused`), judged before
        it is unlinked. Callers judge `projected` first. A link the
        unlink's passes leave rides into the source, whose own unlink and
        residual check see it."""
        if uid not in self._built:
            self.projected(uid)
            text = splice(self._plain[uid], self._spans[uid])
            text = inline_block_refs(text, self._blanks)
            refused = unlink_refused(self._plain[uid], text)
            self._built[uid] = None if refused else \
                unlink_title_refs(text, self._is_target)
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


def _copy_length(
    source: SourceBlock, referenced: Sequence[BlockUid], copies: _Copies,
) -> tuple[int, int] | None:
    """The length `source` would have with the copies inlined, each counted
    at its projected length (`_Copies.projected`), and the part of it the
    copies make up; None when a copy is itself over the cap. Nothing is
    built: the copies are judged before the passes that shorten them, and
    the source before unlinking. Those passes can take out any amount of
    text, so a source judged here can be refused although its final text
    would fit. A copy that blanks down to "" still costs its projected
    length to build, so counting its final length would leave that work
    unbounded."""
    places = Counter(uid for _start, _end, uid in
                     block_ref_spans(source.text, {u: u for u in referenced}))
    added = 0
    for uid in referenced:
        projected = copies.projected(uid)
        if projected > MAX_BLOCK_TEXT_CHARS:
            return None
        added += places[uid] * projected
    # the source without its refs, then each copy once per place it lands
    rest = spliced_length(source.text, block_ref_spans(
        source.text, {u: "" for u in referenced}))
    return rest + added, added


def _built_copies(
    referenced: Sequence[BlockUid], copies: _Copies,
) -> dict[BlockUid, str] | None:
    """Each referenced block's copy, or None when one is refused
    (`_Copies.get`)."""
    applied: dict[BlockUid, str] = {}
    for uid in referenced:
        copy = copies.get(uid)
        if copy is None:
            return None
        applied[uid] = copy
    return applied


def plan_page_delete(
    is_target: TitleMatch,
    page_blocks: Mapping[BlockUid, str],
    sources: Sequence[SourceBlock],
) -> DeletePlan:
    copies = _Copies(is_target, page_blocks)
    counted = 0  # copy text counted so far, against MAX_DELETE_COPY_CHARS
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
        if reason is None:
            sized = _copy_length(source, referenced, copies)
            # over the cap on its own, or past what the delete may build
            if sized is None or _over_length(source.text, sized[0]) or \
                    counted + sized[1] > MAX_DELETE_COPY_CHARS:
                reason = "limit"
            else:
                counted += sized[1]
        if reason is not None:
            blockers.append(
                DeleteBlocker(source.uid, source.page_title, source.text, reason)
            )
            continue
        # The copy text was counted above, so a source refused here has
        # still paid for the copies it had built.
        applied = _built_copies(referenced, copies)
        pre = "" if applied is None else \
            inline_block_refs(source.text, applied)
        if applied is None or unlink_refused(source.text, pre):
            blockers.append(
                DeleteBlocker(source.uid, source.page_title, source.text,
                              "limit"))
            continue
        # a link the unlink's passes leave makes the source `residual`
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
