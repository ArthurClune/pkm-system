# pattern: Functional Core
"""Extract page references from Roam-flavoured block text.

Grammar is pinned by shared/fixtures/ref_grammar.json; the TS renderer
must pass the same fixture (see design spec, Section 1).
"""
from __future__ import annotations

import re
from dataclasses import dataclass

_CODE_FENCE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`[^`\n]*`")
# No leading `\s*` here (see extract() below): `\s` is a near-subset of
# this negated class, and pairing a greedy `\s*` with a lazy quantifier
# over an overlapping class is O(n^2) to fail on an all-whitespace run of
# length n (every one of the n split points between the two groups gets
# its own full lazy re-scan). A block that is one large fenced code block
# collapses to exactly such a run once _strip_code() blanks it out
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


def is_blank_title(title: str) -> bool:
    """True when `title` has nothing in it but whitespace once normalized --
    the same test store.get_or_create_page uses to decide whether to raise
    BlankTitleError. Exposed as a pure predicate so callers that need to
    know this WITHOUT calling get_or_create_page (e.g. ops_apply's
    broadcast-payload enrichment, which must tell whether a page_title fell
    back to the "Untitled" sentinel without re-deriving the check by hand)
    don't have to duplicate normalize-then-strip inline.

    Deliberately NOT the same test extract()'s own "drop a blank ref" check
    uses (`if norm := normalize_title(title)`) -- that one only catches a
    title normalize_title collapses all the way to "" itself (control
    whitespace only), so a plain-spaces-only ref title like "   " survives
    it. This function additionally strips, so it also catches that case;
    callers that need the two to agree (both ref-index call sites, pkm-1rb5
    final review) call THIS function to decide whether to skip a ref."""
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


def _strip_code(text: str) -> str:
    text = _CODE_FENCE.sub(lambda m: " " * len(m.group()), text)
    return _INLINE_CODE.sub(lambda m: " " * len(m.group()), text)


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
    clean = _strip_code(text)
    refs: list[Ref] = []
    # Leading whitespace is stripped here (a plain, linear str.lstrip()) so
    # _ATTRIBUTE only ever has to match once, at a fixed start position --
    # see the comment on _ATTRIBUTE for why folding this into the regex
    # itself is quadratic on pathological input.
    # Every title goes through normalize_title, and one that normalizes to
    # empty is not a reference at all (`[[]]` and `[[\n]]` used to mint a
    # blank-titled page). Hashtag titles cannot hold whitespace, so the
    # call is a no-op there -- applied anyway to keep the rule uniform.
    if m := _ATTRIBUTE.match(clean.lstrip()):
        if title := normalize_title(m.group(1).strip()):
            refs.append(Ref(title, "attribute"))
    for title, is_tag in _scan_brackets(clean):
        if norm := normalize_title(title):
            refs.append(Ref(norm, "tag" if is_tag else "link"))
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
