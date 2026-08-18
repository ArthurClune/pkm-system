# pattern: Functional Core
"""Rewrite title references in block text for page renames and merges.

Locates spans with the same grammar refs.extract() uses (pinned by
shared/fixtures/ref_grammar.json): [[Title]], #[[Title]], #Title, and a
leading Title:: attribute -- the attribute through refs.attribute_title_span(),
so an indented one is a ref to both modules or to neither. Code spans are
never rewritten. Forms are preserved where the new title still parses in that
form and downgraded otherwise (#tag -> #[[..]], attribute -> [[..]]).

How a written spelling maps onto a replacement key is the caller's to state,
via `normalize` -- see rewrite_title_refs_map().
"""
from __future__ import annotations

import re
from typing import Callable, Mapping

from pkm.refs import attribute_title_span, strip_code

_BARE_TAG = re.compile(r"[\w/.\-]+")  # _HASHTAG's capture class

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
    if _BARE_TAG.fullmatch(new_title):
        return f"#{new_title}"
    return f"#[[{new_title}]]"


def _attribute_form(new_title: str) -> str:
    span = attribute_title_span(f"{new_title}::")
    if span is not None and span.raw_title == new_title:
        return f"{new_title}::"
    return f"[[{new_title}]]"


def _matching_bracket_end(text: str, start: int, stop: int) -> int | None:
    depth = 1
    index = start + 2
    while index < stop - 1 and depth:
        pair = text[index : index + 2]
        if pair == "[[":
            depth += 1
            index += 2
        elif pair == "]]":
            depth -= 1
            index += 2
        else:
            index += 1
    return index if depth == 0 else None


def _scan_range(
    clean: str,
    lookup: _TitleLookup,
    start: int,
    stop: int,
    spans: list[tuple[int, int, str]],
) -> None:
    index = start
    while index < stop:
        if clean.startswith("#[[", index):
            close = _matching_bracket_end(clean, index + 1, stop)
            if close is not None:
                inner_start = index + 3
                inner_end = close - 2
                new_title = lookup(clean[inner_start:inner_end])
                if new_title is not None:
                    spans.append((index, close, f"#[[{new_title}]]"))
                else:
                    _scan_range(clean, lookup, inner_start, inner_end, spans)
                index = close
                continue

        if clean.startswith("[[", index):
            close = _matching_bracket_end(clean, index, stop)
            if close is not None:
                inner_start = index + 2
                inner_end = close - 2
                new_title = lookup(clean[inner_start:inner_end])
                if new_title is not None:
                    spans.append((index, close, f"[[{new_title}]]"))
                else:
                    _scan_range(clean, lookup, inner_start, inner_end, spans)
                index = close
                continue

        if clean[index] == "#" and (index == 0 or clean[index - 1].isspace() or clean[index - 1] == "("):
            match = _BARE_TAG.match(clean, index + 1)
            if match is not None:
                new_title = lookup(match.group(0))
                if new_title is not None:
                    spans.append((index, match.end(), _tag_form(new_title)))
                index = match.end()
                continue

        index += 1


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

    _scan_range(clean, lookup, 0, len(clean), spans)

    out = text
    for start, end, replacement in sorted(spans, reverse=True):
        out = out[:start] + replacement + out[end:]
    return out


def rewrite_title_refs(text: str, old_title: str, new_title: str) -> str:
    return rewrite_title_refs_map(text, {old_title: new_title})
