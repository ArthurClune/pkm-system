# pattern: Functional Core
"""Extract page references from Roam-flavoured block text.

Grammar is pinned by shared/fixtures/ref_grammar.json; the TS renderer
must pass the same fixture (see design spec, Section 1).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Iterator, Literal, NewType

from pkm.contracts.brands import brand

# A title that has been through normalize_title: control whitespace
# collapsed, no other byte changed. Not every str is one -- minted only by
# normalize_title (and anything built from its output).
NormalizedTitle = NewType("NormalizedTitle", str)
brand(NormalizedTitle)
# A NormalizedTitle that has also been through canonicalize_title: the exact
# spelling a lookup against pages.title/sidebar_entries.title must use.
# Minted only by canonicalize_title and by reading those columns back.
CanonicalTitle = NewType("CanonicalTitle", NormalizedTitle)
# Its own brand: a NewType of a branded NewType otherwise inherits
# NormalizedTitle's marker.
brand(CanonicalTitle)

# A ``` run followed by a word character is a fence *opener* with an info
# string (```css, ```mermaid), never a closer -- without the lookahead, an
# outer fence pairs with the first inner example's opener, fence parity
# flips, and hex colours in the exposed code mint pages named "0277bd".
# Punctuation and whitespace after ``` still close as before.
_CODE_FENCE = re.compile(r"```.*?```(?!\w)", re.DOTALL)
_INLINE_CODE = re.compile(r"`[^`\n]*`")
# No leading `\s*` here (see attribute_title_span() below): `\s` is a
# near-subset of this negated class, and pairing a greedy `\s*` with a lazy
# quantifier over an overlapping class is O(n^2) to fail on an all-whitespace
# run of length n (every one of the n split points between the two groups
# gets its own full lazy re-scan). A block that is one large fenced code
# block collapses to exactly such a run once strip_code() blanks it out
# (a ~258KB pasted block took ~224s to `.match()` here).
_ATTRIBUTE = re.compile(r"([^\[\]{}:\n]+?)::")
# The tag name and the hashtag that carries it are one definition, so a
# rewriter can ask "would this title read back as a bare #tag?" (see
# is_bare_tag_title) without hand-copying the class.
_TAG_NAME = r"[\w/.\-]+"
_BARE_TAG = re.compile(_TAG_NAME)
_HASHTAG = re.compile(rf"(?:^|(?<=[\s(]))#({_TAG_NAME})")
# A block uid's shape, matching contracts.ops.UID_RE's {6,32} bound: a run
# outside it can never have been minted, so render.py, export/markdown.py
# and export/resolve.py import this rather than keeping their own ((token))
# pattern -- a token too long to be a real uid is then plain text on every
# surface, not just here. Web's grammar/scan.ts mirrors it by hand.
BLOCK_REF_TOKEN = r"[a-zA-Z0-9_-]{6,32}"
_BLOCK_REF = re.compile(rf"\(\(({BLOCK_REF_TOKEN})\)\)")
_EMBED = re.compile(r"\{\{\s*(?:\[\[)?embed(?:\]\])?\s*[:}]")
# Control whitespace in a page title makes the page unreachable.
# Both classes are plain character classes with a single quantifier -- no
# nested/overlapping quantifiers, so neither can backtrack (see the
# _ATTRIBUTE note above for what that costs when it goes wrong).
_CONTROL_WS = re.compile(r"[\t\n\r\f\v]")
_WS_RUN = re.compile(r"[ \t\n\r\f\v]+")


def normalize_title(title: str) -> NormalizedTitle:
    """Collapse the whitespace in a page title that holds a control char.

    A title containing a literal newline cannot be addressed through the
    HTTP API at all: Starlette compiles `{title:path}` to `.*` without
    re.DOTALL, so GET/DELETE/rename/export on /api/page/<title> all 404
    (six real pages reached that state via multi-line
    [[links]], four of them holding notes). Titles are therefore normalized
    where they are born rather than at the routes that cannot reach them.

    Deliberately narrow: a title with no control whitespace is returned
    byte for byte, so runs of plain spaces in the existing graph ("Two
    Spaces") are never collateral damage. Callers drop a title that
    normalizes to empty -- `[[\\n]]` references no page.
    """
    if _CONTROL_WS.search(title) is None:
        return NormalizedTitle(title)
    return NormalizedTitle(_WS_RUN.sub(" ", title).strip())


def canonicalize_title(title: str, *, plain_space: bool) -> NormalizedTitle:
    """Canonicalize under an explicit, caller-supplied flag value.

    This returns `NormalizedTitle`, not `CanonicalTitle`: `plain_space` here
    is whatever the caller passes, not necessarily this database's live
    `plain_space_title_canonicalization` flag, so the result is only
    "the" canonical spelling when the caller is that flag. Everywhere a
    lookup key is needed, go through `sync_meta.read_title`/`title_reader`
    (which read the live flag) or `target_canonical_title` below (which
    deliberately does not); minting `CanonicalTitle` any other way defeats
    the type the rest of the server relies on.
    """
    normalized = normalize_title(title)
    if plain_space:
        normalized = NormalizedTitle(normalized.strip(" "))
    return normalized


def target_canonical_title(title: str) -> CanonicalTitle:
    """The title's identity once plain-space canonicalization is active --
    what the one-time title migration (`pkm/title_migration.py`,
    `server/title_migration.py`) plans and applies against, independent of
    this database's live flag. The one deliberate exception to minting
    `CanonicalTitle` from the live flag: everywhere else, use
    `sync_meta.read_title`/`title_reader`.
    """
    return CanonicalTitle(canonicalize_title(title, plain_space=True))


TitleSyntaxReason = Literal["forbidden_syntax"]

# Matches the refs table's CHECK(kind IN (...)) in schema.py.
RefKind = Literal["link", "tag", "attribute"]


def title_syntax_reason(title: str) -> TitleSyntaxReason | None:
    normalized = normalize_title(title)
    if "#" in normalized or "[[" in normalized or "]]" in normalized:
        return "forbidden_syntax"
    return None


def is_blank_title(title: str) -> bool:
    """True when `title` has nothing in it but whitespace once normalized.

    This is the shared blank-title predicate for both the pure extractor and
    the store boundary: control whitespace still collapses first, then plain
    leading/trailing U+0020 decides blankness without changing any nonblank
    padded title byte-for-byte.
    """
    return not normalize_title(title).strip()


@dataclass(frozen=True)
class Ref:
    title: NormalizedTitle
    kind: RefKind


@dataclass(frozen=True)
class ParsedRefs:
    refs: tuple[Ref, ...]
    block_refs: tuple[str, ...]
    embeds: int


def strip_code(text: str) -> str:
    """Blank out fenced and inline code, keeping every other offset put.

    Each run is replaced by spaces of its own length, so a span located on
    the stripped copy indexes the original text unchanged -- that is what
    lets `rename.py` find refs here and splice the real text there.
    """
    text = _CODE_FENCE.sub(lambda m: " " * len(m.group()), text)
    return _INLINE_CODE.sub(lambda m: " " * len(m.group()), text)


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
    raw_title: str
    title: NormalizedTitle


def attribute_title_span(text: str) -> AttributeSpan | None:
    """Locate the leading `Title::` attribute in code-free text: either real
    code-stripped block text, or a synthetic `f"{title}::"` probe such as
    `rename._attribute_form`'s round-trip check.

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
    raw_title = match.group(1).strip()
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
    raw_title: str


def bracket_spans(text: str) -> tuple[BracketSpan, ...]:
    """Sole owner of `[[...]]` pairing (extractor and rewriter alike): the
    top-level runs in `text`, each holding the runs nested directly in it.

    Aligned `[[` and `]]` tokens are paired with a stack, the same pairing
    the web grammar scanner uses. Scanning advances two characters after any
    `[[` or matched `]]`, one otherwise, and a `]]` with nothing open is
    plain text. An opener that never closes is not a run and does not stop
    the scan, so `[[A and [[B]]` reports `B`, `[[[C]]` reports the single run
    whose title is `[C`, and `[[[[Link]]]` reports `Link`.

    Iterative throughout: nesting depth is bounded by the text, not by the
    Python recursion limit.
    """
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
    pairs.sort()
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
        TagSpan(m.start(), m.end(), m.group(1))
        for m in _HASHTAG.finditer(text, start, len(text) if stop is None else stop)
    )


def is_bare_tag_title(title: str) -> bool:
    """True when `title` would read back as a bare `#title`, i.e. when
    `tag_spans()` would report exactly it. A rewriter asks before keeping
    the bare form (`rename._tag_form`) instead of copying the name class."""
    return _BARE_TAG.fullmatch(title) is not None


def extract(text: str) -> ParsedRefs:
    clean = strip_code(text)
    refs: list[Ref] = []
    # Every title goes through normalize_title, and one that is blank once
    # normalized is not a reference at all (`[[]]`, `[[\n]]`, and `[[   ]]`
    # used to mint blank-titled pages). Hashtag titles cannot hold
    # whitespace, so the call is a no-op there -- applied anyway to keep
    # the rule uniform. The attribute's own normalization, and the leading
    # whitespace it has to survive, belong to attribute_title_span().
    if (attribute := attribute_title_span(clean)) is not None:
        refs.append(Ref(attribute.title, "attribute"))
    for span in iter_bracket_spans(bracket_spans(clean)):
        normalized = normalize_title(clean[span.inner_start : span.inner_end])
        if not is_blank_title(normalized):
            refs.append(Ref(normalized, "tag" if span.is_tag else "link"))
    for tag in tag_spans(clean):
        if title := normalize_title(tag.raw_title):
            refs.append(Ref(title, "tag"))
    seen: set[tuple[str, str]] = set()
    deduped = [r for r in refs
               if (r.title, r.kind) not in seen
               and not seen.add((r.title, r.kind))]
    return ParsedRefs(
        refs=tuple(deduped),
        block_refs=tuple(m.group(1) for m in _BLOCK_REF.finditer(clean)),
        embeds=len(_EMBED.findall(clean)),
    )
