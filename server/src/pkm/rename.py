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

from typing import Callable, Iterable, Mapping

from pkm.refs import (
    BracketSpan,
    attribute_title_span,
    bracket_spans,
    is_bare_tag_title,
    strip_code,
    tag_spans,
)

# Resolves a title as written in the text to its replacement, or None.
_TitleLookup = Callable[[str], "str | None"]


def _verbatim(title: str) -> str:
    return title


def _title_lookup(
    replacements: Mapping[str, str], normalize: Callable[[str], str]
) -> _TitleLookup:
    def lookup(raw_title: str) -> str | None:
        return replacements.get(normalize(raw_title))

    return lookup


def _tag_form(new_title: str) -> str:
    if is_bare_tag_title(new_title):
        return f"#{new_title}"
    return f"#[[{new_title}]]"


def _attribute_form(new_title: str) -> str:
    span = attribute_title_span(f"{new_title}::")
    if span is not None and span.raw_title == new_title:
        return f"{new_title}::"
    return f"[[{new_title}]]"


def _rewrite_tags(
    clean: str,
    lookup: _TitleLookup,
    start: int,
    stop: int,
    spans: list[tuple[int, int, str]],
) -> None:
    for tag in tag_spans(clean, start, stop):
        new_title = lookup(tag.raw_title)
        if new_title is not None:
            spans.append((tag.start, tag.end, _tag_form(new_title)))


def _rewrite_range(
    clean: str,
    lookup: _TitleLookup,
    start: int,
    stop: int,
    brackets: Iterable[BracketSpan],
    spans: list[tuple[int, int, str]],
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
    """
    index = start
    for bracket in brackets:
        _rewrite_tags(clean, lookup, index, bracket.start, spans)
        new_title = lookup(clean[bracket.inner_start:bracket.inner_end])
        if new_title is not None:
            spans.append((bracket.start, bracket.end, f"[[{new_title}]]"))
        else:
            _rewrite_range(
                clean,
                lookup,
                bracket.inner_start,
                bracket.inner_end,
                bracket.children,
                spans,
            )
        index = bracket.end
    _rewrite_tags(clean, lookup, index, stop, spans)


def rewrite_title_refs_map(
    text: str,
    replacements: Mapping[str, str],
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
    if not replacements:
        return text

    clean = strip_code(text)
    lookup = _title_lookup(replacements, normalize)
    spans: list[tuple[int, int, str]] = []

    if (attribute := attribute_title_span(clean)) is not None:
        new_title = lookup(attribute.raw_title)
        if new_title is not None:
            spans.append(
                (attribute.start, attribute.end, _attribute_form(new_title))
            )

    _rewrite_range(
        clean, lookup, 0, len(clean), bracket_spans(clean), spans
    )

    out = text
    for start, end, replacement in sorted(spans, reverse=True):
        out = out[:start] + replacement + out[end:]
    return out


def rewrite_title_refs(text: str, old_title: str, new_title: str) -> str:
    return rewrite_title_refs_map(text, {old_title: new_title})
