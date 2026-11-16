# pattern: Imperative Shell
"""Full-text search, query evaluation, title completion, todos and changed
blocks."""
from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import NamedTuple

from fastapi import APIRouter, Depends, HTTPException

from pkm.changed import ChangedWindowError, classify, local_tz, parse_window
from pkm.contracts.responses import (
    ChangedPayload, GroupsPayload, QueryGroup, QueryPayload, QueryRecordsPayload,
    SearchBlockHit, SearchPageHit, SearchPayload, TitlesPayload)
from pkm.contracts.int64 import Int64
from pkm.database import Db
from pkm.server.ancestors_db import fetch_parents
from pkm.server.auth import require_auth
from pkm.server.db import get_db, read_txn
from pkm.server.fts import escape_fts_query, like_escape
from pkm.server.grouping import (ChangedRow, group_by_page, group_changed,
                                    group_query_results)
from pkm.refs import CanonicalTitle
from pkm.rows import Row
from pkm.server.query import (
    plan_sql, QueryParseError)
from pkm.server.query_exec import (
    count_matches, execute_plan, iter_plan_rows, page_queries,
    parse_canonical_query)
from pkm.server.query_records_db import records_in_snapshot
from pkm.server.sync_meta import read_title
from pkm.todo import is_todo

router = APIRouter(dependencies=[Depends(require_auth)])


@router.get("/api/search", response_model=SearchPayload)
def search(q: str = "", limit: Int64 = 20, exact: bool = False,
           db: Db = Depends(get_db)) -> SearchPayload:
    limit = max(1, min(limit, 100))
    if not q.strip():
        return SearchPayload(pages=[], blocks=[])
    match = escape_fts_query(q, exact)
    pages = [SearchPageHit(id=r["page_id"], title=r["title"])
             for r in db.select(
        """SELECT p.id AS page_id, p.title FROM pages_fts f
            JOIN pages p ON p.id = f.rowid
           WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?""",
        (match, limit))]
    blocks = [SearchBlockHit(uid=r["uid"], page_title=r["page_title"],
                             snippet=r["snippet"])
              for r in db.select(
        """SELECT b.uid, p.title AS page_title,
                  snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 16)
                    AS snippet
             FROM blocks_fts f
             JOIN blocks b ON b.rowid = f.rowid
             JOIN pages p ON p.id = b.page_id
            WHERE blocks_fts MATCH ? ORDER BY rank LIMIT ?""",
        (match, limit))]
    return SearchPayload(pages=pages, blocks=blocks)


@router.get("/api/query", response_model=QueryPayload)
def run_query(expr: str, expand: bool = False,
              db: Db = Depends(get_db)) -> QueryPayload:
    try:
        node = parse_canonical_query(db, expr)
        sql, params = plan_sql(node, expand)
    except QueryParseError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # QueryPayload.ref_counts: each operand re-planned on its own and
    # counted the same way as the whole expression's total, keyed by the
    # canonical title each operand resolved to (not the raw [[...]] text),
    # so a hint for "[[ Foo ]]" reads the same as one for "[[Foo]]".
    ref_counts = {
        title: count_matches(db, *plan_sql(operand, expand))
        for title, operand in page_queries(node).items()
    }
    matches = _grouped_matches(db, sql, params)
    return QueryPayload(groups=matches.groups, total=matches.total,
                        ref_counts=ref_counts)


class _GroupedMatches(NamedTuple):
    groups: list[QueryGroup]
    total: int


def _grouped_matches(db: Db, sql: str,
                     params: Sequence[str]) -> _GroupedMatches:
    """A plan's results as `/api/query` groups them."""
    matches = execute_plan(db, sql, params)
    return _GroupedMatches(_groups(db, matches.rows), matches.total)


def _groups(db: Db, plan_rows: Sequence[Row]) -> list[QueryGroup]:
    ancestors = fetch_parents(db, [r["uid"] for r in plan_rows])
    return group_query_results(plan_rows, ancestors)


@router.get("/api/query/records", response_model=QueryRecordsPayload)
def query_records(expr: str,
                  db: Db = Depends(get_db)) -> QueryRecordsPayload:
    """`/api/query`'s results as table records. When no record has a `::`
    cell the payload also carries `groups`, the grouped blocks
    `/api/query` returns for the same expression."""
    try:
        node = parse_canonical_query(db, expr)
        sql, params = plan_sql(node)
    except QueryParseError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # One snapshot, so the groups cannot show a result the records lack.
    with read_txn(db):
        rows = list(iter_plan_rows(db, sql, params))
        found = records_in_snapshot(db, rows)
        # The blocks view is the default exactly when no record has cells,
        # and the web reads that from `groups` (queryDefaults in
        # web/src/tables/queryView.ts); sending them means that view needs
        # no second request.
        groups = (None if any(rec.cells for rec in found.records)
                  else _groups(db, rows))
    return QueryRecordsPayload(records=found.records, keys=found.keys,
                               total=len(found.records), groups=groups)


@router.get("/api/titles", response_model=TitlesPayload)
def titles(q: str = "", limit: Int64 = 10,
           db: Db = Depends(get_db)) -> TitlesPayload:
    """Page-title completion for the editor's [[ / # popup."""
    limit = max(1, min(limit, 50))
    needle = q.strip()
    if not needle:
        return TitlesPayload(titles=[])
    esc = like_escape(needle)
    rows = db.select(
        r"""SELECT title FROM pages
             WHERE title LIKE ? ESCAPE '\'
             ORDER BY (CASE WHEN title LIKE ? ESCAPE '\' THEN 0 ELSE 1 END),
                      length(title), title
             LIMIT ?""",
        (f"%{esc}%", f"{esc}%", limit))
    return TitlesPayload(titles=[r["title"] for r in rows])


def _page_filter(title: CanonicalTitle) -> tuple[str, CanonicalTitle]:
    """The one way `todos`/`changed` add an exact `p.title = ?` predicate: a
    typed choke point, so a page filter can't bind a title that skipped
    `read_title`."""
    return " AND p.title = ?", title


@router.get("/api/todos", response_model=GroupsPayload)
def todos(page: str | None = None,
          db: Db = Depends(get_db)) -> GroupsPayload:
    """Blocks whose text starts with a {{TODO}} marker, grouped by page.
    SQL narrows to TODO-containing candidates; the shared
    pkm.todo matcher (the grammar's block-start rule, both bracket
    variants, '> ' quote prefix) decides. Marker-based rather than
    refs-based: the editor emits the bracket-less {{TODO}}, which
    creates no ref row to query."""
    sql = ("SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title"
           "  FROM blocks b JOIN pages p ON p.id = b.page_id"
           " WHERE instr(b.text, 'TODO') > 0")
    params: list[str] = []
    if page is not None:
        clause, bound = _page_filter(read_title(db, page))
        sql += clause
        params.append(bound)
    sql += " ORDER BY p.title, b.uid"
    rows = [r for r in db.select(sql, params) if is_todo(r["text"])]
    return GroupsPayload(groups=group_by_page(rows), total=len(rows))


@router.get("/api/changed", response_model=ChangedPayload)
def changed(since: str, until: str | None = None, page: str | None = None,
           limit: Int64 = 500,
           db: Db = Depends(get_db)) -> ChangedPayload:
    """Blocks touched in [since, until), grouped by page in the order
    each page was first touched. `since`/`until` are each
    either a 'YYYY-MM-DD' date (local midnight) or a full ISO datetime
    (naive = local time, aware = honoured as given); `until` defaults to
    now and is exclusive. A block is 'new' when its created_at falls in
    the window, else 'edited' -- `updated_at` is used as recorded, so a
    move, indent, or rename also counts as an edit, and a block edited
    more than once in the window shows only its latest edit time."""
    now = datetime.now().astimezone()
    try:
        since_ms, until_ms = parse_window(since, until, now, local_tz(now))
    except ChangedWindowError as e:
        raise HTTPException(status_code=400, detail=str(e))
    limit = max(1, min(limit, 2000))
    sql = ("SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title,"
           "       b.created_at, b.updated_at"
           "  FROM blocks b JOIN pages p ON p.id = b.page_id"
           " WHERE b.updated_at >= ? AND b.updated_at < ?")
    params: list[object] = [since_ms, until_ms]
    if page is not None:
        clause, bound = _page_filter(read_title(db, page))
        sql += clause
        params.append(bound)
    counted = db.select_one(f"SELECT COUNT(*) AS n FROM ({sql})", params)
    assert counted is not None  # an aggregate always yields a row
    sql += " ORDER BY b.updated_at, b.uid LIMIT ?"
    rows = [ChangedRow(
        uid=r["uid"], text=r["text"], page_id=r["page_id"],
        page_title=r["page_title"], created_at=r["created_at"],
        updated_at=r["updated_at"],
        status=classify(r["created_at"], since_ms=since_ms,
                        until_ms=until_ms))
            for r in db.select(sql, [*params, limit])]
    return ChangedPayload(
        groups=group_changed(rows), total=counted["n"],
        since=since_ms, until=until_ms)
