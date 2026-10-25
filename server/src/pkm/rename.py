# pattern: Functional Core
"""Rewrite title references in block text for page renames and merges.

Locates spans with the same grammar refs.extract() uses (pinned by
shared/fixtures/ref_grammar.json): [[Title]], #[[Title]], #Title, and a
leading Title:: attribute. It does not re-implement any of it -- refs owns
every scan (bracket_spans, tag_spans, attribute_title_span), so a spelling is
a ref to both modules or to neither. What is left here is what to do with the
spans refs reports: which one wins when they nest, and how to spell the
replacement. Code spans are never rewritten. Forms are preserved where the
new title still parses in that form and downgraded otherwise (#tag ->
#[[..]], attribute -> [[..]]).

How a written spelling maps onto a replacement key is the caller's to state,
via `normalize` -- see rewrite_title_refs_map().
"""
from __future__ import annotations

from typing import Callable, Iterable, Iterator, Literal, Mapping

from pkm.contracts.titles import RawTitle, as_raw_title
from pkm.refs import (
    BracketSpan,
    attribute_title_span,
    bracket_spans,
    is_bare_tag_title,
    strip_code,
    tag_spans,
)
from pkm.spans import Span, splice

# Resolves a title as written in the text to its replacement, or None.
_TitleLookup = Callable[[RawTitle], "RawTitle | None"]
# The replacement for one form of ref naming a new title.
_FormKind = Literal["tag", "attribute", "bracket"]
_Form = Callable[[_FormKind, RawTitle], str]


def _verbatim(text: str) -> str:
    return text


def _tag_form(new_title: RawTitle) -> str:
    if is_bare_tag_title(new_title):
        return f"#{new_title}"
    return f"#[[{new_title}]]"


def _attribute_form(new_title: RawTitle) -> str:
    span = attribute_title_span(probe := f"{new_title}::", probe)
    if span is not None and span.raw_title == new_title:
        return f"{new_title}::"
    return f"[[{new_title}]]"


def _form_of(kind: _FormKind, new_title: RawTitle) -> str:
    if kind == "tag":
        return _tag_form(new_title)
    if kind == "attribute":
        return _attribute_form(new_title)
    return f"[[{new_title}]]"


def _rewrite_tags(
    clean: str,
    lookup: _TitleLookup,
    form: _Form,
    start: int,
    stop: int,
    spans: list[Span],
) -> None:
    for tag in tag_spans(clean, start, stop):
        new_title = lookup(tag.raw_title)
        if new_title is not None:
            spans.append((tag.start, tag.end, form("tag", new_title)))


def _rewrite_range(
    clean: str,
    lookup: _TitleLookup,
    form: _Form,
    start: int,
    stop: int,
    brackets: Iterable[BracketSpan],
    spans: list[Span],
) -> None:
    """Collect the spans to splice over `clean[start:stop]`, given the bracket
    runs `refs.bracket_spans()` found directly inside it.

    Two rules the spans have to obey, and why the walk is shaped this way:

    * Nothing may overlap, because the caller splices back to front. A
      replaced run therefore ends the descent -- outer title wins -- and only
      an *unreplaced* one is opened up so its nested refs can be reached.
    * A `#[[Title]]` keeps its form for free. The span covers the bracket run
      alone, so the `#` in front of it is never spliced over, and the tag
      scan cannot claim it either (a tag name never starts with `[`).

    The descent keeps its own stack rather than recursing: no write path
    bounds `[[` nesting, so block text can nest past the recursion limit.
    """
    # Each frame is a window still to walk: where its next gap starts,
    # where the window stops, and the runs in it not yet reached.
    stack: list[tuple[int, int, Iterator[BracketSpan]]] = [
        (start, stop, iter(brackets))]
    while stack:
        index, window_stop, rest = stack.pop()
        bracket = next(rest, None)
        if bracket is None:
            _rewrite_tags(clean, lookup, form, index, window_stop, spans)
            continue
        _rewrite_tags(clean, lookup, form, index, bracket.start, spans)
        stack.append((bracket.end, window_stop, rest))
        new_title = lookup(
            as_raw_title(clean[bracket.inner_start:bracket.inner_end]))
        if new_title is not None:
            spans.append((bracket.start, bracket.end,
                          form("bracket", new_title)))
        else:
            stack.append((bracket.inner_start, bracket.inner_end,
                          iter(bracket.children)))


def spelled_or_canonical(
    canonical: Callable[[str], str], replacements: Mapping[str, RawTitle]
) -> Callable[[str], str]:
    """A `normalize` for rename and merge: the spelling as written when it is
    itself a key, else its canonical form.

    A rename's key is the stored page title, but a block may spell the page
    with padding (`[[ Old ]]`) that canonicalises to it once plain-space
    canonicalisation is active. The ref index resolves that spelling to the
    page, so a rewrite that only matched byte for byte would leave the ref
    behind and the index would recreate the page the rename had retitled.
    The key itself is tried first so a pre-activation padded key (the title
    migration's) still matches exactly.
    """
    def normalize(raw: str) -> str:
        return raw if raw in replacements else canonical(raw)

    return normalize


def title_ref_spans(
    text: str,
    replacements: Mapping[str, RawTitle],
    *,
    normalize: Callable[[str], str] = _verbatim,
) -> list[Span]:
    """The spans `rewrite_title_refs_map` splices, without splicing them.

    Every span renaming to one title shares one replacement string, so the
    spans cost memory for the titles, not for every link: a caller can
    judge `spans.spliced_length` before building a text that a long title
    repeated many times would make too long to hold."""
    if not replacements:
        return []

    clean = strip_code(text)
    forms: dict[tuple[_FormKind, RawTitle], str] = {}

    def lookup(raw_title: RawTitle) -> RawTitle | None:
        return replacements.get(normalize(raw_title))

    def form(kind: _FormKind, new_title: RawTitle) -> str:
        key = (kind, new_title)
        if key not in forms:
            forms[key] = _form_of(kind, new_title)
        return forms[key]

    spans: list[Span] = []
    # A replaced attribute wins over the `#tag`s in its name (`#a b::` is
    # the attribute `#a b` and the tag `a`), as an outer bracket run wins:
    # the scan resumes past it. A name holds no `[`, so no run starts
    # inside it.
    scan_from = 0

    if (attribute := attribute_title_span(clean, text)) is not None:
        new_title = lookup(attribute.raw_title)
        if new_title is not None:
            spans.append((attribute.start, attribute.end,
                          form("attribute", new_title)))
            scan_from = attribute.end

    _rewrite_range(
        clean, lookup, form, scan_from, len(clean),
        bracket_spans(clean, text), spans
    )
    return spans


def rewrite_title_refs_map(
    text: str,
    replacements: Mapping[str, RawTitle],
    *,
    normalize: Callable[[str], str] = _verbatim,
) -> str:
    r"""Rewrite every title ref in `text` according to `replacements`.

    `normalize` says how a title as written maps onto a replacement key, and
    is the whole raw-versus-normalized question: the default matches the
    spelling in the text byte for byte, which is what a rename or the title
    migration wants -- their keys are the stored page titles, padding and
    all. A caller whose keys come from `refs.extract()` passes
    `refs.normalize_title`, so `[[Two\nLine]]` still finds the `Two Line`
    entry the extractor recorded. Replacement values stay opaque either way:
    a value is never rescanned as another source spelling.
    """
    return splice(text, title_ref_spans(text, replacements,
                                        normalize=normalize))


def rewrite_title_refs(text: str, old_title: RawTitle,
                       new_title: RawTitle) -> str:
    return rewrite_title_refs_map(text, {old_title: new_title})
