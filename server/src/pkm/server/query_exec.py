# pattern: Imperative Shell
"""Parse a `{{query}}` expression with canonical operand titles, and run
a planned one against the database.

Planning stays pure in `query.py`; canonicalising operands reads the title
flag and executing a plan is I/O, so both live here. Every surface that executes one comes through this module -- the live
`/api/query` endpoint (routes_search) and the resolved single-page markdown
export (routes_export) -- so the source-block exclusion, the total and the
row ordering cannot drift apart between them. Result *shaping* stays with
each route: /api/query returns `grouping.group_by_page` dicts, the export
its own typed groups.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from pkm.server.query import QueryNode, parse_query
from pkm.server.sync_meta import title_reader

# Excludes a query's own matching blocks from its results: a block whose
# text IS a {{query: ...}} macro, not one it merely returned. Both bracket
# forms the editor can emit; ltrim because a quoted/indented macro block
# still counts as one.
_SOURCE_FILTER = (
    "NOT (ltrim(b.text) LIKE '{{[[query]]:%' OR ltrim(b.text) LIKE '{{query:%')"
)


def parse_canonical_query(db: sqlite3.Connection, expr: str) -> QueryNode:
    """`parse_query`, with every [[Page]] operand canonicalised. Operands
    are compared against `pages.title`, so `[[ Foo ]]` (spaces inside the
    brackets) must reach the plan as the canonical "Foo", the page the same
    [[ Foo ]] link resolves to. Raises `QueryParseError` like
    `parse_query`."""
    node = parse_query(expr)
    return _canonical_titles(title_reader(db), node)


def _canonical_titles(canonical: Callable[[str], str],
                      node: QueryNode) -> QueryNode:
    if node.kind == "page":
        assert node.title is not None
        return QueryNode("page", canonical(node.title))
    return QueryNode(node.kind, None,
                     tuple(_canonical_titles(canonical, c)
                           for c in node.children))


@dataclass(frozen=True)
class QueryMatches:
    """`rows` carry `uid, text, page_id, page_title` ordered by page title
    then uid, ready for `grouping.group_by_page`. `total` is counted from
    the plan independently of `rows` so that a caller which ever limits the
    rows still reports the full match count."""
    total: int
    rows: Sequence[Mapping]  # sqlite3.Row, typed as grouping.py reads it


def count_matches(db: sqlite3.Connection, sql: str,
                  params: Sequence[str]) -> int:
    """How many blocks a plan matches, its own macro blocks excluded."""
    return db.execute(
        f"""SELECT count(*) FROM ({sql}) m
              JOIN blocks b ON b.uid = m.uid
             WHERE {_SOURCE_FILTER}""",
        params).fetchone()[0]


def execute_plan(db: sqlite3.Connection, sql: str,
                 params: Sequence[str]) -> QueryMatches:
    """Total and matching rows for a `query.plan_sql` plan."""
    total = count_matches(db, sql, params)
    rows = db.execute(
        f"""SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title
              FROM ({sql}) m JOIN blocks b ON b.uid = m.uid
              JOIN pages p ON p.id = b.page_id
             WHERE {_SOURCE_FILTER}
             ORDER BY p.title, b.uid""",
        params).fetchall()
    return QueryMatches(total=total, rows=rows)
