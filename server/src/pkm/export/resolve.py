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
refs a level over three levels is K**3 copies of the leaf. A budget (one
per render_page_resolved call, shared by every block and every recursion)
bounds the output, and running out raises ExportTooLarge. Its characters
(EXPORT_MAX_CHARS) are charged as each piece of text is appended -- a
literal slice of source text, a query header, an indent -- never on a
finished string, because expansion is built bottom-up: a check on the
result would come only after all K**3 copies had been built.
A recursive result is not charged again by its caller, so the count equals
the finished body's length and the refusal is exact. Indents are added with
str.replace rather than by splitting into lines, so memory stays a few
objects per charged piece rather than one per line.

The budget also counts call units, at most one per CHARS_PER_CALL
characters of the character bound. Each resolve_text and
render_query_result call costs one, so refs written back to back over an
empty leaf, which produce no characters, cannot make K**3 calls. A
resolve_text call also pays for the text it scans, since text it never
outputs (a resolved query macro's padding) is rescanned on every ref.
"""
from __future__ import annotations

import re
import sys
from bisect import bisect_left, bisect_right
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
CHARS_PER_CALL = 10
# Scanning has to be paid for, but cheaply enough that the character bound
# is still the one a text-heavy page reaches: literal text is both scanned
# and output, so at the character bound its scan uses a tenth of the units.
SCAN_CHARS_PER_UNIT = 100

_BLOCK_REF_RE = re.compile(rf"\(\(({BLOCK_REF_TOKEN})\)\)")
# Mirrors web/src/grammar/tokenize.ts's QUERY_PREFIX (no case-insensitivity,
# same optional-bracket shape on each side of "query").
_QUERY_PREFIX_RE = re.compile(r"\{\{(?:\[\[)?query(?:\]\])?:\s*")
_BRACE_RE = re.compile(r"[{}]")


class ExportTooLarge(Exception):
    """The resolved page would pass its budget; the message says which."""


def _in_words(n: int) -> str:
    millions, rest = divmod(n, 1_000_000)
    return f"{millions} million" if millions and not rest else f"{n:,}"


class _Budget:
    """Characters one render may still produce, and resolve_text /
    render_query_result calls it may still make. charge() raises before the
    piece it is charged for is appended."""

    __slots__ = ("max_chars", "left", "calls_left")

    def __init__(self, max_chars: int) -> None:
        self.max_chars = max_chars
        self.left = max_chars
        self.calls_left = max_chars // CHARS_PER_CALL

    def charge(self, n: int) -> None:
        self.left -= n
        if self.left < 0:
            raise ExportTooLarge(
                "page too large to export: over"
                f" {_in_words(self.max_chars)} characters once block refs"
                " and queries are expanded")

    def call(self, units: int = 1) -> None:
        self.calls_left -= units
        if self.calls_left < 0:
            raise ExportTooLarge("page too large to export: its block refs"
                                 " and queries expand too many times")


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


def _brace_balances(text: str) -> tuple[dict[int, int], dict[int, list[int]]]:
    """The running brace balance of `text` ("{" +1, "}" -1): the balance
    before each "{", and for each balance value the positions, in order,
    of the "}" characters that bring it there."""
    before_open: dict[int, int] = {}
    closes_at: dict[int, list[int]] = {}
    balance = 0
    for m in _BRACE_RE.finditer(text):
        if m.group() == "{":
            before_open[m.start()] = balance
            balance += 1
        else:
            balance -= 1
            closes_at.setdefault(balance, []).append(m.start())
    return before_open, closes_at


def find_query_macros(text: str) -> list[tuple[int, int, str]]:
    """Positions of {{query: ...}} / {{[[query]]: ...}} macros: a list of
    (start, end, expr) covering the whole "{{...}}" span. A balanced-brace
    scan (the query body itself contains braces), mirroring
    web/src/grammar/tokenize.ts's scanMacro.

    A macro at i closes at the first "}" after its "{{" that brings the
    running balance back to its value before i: the balance moves one step
    at a time, so it cannot pass that value without landing on it. Looking
    that "}" up by bisection, rather than walking to it, keeps text of many
    unclosed prefixes from costing a walk to the end per prefix."""
    out: list[tuple[int, int, str]] = []
    balances: tuple[dict[int, int], dict[int, list[int]]] | None = None
    i = text.find("{{")
    while i != -1:
        m = _QUERY_PREFIX_RE.match(text, i)
        if m:
            if balances is None:
                balances = _brace_balances(text)
            before_open, closes_at = balances
            closes = closes_at.get(before_open[i], [])
            k = bisect_left(closes, i + 2)
            if k < len(closes):
                j = closes[k] + 1
                out.append((i, j, text[m.end():j - 2].strip()))
                i = text.find("{{", j)
                continue
        i = text.find("{{", i + 1)
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
    if budget is None:
        budget = _unbounded()
    budget.call()
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
            # The resolved text, its own newlines included, is charged;
            # the item adds its newline and "  - ", and four spaces of
            # indent on each continuation line.
            budget.charge(5 + 4 * resolved.count("\n"))
            lines.append("  - " + resolved.replace("\n", "\n    "))
    return "\n".join(lines)


def resolve_text(text: str, uid_to_text: Mapping[str, str],
                 query_results: Mapping[str, QueryResult],
                 depth: int = 0, *, budget: _Budget | None = None) -> str:
    """Substitute ((block refs)) and {{query: ...}} macros in `text` with
    readable resolved text, recursing into referenced/result text with an
    incremented depth. Anything beyond its own cap (BLOCK_REF_MAX_DEPTH /
    QUERY_MAX_DEPTH) -- or missing from the precomputed maps entirely --
    is left exactly as written."""
    if budget is None:
        budget = _unbounded()
    budget.call(1 + len(text) // SCAN_CHARS_PER_UNIT)
    query_macros: list[tuple[int, int, str]] = (
        find_query_macros(text) if depth < QUERY_MAX_DEPTH else [])
    query_starts = [s for s, _, _ in query_macros]

    def _inside_a_query(pos: int) -> bool:
        # The macros are sorted and disjoint, so only the last one starting
        # at or before `pos` can hold it: one lookup, not one per macro.
        i = bisect_right(query_starts, pos) - 1
        return i >= 0 and pos < query_macros[i][1]

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
    ExportTooLarge once the body would pass `max_chars` characters, or
    expansion would take more than one call unit per CHARS_PER_CALL of
    them."""
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
            # The resolved text and its own newlines are charged; this adds
            # the asset-link growth, the pad and "- " or "  " on each line,
            # and the last line's newline.
            budget.charge(len(text) - len(resolved)
                          + (len(pad) + 2) * (text.count("\n") + 1) + 1)
            del resolved  # one body-sized copy fewer while indenting
            lines.append(f"{pad}- " + text.replace("\n", f"\n{pad}  "))
            walk(node.children, depth + 1)

    walk(tree, 0)
    return "\n".join(lines) + "\n"
