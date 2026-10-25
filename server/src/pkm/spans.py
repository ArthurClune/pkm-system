# pattern: Functional Core
"""Replacing spans of a text: what a rename, an unlink or an inlined copy
does once its scanner has found where. Spans never overlap (each scanner
lets the outer match win), so the length a splice leaves is known before
the splice is made."""
from __future__ import annotations

from collections.abc import Iterable

# start, end and the text that replaces text[start:end]
Span = tuple[int, int, str]


def splice(text: str, spans: Iterable[Span]) -> str:
    """`text` with each span's range replaced, in one pass: splicing one
    span at a time copies the whole text per span, which for a megabyte of
    links is seconds. Spans that do overlap, which no scanner should
    report, are spliced one at a time from the back, as they always were."""
    ordered = sorted(spans)
    if any(a[1] > b[0] for a, b in zip(ordered, ordered[1:])):
        for start, end, replacement in reversed(ordered):
            text = text[:start] + replacement + text[end:]
        return text
    pieces: list[str] = []
    at = 0
    for start, end, replacement in ordered:
        pieces += (text[at:start], replacement)
        at = end
    pieces.append(text[at:])
    return "".join(pieces)


def spliced_length(text: str, spans: Iterable[Span]) -> int:
    """`len(splice(text, spans))`, without building the text: a caller
    bounds a splice that might grow past what it may hold."""
    return len(text) + sum(len(replacement) - (end - start)
                           for start, end, replacement in spans)
