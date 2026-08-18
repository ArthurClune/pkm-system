# pattern: Functional Core
"""Extract page references from Roam-flavoured block text.

Grammar is pinned by shared/fixtures/ref_grammar.json; the TS renderer
must pass the same fixture (see design spec, Section 1).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

# A ``` run followed by a word character is a fence *opener* with an info
# string (```css, ```mermaid), never a closer -- without the lookahead, an
# outer fence pairs with the first inner example's opener, fence parity
# flips, and hex colours in the exposed code mint pages named "0277bd"
# (pkm-9qgk). Punctuation and whitespace after ``` still close as before.
_CODE_FENCE = re.compile(r"```.*?```(?!\w)", re.DOTALL)
_INLINE_CODE = re.compile(r"`[^`\n]*`")
# No leading `\s*` here (see extract() below): `\s` is a near-subset of
# this negated class, and pairing a greedy `\s*` with a lazy quantifier
# over an overlapping class is O(n^2) to fail on an all-whitespace run of
# length n (every one of the n split points between the two groups gets
# its own full lazy re-scan). A block that is one large fenced code block
# collapses to exactly such a run once strip_code() blanks it out
# (pkm-7myl: a ~258KB pasted block took ~224s to `.match()` here).
_ATTRIBUTE = re.compile(r"([^\[\]{}:\n]+?)::")
_HASHTAG = re.compile(r"(?:^|(?<=[\s(]))#([\w/.\-]+)")
_BLOCK_REF = re.compile(r"\(\(([a-zA-Z0-9_-]{6,})\)\)")
_EMBED = re.compile(r"\{\{\s*(?:\[\[)?embed(?:\]\])?\s*[:}]")
# pkm-hjhy: control whitespace in a page title makes the page unreachable.
# Both classes are plain character classes with a single quantifier -- no
# nested/overlapping quantifiers, so neither can backtrack (see the
# _ATTRIBUTE note above for what that costs when it goes wrong).
_CONTROL_WS = re.compile(r"[\t\n\r\f\v]")
_WS_RUN = re.compile(r"[ \t\n\r\f\v]+")


def normalize_title(title: str) -> str:
    """Collapse the whitespace in a page title that holds a control char.

    A title containing a literal newline cannot be addressed through the
    HTTP API at all: Starlette compiles `{title:path}` to `.*` without
    re.DOTALL, so GET/DELETE/rename/export on /api/page/<title> all 404
    (pkm-hjhy -- six real pages reached that state via multi-line
    [[links]], four of them holding notes). Titles are therefore normalized
    where they are born rather than at the routes that cannot reach them.

    Deliberately narrow: a title with no control whitespace is returned
    byte for byte, so runs of plain spaces in the existing graph ("Two
    Spaces") are never collateral damage. Callers drop a title that
    normalizes to empty -- `[[\\n]]` references no page.
    """
    if _CONTROL_WS.search(title) is None:
        return title
    return _WS_RUN.sub(" ", title).strip()


def canonicalize_title(title: str, *, plain_space: bool) -> str:
    normalized = normalize_title(title)
    return normalized.strip(" ") if plain_space else normalized


TitleSyntaxReason = Literal["forbidden_syntax"]


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
    title: str
    kind: str  # "link" | "tag" | "attribute"


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
    title: str


def attribute_title_span(text: str) -> AttributeSpan | None:
    """Locate the leading `Title::` attribute of code-stripped block text.

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


def _scan_brackets(text: str, nested: bool = False) -> list[tuple[str, bool]]:
    """Balanced [[...]] scan. Nested links yield outer then inner titles.
    Returns (title, is_tag) pairs; is_tag when written as #[[...]]."""
    out: list[tuple[str, bool]] = []
    i, n = 0, len(text)
    while i < n - 1:
        if text[i] == "[" and text[i + 1] == "[":
            depth, j = 1, i + 2
            while j < n - 1 and depth:
                pair = text[j : j + 2]
                if pair == "[[":
                    depth, j = depth + 1, j + 2
                elif pair == "]]":
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            if depth == 0:
                inner = text[i + 2 : j - 2]
                is_tag = not nested and i > 0 and text[i - 1] == "#"
                out.append((inner, is_tag))
                out.extend(_scan_brackets(inner, nested=True))
                i = j
                continue
        i += 1
    return out


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
    for title, is_tag in _scan_brackets(clean):
        normalized = normalize_title(title)
        if not is_blank_title(normalized):
            refs.append(Ref(normalized, "tag" if is_tag else "link"))
    for m in _HASHTAG.finditer(clean):
        if title := normalize_title(m.group(1)):
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
