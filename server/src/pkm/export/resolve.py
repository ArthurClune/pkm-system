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

The route gathers the query results the renderer will need before rendering,
and a page of distinct query macros, each matching much of the graph, would
otherwise hold every match of every query first. GatherBudget charges that
gather against the same limits, at a price no greater than rendering each
gathered result once costs, so it refuses only what the renderer would.
"""
from __future__ import annotations

import re
import sys
from array import array
from bisect import bisect_right
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
# What a query result item adds around its resolved text: its newline and
# "  - ".
_ITEM_CHARS = 5

_BLOCK_REF_RE = re.compile(rf"\(\(({BLOCK_REF_TOKEN})\)\)")
# Mirrors web/src/grammar/tokenize.ts's QUERY_PREFIX (no case-insensitivity,
# same optional-bracket shape on each side of "query").
_QUERY_PREFIX_RE = re.compile(r"\{\{(?:\[\[)?query(?:\]\])?:\s*")
_MACRO_SCAN_RE = re.compile("(" + _QUERY_PREFIX_RE.pattern + r")|[{}]")


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

    def too_many_chars(self) -> ExportTooLarge:
        return ExportTooLarge(
            "page too large to export: over"
            f" {_in_words(self.max_chars)} characters once block refs"
            " and queries are expanded")

    @staticmethod
    def too_many_calls() -> ExportTooLarge:
        return ExportTooLarge("page too large to export: its block refs"
                              " and queries expand too many times")

    def charge(self, n: int) -> None:
        self.left -= n
        if self.left < 0:
            raise self.too_many_chars()

    def call(self, units: int = 1) -> None:
        self.calls_left -= units
        if self.calls_left < 0:
            raise self.too_many_calls()


def _unbounded() -> _Budget:
    return _Budget(sys.maxsize)


def _scan_units(text: str) -> int:
    """Call units a resolve_text call over `text` costs."""
    return 1 + len(text) // SCAN_CHARS_PER_UNIT


class GatherBudget:
    """The renderer's limits, charged by the route while it gathers query
    results, before render_page_resolved runs. Each charge is at most what
    rendering the gathered piece once will charge, and every distinct
    expression the gather runs is rendered at least once, so a refusal here
    is one the renderer would make: a query is one render_query_result call;
    an item is one resolve_text call at the depth it renders at, plus
    _ITEM_CHARS and every character of its text outside the spans that call
    substitutes (a substitution replaces a span, never the text around it),
    plus each substituted query macro's expression, which the renderer
    writes in the result's header or, unresolved, leaves in the macro as
    written. A ref span is priced by its scan alone: resolved it costs the
    renderer a call and no characters, missing its characters and no call."""

    __slots__ = ("_budget",)

    def __init__(self, max_chars: int = EXPORT_MAX_CHARS) -> None:
        self._budget = _Budget(max_chars)

    @property
    def chars_left(self) -> int:
        return self._budget.left

    @property
    def calls_left(self) -> int:
        return self._budget.calls_left

    def charge_query(self) -> None:
        self._budget.call()

    def check_room(self, items: int) -> None:
        """Refuse, charging nothing, when `items` more items could not fit
        at one call and _ITEM_CHARS characters each: checked on a query's
        match count, before any of its rows are fetched."""
        if items > self._budget.calls_left:
            raise self._budget.too_many_calls()
        if items * _ITEM_CHARS > self._budget.left:
            raise self._budget.too_many_chars()

    def charge_item(self, text: str, depth: int) -> None:
        """Charge one query result item whose text renders at `depth`."""
        self._budget.call(_scan_units(text))
        dropped = sum(end - start - (len(payload) if kind == "query" else 0)
                      for start, end, kind, payload
                      in _substitutions(text, depth))
        self._budget.charge(_ITEM_CHARS + len(text) - dropped)


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
    web/src/grammar/tokenize.ts's scanMacro.

    A macro at i closes at the first "}" after its "{{" that brings the
    running brace balance back to its value before i: the balance moves one
    step at a time, so it cannot pass that value without landing on it. One
    forward pass finds every close, rather than a walk to the end of the
    text per unclosed prefix. A prefix waits on a stack until it closes; a
    later one opens at a higher balance, so only the top can close at any
    "}". The scan state is a few machine integers per prefix and nothing per
    brace."""
    if _QUERY_PREFIX_RE.search(text) is None:
        return []
    starts, bodies, ends = array("q"), array("q"), array("q")
    open_index, open_balance = array("q"), array("q")
    balance = 0
    for m in _MACRO_SCAN_RE.finditer(text):
        if m.group(1):
            open_index.append(len(starts))
            open_balance.append(balance)
            starts.append(m.start())
            bodies.append(m.end())
            ends.append(-1)
            balance += 2
        elif m.group() == "{":
            balance += 1
        else:
            balance -= 1
            if open_balance and open_balance[-1] == balance:
                open_balance.pop()
                ends[open_index.pop()] = m.end()
    # A closed macro hides any prefix inside it, closed or not.
    out: list[tuple[int, int, str]] = []
    after = 0
    for start, body, end in zip(starts, bodies, ends):
        if end != -1 and start >= after:
            out.append((start, end, text[body:end - 2].strip()))
            after = end
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
            budget.charge(_ITEM_CHARS + 4 * resolved.count("\n"))
            lines.append("  - " + resolved.replace("\n", "\n    "))
    return "\n".join(lines)


def _substitutions(text: str,
                   depth: int) -> list[tuple[int, int, str, str]]:
    """The spans resolve_text at `depth` substitutes, as sorted, disjoint
    (start, end, kind, payload): query macros below QUERY_MAX_DEPTH, and
    refs outside them below BLOCK_REF_MAX_DEPTH. A span whose payload is
    missing from the maps is later left as written."""
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
    return events


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
    budget.call(_scan_units(text))
    events = _substitutions(text, depth)

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
