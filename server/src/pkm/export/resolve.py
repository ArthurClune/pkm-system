# pattern: Functional Core
"""Resolve {{query: ...}} macros and ((block refs)) to plain readable text
for the end-user single-page export (pkm-kplp) -- unlike
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
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass

from pkm.export.markdown import rewrite_asset_links

BLOCK_REF_MAX_DEPTH = 3
QUERY_MAX_DEPTH = 2

_BLOCK_REF_RE = re.compile(r"\(\(([A-Za-z0-9_-]+)\)\)")
# Mirrors web/src/grammar/tokenize.ts's QUERY_PREFIX (no case-insensitivity,
# same optional-bracket shape on each side of "query").
_QUERY_PREFIX_RE = re.compile(r"\{\{(?:\[\[)?query(?:\]\])?:\s*")


@dataclass(frozen=True)
class QueryResultItem:
    uid: str
    text: str


@dataclass(frozen=True)
class QueryResultGroup:
    page_title: str
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
                        item_depth: int) -> str:
    """A query's markdown rendering: header + results grouped by page,
    matching what QueryBlock.tsx shows live. Item text is itself resolved
    (nested refs/queries), at `item_depth` -- the depth an item's content
    renders at, i.e. one past the query macro's own depth."""
    plural = "" if result.total == 1 else "s"
    header = f"Query: {expr} — {result.total} result{plural}"
    if not result.groups:
        return f"{header}\n(no matching blocks)"
    lines = [header]
    for group in result.groups:
        lines.append(f"- {group.page_title}")
        for item in group.items:
            resolved = resolve_text(item.text, uid_to_text, query_results, item_depth)
            first, *rest = resolved.split("\n")
            lines.append(f"  - {first}")
            lines.extend(f"    {line}" for line in rest)
    return "\n".join(lines)


def resolve_text(text: str, uid_to_text: Mapping[str, str],
                 query_results: Mapping[str, QueryResult],
                 depth: int = 0) -> str:
    """Substitute ((block refs)) and {{query: ...}} macros in `text` with
    readable resolved text, recursing into referenced/result text with an
    incremented depth. Anything beyond its own cap (BLOCK_REF_MAX_DEPTH /
    QUERY_MAX_DEPTH) -- or missing from the precomputed maps entirely --
    is left exactly as written."""
    query_macros = find_query_macros(text) if depth < QUERY_MAX_DEPTH else []
    query_spans = [(s, e) for s, e, _ in query_macros]

    def _inside_a_query(pos: int) -> bool:
        return any(s <= pos < e for s, e in query_spans)

    ref_matches = (
        [m for m in _BLOCK_REF_RE.finditer(text) if not _inside_a_query(m.start())]
        if depth < BLOCK_REF_MAX_DEPTH else [])

    events: list[tuple[int, int, str, str]] = (
        [(s, e, "query", expr) for s, e, expr in query_macros]
        + [(m.start(), m.end(), "ref", m.group(1)) for m in ref_matches])
    events.sort(key=lambda ev: ev[0])

    out: list[str] = []
    pos = 0
    for start, end, kind, payload in events:
        out.append(text[pos:start])
        if kind == "ref":
            resolved = uid_to_text.get(payload)
            out.append(text[start:end] if resolved is None
                       else resolve_text(resolved, uid_to_text, query_results, depth + 1))
        else:
            result = query_results.get(payload)
            out.append(text[start:end] if result is None
                       else render_query_result(payload, result, uid_to_text,
                                                query_results, depth + 1))
        pos = end
    out.append(text[pos:])
    return "".join(out)


def render_page_resolved(title: str, tree: list[dict],
                         uid_to_text: Mapping[str, str],
                         query_results: Mapping[str, QueryResult]) -> str:
    """Like markdown.render_page, but ((refs)) resolve recursively to plain
    text (no wrapping parens) and {{query: ...}} macros execute to their
    matching results -- the end-user export's rendering mode."""
    lines = [f"# {title}", ""]

    def walk(nodes: list[dict], depth: int) -> None:
        pad = "  " * depth
        for node in nodes:
            text = rewrite_asset_links(
                resolve_text(node["text"], uid_to_text, query_results, 0))
            first, *rest = text.split("\n")
            lines.append(f"{pad}- {first}")
            lines.extend(f"{pad}  {line}" for line in rest)
            walk(node["children"], depth + 1)

    walk(tree, 0)
    return "\n".join(lines) + "\n"
