# pattern: Imperative Shell
"""Run a planned `{{query}}` expression against the database.

Planning stays pure in `query.py`; executing a plan is I/O, so it lives
here. Every surface that executes one comes through this module -- the live
`/api/query` endpoint (routes_search) and the resolved single-page markdown
export (routes_export) -- so the source-block exclusion, the total and the
row ordering cannot drift apart between them. Result *shaping* stays with
each route: /api/query returns `grouping.group_by_page` dicts, the export
its own typed groups.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

# Excludes a query's own matching blocks from its results: a block whose
# text IS a {{query: ...}} macro, not one it merely returned. Both bracket
# forms the editor can emit; ltrim because a quoted/indented macro block
# still counts as one.
_SOURCE_FILTER = (
    "NOT (ltrim(b.text) LIKE '{{[[query]]:%' OR ltrim(b.text) LIKE '{{query:%')"
)


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
