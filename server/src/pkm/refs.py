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
_ATTRIBUTE = re.compile(r"^\s*([^\[\]{}:\n]+?)::")
_HASHTAG = re.compile(r"(?:^|(?<=[\s(]))#([\w/.\-]+)")
_BLOCK_REF = re.compile(r"\(\(([a-zA-Z0-9_-]{6,})\)\)")
_EMBED = re.compile(r"\{\{\s*(?:\[\[)?embed(?:\]\])?\s*[:}]")


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
    if m := _ATTRIBUTE.match(clean):
        refs.append(Ref(m.group(1).strip(), "attribute"))
    for title, is_tag in _scan_brackets(clean):
        refs.append(Ref(title, "tag" if is_tag else "link"))
    for m in _HASHTAG.finditer(clean):
        refs.append(Ref(m.group(1), "tag"))
    seen: set[tuple[str, str]] = set()
    deduped = [r for r in refs
               if (r.title, r.kind) not in seen
               and not seen.add((r.title, r.kind))]
    return ParsedRefs(
        refs=tuple(deduped),
        block_refs=tuple(m.group(1) for m in _BLOCK_REF.finditer(clean)),
        embeds=len(_EMBED.findall(clean)),
    )
