# pattern: Functional Core
"""Rewrite title references in block text for a page rename (pkm-g0t5).

Locates spans with the same grammar refs.extract() uses (pinned by
shared/fixtures/ref_grammar.json): [[Title]], #[[Title]], #Title, and a
leading Title:: attribute. Code spans are never rewritten. Forms are
preserved where the new title still parses in that form and downgraded
otherwise (#tag -> #[[..]], attribute -> [[..]])."""
from __future__ import annotations

import re

from pkm.refs import _ATTRIBUTE, _HASHTAG, _strip_code

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


def rewrite_title_refs(text: str, old_title: str, new_title: str) -> str:
    """Return `text` with every ref to `old_title` retargeted at `new_title`.

    Spans are located on the code-stripped shadow of the text (positions
    line up: _strip_code substitutes spaces 1:1), then spliced into the
    original right-to-left so earlier offsets stay valid."""
    clean = _strip_code(text)
    spans: list[tuple[int, int, str]] = []  # (start, end, replacement)

    if (m := _ATTRIBUTE.match(clean)) and m.group(1).strip() == old_title:
        spans.append((m.start(1), m.end(), _attribute_form(new_title)))

    needle = f"[[{old_title}]]"
    i = clean.find(needle)
    while i != -1:
        spans.append((i, i + len(needle), f"[[{new_title}]]"))
        i = clean.find(needle, i + len(needle))

    for m in _HASHTAG.finditer(clean):
        if m.group(1) == old_title:
            spans.append((m.start(), m.end(), _tag_form(new_title)))

    out = text
    for start, end, repl in sorted(spans, reverse=True):
        out = out[:start] + repl + out[end:]
    return out
