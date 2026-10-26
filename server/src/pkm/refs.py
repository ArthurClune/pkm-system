# pattern: Functional Core
"""Extract page references from Roam-flavoured block text.

Grammar is pinned by shared/fixtures/ref_grammar.json; the TS renderer
must pass the same fixture (see design spec, Section 1).
"""
from __future__ import annotations

import re
from bisect import bisect_left
from dataclasses import dataclass
from datetime import date
from typing import Iterable, Iterator, Literal

from pkm.contracts.daily import title_for_date
from pkm.contracts.ops import BLOCK_REF_TOKEN, UID_RE, BlockUid
from pkm.contracts.tag_chars import TAG_WORD_RANGES
from pkm.contracts.titles import CanonicalTitle as CanonicalTitle
from pkm.contracts.titles import NormalizedTitle as NormalizedTitle
from pkm.contracts.titles import (MAX_PAGE_TITLE_CHARS, TITLE_WHITESPACE,
                                  RawTitle)

# A ``` run followed by a word character is a fence *opener* with an info
# string (```css, ```mermaid), never a closer -- without the lookahead, an
# outer fence pairs with the first inner example's opener, fence parity
# flips, and hex colours in the exposed code mint pages named "0277bd".
# Punctuation and whitespace after ``` still close as before.
_INLINE_CODE = re.compile(r"`[^`\n]*`")
_BACKTICK = re.compile("`")
# The word test is ASCII on purpose, and grammar/scan.ts WORD_CHAR_RE is
# the same class: a Unicode `\w` follows each runtime's Unicode table
# (Python's lags a browser's) and the web tests one UTF-16 unit, so a
# non-ASCII letter after ``` closed the fence on one side and opened one on
# the other. The two then hid different text as code and disagreed on the
# refs and the `[[` nesting depth of the same block.
_WORD_CHAR = re.compile(r"[A-Za-z0-9_]")
# No leading `\s*` here (see attribute_title_span() below): `\s` is a
# near-subset of this negated class, and pairing a greedy `\s*` with a lazy
# quantifier over an overlapping class is O(n^2) to fail on an all-whitespace
# run of length n (every one of the n split points between the two groups
# gets its own full lazy re-scan). A block that is one large fenced code
# block collapses to exactly such a run once strip_code() blanks it out
# (a ~258KB pasted block took ~224s to `.match()` here).
_ATTRIBUTE = re.compile(r"([^\[\]{}:\n]+?)::")
# A tag name's word characters are one frozen table (contracts/tag_chars.py),
# not `\w`, and grammar/scan.ts compiles the same table: each runtime's
# Unicode tables differ, so a class of its own would make the two sides
# disagree on a block's tags. The tag name and the hashtag that carries it
# are one definition, so a rewriter can ask "would this title read back as a
# bare #tag?" (see is_bare_tag_title) without hand-copying the class.
_TAG_WORD_CLASS = "".join(
    rf"\U{lo:08x}" if lo == hi else rf"\U{lo:08x}-\U{hi:08x}"
    for lo, hi in TAG_WORD_RANGES)
_TAG_NAME = rf"[{_TAG_WORD_CLASS}/.\-]+"
_BARE_TAG = re.compile(_TAG_NAME)
_HASHTAG = re.compile(rf"(?:^|(?<=[\s(]))#({_TAG_NAME})")
_BLOCK_REF = re.compile(rf"\(\(({BLOCK_REF_TOKEN})\)\)")
_EMBED = re.compile(r"\{\{\s*(?:\[\[)?embed(?:\]\])?\s*[:}]")
# The title fold's whitespace, one class built from the shared list.
# A plain character class with a single quantifier -- no nested or
# overlapping quantifiers, so it cannot backtrack (see the _ATTRIBUTE note
# above for what that costs when it goes wrong).
_WS_RUN = re.compile(f"[{re.escape(TITLE_WHITESPACE)}]+")


def normalize_title(text: str) -> NormalizedTitle:
    """Fold every whitespace run in a page title to one U+0020.

    Whitespace is `TITLE_WHITESPACE`, never a language's `\\s`: the web
    folds by the same generated list, so both sides name the same page.
    Titles are normalized where they are born and wherever a lookup key
    arrives (a page route's `{title:wholepath}`, a query param, a [[link]]
    over several lines), so a key spelled `A  B`, `A\\u00a0B` or `A B\\n`
    reaches the page `A B` and no other.

    When the fold changes nothing the title comes back byte for byte, so a
    database whose plain-space flag is off keeps a title's single-space
    edge padding (` A `). When it changes something, edge U+0020 goes too.
    After the fold every listed character is U+0020, so the strip is
    `strip(" ")`, never `strip()`, which would also take U+001C-U+001F.
    Callers drop a title that normalizes to empty -- `[[\\n]]` references
    no page.
    """
    folded = _WS_RUN.sub(" ", text)
    if folded == text:
        return NormalizedTitle(RawTitle(text))
    return NormalizedTitle(RawTitle(folded.strip(" ")))


def canonicalize_title(text: str, *, plain_space: bool) -> NormalizedTitle:
    """Canonicalize under an explicit, caller-supplied flag value: the
    whitespace fold of `normalize_title`, then, with `plain_space`, edge
    U+0020 stripped whatever the fold did. So under the flag a canonical
    title is its words joined by single spaces.

    This returns `NormalizedTitle`, not `CanonicalTitle`: `plain_space` here
    is whatever the caller passes, not necessarily this database's live
    `plain_space_title_canonicalization` flag, so the result is only
    "the" canonical spelling when the caller is that flag. Everywhere a
    lookup key is needed, go through `sync_meta.read_title`/`title_reader`
    (which read the live flag) or `target_canonical_title` below (which
    deliberately does not); minting `CanonicalTitle` any other way defeats
    the type the rest of the server relies on.
    """
    normalized = normalize_title(text)
    if plain_space:
        normalized = NormalizedTitle(RawTitle(normalized.strip(" ")))
    return normalized


def parse_block_uid(text: str) -> BlockUid | None:
    """`text` as a BlockUid, or None when it is not a well-formed uid."""
    return BlockUid(text) if UID_RE.fullmatch(text) else None


def canonical_daily_title(day: date) -> CanonicalTitle:
    """The daily page title for `day`, as the canonical title it already is:
    its fixed format never has a whitespace run to fold or boundary
    padding, all `canonicalize_title` ever changes, under either
    plain_space setting."""
    return CanonicalTitle(NormalizedTitle(RawTitle(title_for_date(day))))


def target_canonical_title(text: str) -> CanonicalTitle:
    """The title's identity once plain-space canonicalization is active --
    what the one-time title migration (`pkm/title_migration.py`,
    `server/title_migration.py`) plans and applies against, independent of
    this database's live flag. The one deliberate exception to minting
    `CanonicalTitle` from the live flag: everywhere else, use
    `sync_meta.read_title`/`title_reader`.
    """
    return CanonicalTitle(canonicalize_title(text, plain_space=True))


TitleSyntaxReason = Literal["forbidden_syntax"]
TitleRefusal = Literal["forbidden_syntax", "too_long"]

# Matches the refs table's CHECK(kind IN (...)) in schema.py.
RefKind = Literal["link", "tag", "attribute"]


_UNREACHABLE_SEGMENTS = frozenset({"", ".", ".."})


def has_unreachable_segment(text: str) -> bool:
    """Does `text`, edge-stripped as `target_canonical_title` does, hold a
    `.`, `..` or empty `/`-separated segment? Such a title has no URL: URL
    clients drop dot segments and the SPA's router collapses `//`. A blank
    title is not one; blankness is its own policy (`is_blank_title`)."""
    canonical = target_canonical_title(text)
    if not canonical.strip():
        return False
    return any(seg in _UNREACHABLE_SEGMENTS for seg in canonical.split("/"))


def title_syntax_reason(text: str) -> TitleSyntaxReason | None:
    """Why `text` cannot be a page title, or None.

    A title is refused when no `[[Title]]` spelling reads back as it: `#`,
    `[[` and `]]` are ref syntax, a trailing `]` merges with the closing
    `]]` (`[[a]]]` is the title `a`), and a backtick pairs with another one
    on the line into a code span that hides the ref. It is also refused
    when it has no URL (`has_unreachable_segment`), and when it ends in
    `[`: unlinking `[[a[]]` leaves `a[`, which joins a following `[a[]]`
    into a fresh link, so a page delete's unlink re-forms a link per pass.

    Every rule judges the edge-stripped title (`target_canonical_title`),
    whatever this database's plain-space flag: the pure ops check never
    knows the flag, and must not pass ` a] ` where the store, under the
    flag, then sees `a]`."""
    canonical = target_canonical_title(text)
    if ("#" in canonical or "[[" in canonical or "]]" in canonical
            or canonical.endswith(("]", "[")) or "`" in canonical
            or has_unreachable_segment(canonical)):
        return "forbidden_syntax"
    return None


def title_length_over(text: str) -> int | None:
    """The length of `text`'s fold when that is over MAX_PAGE_TITLE_CHARS,
    else None. Code points of the fold, not of the raw text: a whitespace
    run stores as one space. Not of the flag's canonical form either: the
    fold is the longest a stored title can be under either plain-space
    setting, and the pure ops check never knows the flag. The fold never
    lengthens, so a short text skips it."""
    if len(text) <= MAX_PAGE_TITLE_CHARS:
        return None
    measured = len(normalize_title(text))
    return measured if measured > MAX_PAGE_TITLE_CHARS else None


def describe_title_length(measured: int) -> str:
    """The refusal for a title `title_length_over` measured."""
    return (f"title of {measured} characters is over the limit of"
            f" {MAX_PAGE_TITLE_CHARS}")


def title_refusal(text: str) -> TitleRefusal | None:
    """Why `text` cannot be a page title, or None. Length is judged
    first, so a refusal never has to name a title millions of characters
    long, and the syntax scan never reads one."""
    if title_length_over(text) is not None:
        return "too_long"
    return title_syntax_reason(text)


def is_blank_title(text: str) -> bool:
    """True when `text` has nothing in it but whitespace once normalized.

    This is the shared blank-title predicate for both the pure extractor and
    the store boundary: the title's whitespace runs fold first, then
    Python's `strip()` decides blankness without changing any nonblank
    padded title byte-for-byte. `strip()` is wider than `TITLE_WHITESPACE`
    (it also takes U+001C-U+001F); the web mirrors it as `stripLikePython`.
    """
    return not normalize_title(text).strip()


@dataclass(frozen=True)
class Ref:
    title: NormalizedTitle
    kind: RefKind


@dataclass(frozen=True)
class ParsedRefs:
    refs: tuple[Ref, ...]
    block_refs: tuple[BlockUid, ...]
    embeds: int


def _fence_end(text: str, start: int) -> int:
    """End of the closed fence opening at `start`, or -1 when none closes.

    A closer is a ``` run not followed by an ASCII word character (see
    `_WORD_CHAR`).
    """
    close = text.find("```", start + 3)
    while close != -1 and close + 3 < len(text) and _WORD_CHAR.match(
        text, close + 3
    ):
        close = text.find("```", close + 1)
    return -1 if close == -1 else close + 3


def strip_code(text: str) -> str:
    """Blank out fenced and inline code, keeping every other offset put.

    Each run is replaced by spaces of its own length, so a span located on
    the stripped copy indexes the original text unchanged -- that is what
    lets `rename.py` find refs here and splice the real text there.

    One left-to-right pass, whichever code marker starts first wins: a lone
    backtick that closes on the first backtick of a following ``` run is
    inline code, and the rest is no fence (grammar/scan.ts scanCode does the
    same). An unclosed ``` falls through to the inline rule, which takes the
    first two backticks.

    Linear: a closer search that finds nothing from one opener finds nothing
    from any later opener (its window is a suffix of the first), so after one
    failure the fence rule is never tried again. Without that memo, a block
    of many ```lang openers and no closer rescans the whole text per opener.
    """
    parts: list[str] = []
    last = 0
    i = 0
    fence_possible = True
    while True:
        i = text.find("`", i)
        if i == -1:
            break
        if fence_possible and text.startswith("```", i):
            end = _fence_end(text, i)
            if end != -1:
                parts.append(text[last:i])
                parts.append(" " * (end - i))
                last = i = end
                continue
            fence_possible = False
        inline = _INLINE_CODE.match(text, i)
        if inline is not None:
            parts.append(text[last:i])
            parts.append(" " * (inline.end() - i))
            last = i = inline.end()
            continue
        i += 1
    parts.append(text[last:])
    return "".join(parts)


def backtick_positions(source: str) -> list[int]:
    """Where `source` holds a backtick, ascending: the index `holds_backtick`
    searches, built once per text so a deeply nested one stays linear."""
    return [m.start() for m in _BACKTICK.finditer(source)]


def holds_backtick(ticks: list[int], start: int, end: int) -> bool:
    """Does the text as written hold a backtick in `[start, end)`? `ticks` is
    `backtick_positions` of that text.

    The one rule that keeps a title with a backtick out of the ref grammar:
    a link, `#[[tag]]` or attribute whose title, *as written*, holds one is
    no ref at all (plain text, like `[[.]]`). It must be asked of the
    original text, because `strip_code()` has blanked a closed code span to
    spaces and a ref found on the blanked copy would otherwise keep its
    padding and lose the code on a rewrite. Page titles with a backtick are
    refused separately (`title_syntax_reason`). A bare `#tag` never reaches
    this: its name class has no backtick and no space for code to hide in.
    """
    k = bisect_left(ticks, start)
    return k < len(ticks) and ticks[k] < end


@dataclass(frozen=True)
class AttributeSpan:
    """A leading `Title::` attribute: where it sits and both its spellings.

    `start` is the first character of the attribute name and `end` is just
    past the `::`, so the whitespace a block is indented by is never inside
    the span. `raw_title` is the name as written (outer whitespace trimmed);
    `title` is the page it refers to, i.e. `raw_title` normalized. Holding
    both is the point: a rewriter matches the spelling in the text while an
    extractor records the normalized identity.
    """

    start: int
    end: int
    raw_title: RawTitle
    title: NormalizedTitle


def attribute_title_span(text: str, source: str) -> AttributeSpan | None:
    """Locate the leading `Title::` attribute in code-free text: either real
    code-stripped block text, or a synthetic `f"{title}::"` probe such as
    `rename._attribute_form`'s round-trip check.

    `source` is the text as written, whose offsets `text` shares (a probe
    passes itself): an attribute whose name holds a backtick there is none.

    Sole owner of the attribute's whitespace anchoring: leading whitespace is
    removed by a linear `lstrip()` and the pattern is then matched once at
    that offset, rather than folded into the regex (see `_ATTRIBUTE` for what
    that costs). Because the scan starts past every leading whitespace
    character, the captured name always begins with a non-whitespace one, so
    `title` is never blank -- callers rely on that instead of re-checking.
    """
    offset = len(text) - len(text.lstrip())
    match = _ATTRIBUTE.match(text, offset)
    if match is None:
        return None
    if holds_backtick(backtick_positions(source), match.start(1), match.end(1)):
        return None
    raw_title = RawTitle(match.group(1).strip())
    return AttributeSpan(
        start=match.start(1),
        end=match.end(),
        raw_title=raw_title,
        title=normalize_title(raw_title),
    )


@dataclass(frozen=True)
class BracketSpan:
    """One balanced `[[...]]` run and the runs nested inside it.

    `start`/`end` bracket the whole run, brackets included; `inner_start`/
    `inner_end` bracket the title text between them, which is where the
    `children` were scanned from. `is_tag` is the `#[[...]]` spelling, and
    only a top-level run can carry it -- a `#` inside a title is title text.

    Positions are the point. An extractor only wants the titles, but a
    rewriter needs to splice the *original* text, and the two must agree on
    which runs exist. Offsets index whatever text was scanned, so passing
    `strip_code()`'s output yields spans that index the original (see
    `strip_code`), which is what `rename.py` does.
    """

    start: int
    end: int
    inner_start: int
    inner_end: int
    is_tag: bool
    children: tuple[BracketSpan, ...]


@dataclass(frozen=True)
class TagSpan:
    """A `#tag`: the whole match, and the name as written after the `#`."""

    start: int
    end: int
    raw_title: RawTitle


def _bracket_pairs(text: str, source: str) -> list[tuple[int, int]]:
    """The `[[...]]` runs `bracket_spans` reports, as (open, close) offsets
    sorted by open: `close` is just past the `]]`. Its docstring owns the
    pairing rules; this is the flat list it nests."""
    pairs: list[tuple[int, int]] = []
    opens: list[int] = []
    n = len(text)
    i = 0
    while i < n - 1:
        pair = text[i : i + 2]
        if pair == "[[":
            opens.append(i)
            i += 2
        elif pair == "]]" and opens:
            pairs.append((opens.pop(), i + 2))
            i += 2
        else:
            i += 1
    ticks = backtick_positions(source)
    return sorted(
        p for p in pairs if not holds_backtick(ticks, p[0] + 2, p[1] - 2)
    )


def bracket_spans(text: str, source: str) -> tuple[BracketSpan, ...]:
    """Sole owner of `[[...]]` pairing (extractor and rewriter alike): the
    top-level runs in `text`, each holding the runs nested directly in it.

    Aligned `[[` and `]]` tokens are paired with a stack, the same pairing
    the web grammar scanner uses. Scanning advances two characters after any
    `[[` or matched `]]`, one otherwise, and a `]]` with nothing open is
    plain text. An opener that never closes is not a run and does not stop
    the scan, so `[[A and [[B]]` reports `B`, `[[[C]]` reports the single run
    whose title is `[C`, and `[[[[Link]]]` reports `Link`.

    `source` is the text as written, whose offsets `text` shares (a caller
    with no code to strip passes the text itself). A run whose title holds a
    backtick there is no run (`holds_backtick`): it is dropped before the
    runs are nested, so its children are promoted and an enclosing run, whose
    title holds the same backtick, is dropped with it.

    Iterative throughout: nesting depth is bounded by the text, not by the
    Python recursion limit.
    """
    pairs = _bracket_pairs(text, source)
    # Matched pairs nest properly, so in open order a pair's parent is the
    # nearest earlier pair still enclosing it.
    parent: list[int] = []
    enclosing: list[int] = []
    roots: list[int] = []
    for k, (open_, close) in enumerate(pairs):
        while enclosing and open_ >= pairs[enclosing[-1]][1]:
            enclosing.pop()
        if enclosing:
            parent.append(enclosing[-1])
        else:
            parent.append(-1)
            roots.append(k)
        enclosing.append(k)
    kids: list[list[BracketSpan]] = [[] for _ in pairs]
    built: list[BracketSpan | None] = [None] * len(pairs)
    # Children open after their parent, so a reverse pass has every child
    # built before the parent that holds it.
    for k in range(len(pairs) - 1, -1, -1):
        open_, close = pairs[k]
        span = BracketSpan(
            start=open_,
            end=close,
            inner_start=open_ + 2,
            inner_end=close - 2,
            is_tag=parent[k] == -1 and open_ > 0 and text[open_ - 1] == "#",
            children=tuple(reversed(kids[k])),
        )
        built[k] = span
        if parent[k] != -1:
            kids[parent[k]].append(span)
    return tuple(span for k in roots if (span := built[k]) is not None)


def link_nesting_depth(text: str) -> int:
    """How deep `text`'s `[[...]]` runs nest: the height of the run tree
    `bracket_spans` builds over the code-stripped text, 0 when it has no
    run. `#[[` counts like `[[`; brackets in code, an unclosed `[[`, a
    stray `]]` and a run whose title holds a backtick do not.

    Walks the sorted pairs with a stack instead of building spans, so a
    text nested hundreds of thousands deep is measured without recursion
    and without allocating a tree. grammar/scan.ts linkNestingDepth is the
    web's copy, pinned equal by shared/fixtures/text_limits_parity.json.
    """
    pairs = _bracket_pairs(strip_code(text), text)
    closes: list[int] = []  # close offsets of the pairs enclosing this one
    deepest = 0
    for open_, close in pairs:
        while closes and open_ >= closes[-1]:
            closes.pop()
        closes.append(close)
        deepest = max(deepest, len(closes))
    return deepest


def iter_bracket_spans(spans: Iterable[BracketSpan]) -> Iterator[BracketSpan]:
    """Flatten a span tree outer-first, which is the order refs are reported
    in: a nested link yields the outer title before the inner one."""
    stack = list(reversed(tuple(spans)))
    while stack:
        span = stack.pop()
        yield span
        stack.extend(reversed(span.children))


def tag_spans(
    text: str, start: int = 0, stop: int | None = None
) -> tuple[TagSpan, ...]:
    """Sole owner of `#tag` recognition, over `text[start:stop]`.

    The bounds are a window, not a slice: the lookbehind still reads the
    character before `start`, so a caller scanning the inside of a bracket
    run gets the same answer the whole-text scan would give there.
    """
    return tuple(
        TagSpan(m.start(), m.end(), RawTitle(m.group(1)))
        for m in _HASHTAG.finditer(text, start, len(text) if stop is None else stop)
    )


def is_bare_tag_title(text: str) -> bool:
    """True when `text` would read back as a bare `#title`, i.e. when
    `tag_spans()` would report exactly it. A rewriter asks before keeping
    the bare form (`rename._tag_form`) instead of copying the name class."""
    return _BARE_TAG.fullmatch(text) is not None


def extract(text: str) -> ParsedRefs:
    clean = strip_code(text)
    refs: list[Ref] = []
    # Every title goes through normalize_title, and one that is blank once
    # normalized is not a reference at all (`[[]]`, `[[\n]]`, and `[[   ]]`
    # used to mint blank-titled pages); nor is one with no URL
    # (`has_unreachable_segment`: `#work/` mid-typing, `[[a/../b]]`).
    # Hashtag titles cannot hold whitespace, so normalize_title is a no-op
    # there -- applied anyway to keep the rule uniform. The attribute's own
    # normalization, and the leading whitespace it has to survive, belong
    # to attribute_title_span().
    if ((attribute := attribute_title_span(clean, text)) is not None
            and not has_unreachable_segment(attribute.title)):
        refs.append(Ref(attribute.title, "attribute"))
    for span in iter_bracket_spans(bracket_spans(clean, text)):
        normalized = normalize_title(clean[span.inner_start : span.inner_end])
        if not is_blank_title(normalized) and not has_unreachable_segment(normalized):
            refs.append(Ref(normalized, "tag" if span.is_tag else "link"))
    for tag in tag_spans(clean):
        title = normalize_title(tag.raw_title)
        if title and not has_unreachable_segment(title):
            refs.append(Ref(title, "tag"))
    seen: set[tuple[str, str]] = set()
    deduped = [r for r in refs
               if (r.title, r.kind) not in seen
               and not seen.add((r.title, r.kind))]
    return ParsedRefs(
        refs=tuple(deduped),
        # The pattern is UID_RE's shape, so each capture is a uid.
        block_refs=tuple(BlockUid(m.group(1))
                         for m in _BLOCK_REF.finditer(clean)),
        embeds=len(_EMBED.findall(clean)),
    )
