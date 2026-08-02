# pattern: Functional Core
"""Rewrite title references in block text for page renames and merges.

Locates spans with the same grammar refs.extract() uses (pinned by
shared/fixtures/ref_grammar.json): [[Title]], #[[Title]], #Title, and a
leading Title:: attribute. Code spans are never rewritten. Forms are
preserved where the new title still parses in that form and downgraded
otherwise (#tag -> #[[..]], attribute -> [[..]]).
"""
from __future__ import annotations

import re
from typing import Mapping

from pkm.refs import _ATTRIBUTE, _strip_code

_BARE_TAG = re.compile(r"[\w/.\-]+")  # _HASHTAG's capture class


def _tag_form(new_title: str) -> str:
    if _BARE_TAG.fullmatch(new_title):
        return f"#{new_title}"
    return f"#[[{new_title}]]"


def _attribute_form(new_title: str) -> str:
    m = _ATTRIBUTE.match(f"{new_title}::")
    if m is not None and m.group(1).strip() == new_title:
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


def _mapped_title(
    source: str,
    target: str,
    replacements: Mapping[str, str],
    expanding: frozenset[str],
) -> str:
    """Rewrite nested sources carried inside an enclosing source's target.

    Replacement targets are not generally chained (``A -> B``, ``B -> C``
    still rewrites ``[[A]]`` to ``[[B]]``). Nested refs are different: their
    spans existed inside the matched outer title, so simultaneous migration
    semantics require them to be rewritten too. The expansion guard makes
    adversarial cyclic mappings terminate deterministically.
    """
    if source in expanding:
        return target
    return _rewrite_title_refs_map(
        target,
        replacements,
        expanding=expanding | {source},
        allow_attribute=False,
    )


def _scan_range(
    clean: str,
    replacements: Mapping[str, str],
    start: int,
    stop: int,
    spans: list[tuple[int, int, str]],
    expanding: frozenset[str],
) -> None:
    index = start
    while index < stop:
        if clean.startswith("#[[", index):
            close = _matching_bracket_end(clean, index + 1, stop)
            if close is not None:
                inner_start = index + 3
                inner_end = close - 2
                title = clean[inner_start:inner_end]
                new_title = replacements.get(title)
                if new_title is not None:
                    rendered = _mapped_title(
                        title, new_title, replacements, expanding
                    )
                    spans.append((index, close, f"#[[{rendered}]]"))
                else:
                    _scan_range(
                        clean,
                        replacements,
                        inner_start,
                        inner_end,
                        spans,
                        expanding,
                    )
                index = close
                continue

        if clean.startswith("[[", index):
            close = _matching_bracket_end(clean, index, stop)
            if close is not None:
                inner_start = index + 2
                inner_end = close - 2
                title = clean[inner_start:inner_end]
                new_title = replacements.get(title)
                if new_title is not None:
                    rendered = _mapped_title(
                        title, new_title, replacements, expanding
                    )
                    spans.append((index, close, f"[[{rendered}]]"))
                else:
                    _scan_range(
                        clean,
                        replacements,
                        inner_start,
                        inner_end,
                        spans,
                        expanding,
                    )
                index = close
                continue

        if clean[index] == "#" and (index == 0 or clean[index - 1].isspace() or clean[index - 1] == "("):
            match = _BARE_TAG.match(clean, index + 1)
            if match is not None:
                title = match.group(0)
                new_title = replacements.get(title)
                if new_title is not None:
                    rendered = _mapped_title(
                        title, new_title, replacements, expanding
                    )
                    spans.append((index, match.end(), _tag_form(rendered)))
                index = match.end()
                continue

        index += 1


def _rewrite_title_refs_map(
    text: str,
    replacements: Mapping[str, str],
    *,
    expanding: frozenset[str],
    allow_attribute: bool,
) -> str:
    clean = _strip_code(text)
    spans: list[tuple[int, int, str]] = []

    if allow_attribute and (match := _ATTRIBUTE.match(clean)) is not None:
        title = match.group(1).strip()
        new_title = replacements.get(title)
        if new_title is not None:
            rendered = _mapped_title(title, new_title, replacements, expanding)
            spans.append((match.start(1), match.end(), _attribute_form(rendered)))

    _scan_range(clean, replacements, 0, len(clean), spans, expanding)

    out = text
    for start, end, replacement in sorted(spans, reverse=True):
        out = out[:start] + replacement + out[end:]
    return out


def rewrite_title_refs_map(text: str, replacements: Mapping[str, str]) -> str:
    if not replacements:
        return text
    return _rewrite_title_refs_map(
        text,
        replacements,
        expanding=frozenset(),
        allow_attribute=True,
    )


def rewrite_title_refs(text: str, old_title: str, new_title: str) -> str:
    return rewrite_title_refs_map(text, {old_title: new_title})
