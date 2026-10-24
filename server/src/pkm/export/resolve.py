# pattern: Functional Core
"""Resolve {{query: ...}} macros and ((block refs)) to plain readable text
for the end-user single-page export -- unlike
`pkm.export.markdown.render_page` (the nightly-backup / whole-db-zip
renderer, `export_graph`'s Core), which intentionally keeps the raw query
command and does one-level ((ref)) substitution wrapped in parens. That
renderer is untouched; this module adds a second, resolved rendering mode
alongside it, so backup semantics never change.

Depth caps mirror the live UI's own recursion guards (same numbers, same
"shared depth counter" shape) so the exported text matches what a reader of
the live page would see:
  web/src/components/BlockRef.tsx   MAX_DEPTH = 3 (block refs)
  web/src/components/QueryBlock.tsx MAX_DEPTH = 2 (nested queries)

Both refs and queries are resolved against flat, precomputed maps (built by
the Imperative Shell in routes_export.py) rather than by re-fetching along
whatever path led to a piece of text. A cycle (A -> B -> A) therefore cannot
recurse forever: each hop just re-substitutes the same precomputed text and
increments the shared depth counter until one of the caps above trips and
the innermost ((uid)) / {{query: ...}} is left raw.

The depth caps bound how deep expansion goes, not how much it produces: K
refs a level over three levels is K**3 copies of the leaf. A character
budget (EXPORT_MAX_CHARS, one per render_page_resolved call, shared by
every block and every recursion) bounds the output, and running out raises
ExportTooLarge. It is charged as each piece of text is appended -- a
literal slice of source text, a query header, an indent -- never on a
finished string, because expansion is built bottom-up: a check on the
result would come only after all K**3 copies had been built.
A recursive result is not charged again by its caller, so the count equals
the finished body's length and the refusal is exact.
"""
from __future__ import annotations

import re
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from pkm.contracts.ops import BlockUid
from pkm.contracts.titles import CanonicalTitle
from pkm.export.markdown import rewrite_asset_links
from pkm.refs import BLOCK_REF_TOKEN

if TYPE_CHECKING:
    from pkm.contracts.responses import BlockNode

BLOCK_REF_MAX_DEPTH = 3
QUERY_MAX_DEPTH = 2
EXPORT_MAX_CHARS = 10_000_000

_BLOCK_REF_RE = re.compile(rf"\(\(({BLOCK_REF_TOKEN})\)\)")
# Mirrors web/src/grammar/tokenize.ts's QUERY_PREFIX (no case-insensitivity,
# same optional-bracket shape on each side of "query").
_QUERY_PREFIX_RE = re.compile(r"\{\{(?:\[\[)?query(?:\]\])?:\s*")


class ExportTooLarge(Exception):
    """The resolved page would pass its character budget."""


class _Budget:
    """Characters one render may still produce; charge() raises before the
    piece it is charged for is appended."""

    __slots__ = ("left",)

    def __init__(self, max_chars: int) -> None:
        self.left = max_chars

    def charge(self, n: int) -> None:
        self.left -= n
        if self.left < 0:
            raise ExportTooLarge


def _unbounded() -> _Budget:
    return _Budget(sys.maxsize)


@dataclass(frozen=True)
class QueryResultItem:
    uid: BlockUid
    text: str


@dataclass(frozen=True)
class QueryResultGroup:
    page_title: CanonicalTitle
    items: tuple[QueryResultItem, ...]


@dataclass(frozen=True)
class QueryResult:
    total: int
    groups: tuple[QueryResultGroup, ...]


def find_query_macros(text: str) -> list[tuple[int, int, str]]:
    """Positions of {{query: ...}} / {{[[query]]: ...}} macros: a list of
    (start, end, expr) covering the whole "{{...}}" span. A balanced-brace
    scan (the query body itself contains braces), mirroring
    web/src/grammar/tokenize.ts's scanMacro."""
    out: list[tuple[int, int, str]] = []
    i, n = 0, len(text)
    while i < n - 1:
        if text[i] == "{" and text[i + 1] == "{":
            m = _QUERY_PREFIX_RE.match(text, i)
            if m:
                depth, j = 2, i + 2
                while j < n and depth:
                    if text[j] == "{":
                        depth += 1
                    elif text[j] == "}":
                        depth -= 1
                    j += 1
                if depth == 0:
                    out.append((i, j, text[m.end():j - 2].strip()))
                    i = j
                    continue
        i += 1
    return out


def render_query_result(expr: str, result: QueryResult,
                        uid_to_text: Mapping[str, str],
                        query_results: Mapping[str, QueryResult],
                        item_depth: int, *,
                        budget: _Budget | None = None) -> str:
    """A query's markdown rendering: header + results grouped by page,
    matching what QueryBlock.tsx shows live. Item text is itself resolved
    (nested refs/queries), at `item_depth` -- the depth an item's content
    renders at, i.e. one past the query macro's own depth."""
    budget = budget or _unbounded()
    plural = "" if result.total == 1 else "s"
    header = f"Query: {expr} — {result.total} result{plural}"
    if not result.groups:
        empty = f"{header}\n(no matching blocks)"
        budget.charge(len(empty))
        return empty
    budget.charge(len(header))
    lines = [header]
    for group in result.groups:
        # Each line after the header also costs its joining newline.
        budget.charge(len(group.page_title) + 3)
        lines.append(f"- {group.page_title}")
        for item in group.items:
            resolved = resolve_text(item.text, uid_to_text, query_results,
                                    item_depth, budget=budget)
            first, *rest = resolved.split("\n")
            # The resolved text, its own newlines included, is charged;
            # the item adds its newline and "  - ", and four spaces of
            # indent on each continuation line.
            budget.charge(5 + 4 * len(rest))
            lines.append(f"  - {first}")
            lines.extend(f"    {line}" for line in rest)
    return "\n".join(lines)


def resolve_text(text: str, uid_to_text: Mapping[str, str],
                 query_results: Mapping[str, QueryResult],
                 depth: int = 0, *, budget: _Budget | None = None) -> str:
    """Substitute ((block refs)) and {{query: ...}} macros in `text` with
    readable resolved text, recursing into referenced/result text with an
    incremented depth. Anything beyond its own cap (BLOCK_REF_MAX_DEPTH /
    QUERY_MAX_DEPTH) -- or missing from the precomputed maps entirely --
    is left exactly as written."""
    budget = budget or _unbounded()
    query_macros: list[tuple[int, int, str]] = (
        find_query_macros(text) if depth < QUERY_MAX_DEPTH else [])
    query_spans = [(s, e) for s, e, _ in query_macros]

    def _inside_a_query(pos: int) -> bool:
        return any(s <= pos < e for s, e in query_spans)

    ref_matches: list[re.Match[str]] = (
        [m for m in _BLOCK_REF_RE.finditer(text) if not _inside_a_query(m.start())]
        if depth < BLOCK_REF_MAX_DEPTH else [])

    events: list[tuple[int, int, str, str]] = (
        [(s, e, "query", expr) for s, e, expr in query_macros]
        + [(m.start(), m.end(), "ref", m.group(1)) for m in ref_matches])
    events.sort(key=lambda ev: ev[0])

    out: list[str] = []

    def _literal(start: int, end: int) -> None:
        budget.charge(end - start)
        out.append(text[start:end])

    pos = 0
    for start, end, kind, payload in events:
        _literal(pos, start)
        if kind == "ref":
            resolved = uid_to_text.get(payload)
            if resolved is None:
                _literal(start, end)
            else:
                out.append(resolve_text(resolved, uid_to_text, query_results,
                                        depth + 1, budget=budget))
        else:
            result = query_results.get(payload)
            if result is None:
                _literal(start, end)
            else:
                out.append(render_query_result(payload, result, uid_to_text,
                                               query_results, depth + 1,
                                               budget=budget))
        pos = end
    _literal(pos, len(text))
    return "".join(out)


def render_page_resolved(title: CanonicalTitle, tree: Sequence[BlockNode],
                         uid_to_text: Mapping[str, str],
                         query_results: Mapping[str, QueryResult],
                         max_chars: int = EXPORT_MAX_CHARS) -> str:
    """Like markdown.render_page, but ((refs)) resolve recursively to plain
    text (no wrapping parens) and {{query: ...}} macros execute to their
    matching results -- the end-user export's rendering mode. Raises
    ExportTooLarge once the body would pass `max_chars` characters."""
    budget = _Budget(max_chars)
    lines = [f"# {title}", ""]
    # Every line, these two included, ends in a newline once joined.
    budget.charge(len(lines[0]) + 2)

    def walk(nodes: Sequence[BlockNode], depth: int) -> None:
        pad = "  " * depth
        for node in nodes:
            resolved = resolve_text(node.text, uid_to_text, query_results, 0,
                                    budget=budget)
            text = rewrite_asset_links(resolved)
            first, *rest = text.split("\n")
            # The resolved text and its own newlines are charged; this adds
            # the asset-link growth, the pad and "- " or "  " on each line,
            # and the last line's newline.
            budget.charge(len(text) - len(resolved)
                          + (len(pad) + 2) * (len(rest) + 1) + 1)
            lines.append(f"{pad}- {first}")
            lines.extend(f"{pad}  {line}" for line in rest)
            walk(node.children, depth + 1)

    walk(tree, 0)
    return "\n".join(lines) + "\n"
