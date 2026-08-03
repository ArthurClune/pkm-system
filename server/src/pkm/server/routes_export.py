# pattern: Imperative Shell
"""Markdown export HTTP routes: plain downloads, not JSON API payloads, so
neither declares a `response_model` (see EXEMPT_READ_ROUTES in
tests/test_openapi_sync.py).

`GET /api/export.zip` reuses the exact Core renderer the nightly backup job
drives (pkm.export.writer.export_graph / pkm.export.markdown.render_page):
raw query command, one-level ((ref)) resolution -- unchanged (pkm-uvqf).

`GET /api/export/page/{title}` is the end-user single-page export
(pkm-kplp): it resolves {{query: ...}} macros to their actual results and
((refs)) recursively to plain text, via the separate Core renderer in
pkm.export.resolve, so the download reads like what a reader of the live
page would see. This route gathers the (bounded, cycle-safe) transitive
closure of referenced-block text and query results the resolver needs,
then hands it to the pure renderer -- it never mutates export_graph's
semantics."""
from __future__ import annotations

import shutil
import sqlite3
import tempfile
import zipfile
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response

from pkm.export.markdown import page_filename
from pkm.export.resolve import (
    BLOCK_REF_MAX_DEPTH, QUERY_MAX_DEPTH, QueryResult, QueryResultGroup,
    QueryResultItem, find_query_macros, render_page_resolved)
from pkm.export.writer import export_graph
from pkm.refs import canonicalize_title
from pkm.server.auth import require_auth
from pkm.server.config import Config
from pkm.server.db import get_config, get_db
from pkm.server.query import (
    QUERY_SOURCE_FILTER, parse_query, plan_sql, QueryParseError)
from pkm.server.store import fetch_page
from pkm.server.sync_meta import plain_space_title_canonicalization_active
from pkm.server.tempfile_response import CleanupFileResponse
from pkm.server.tree import build_tree, collect_block_ref_uids

router = APIRouter(dependencies=[Depends(require_auth)])

# Matches the column set build_tree() reads (see routes_pages._BLOCK_COLS) --
# kept as its own copy rather than a cross-module import since it's a plain
# SQL literal, not shared behaviour.
_BLOCK_COLS = ("uid, parent_uid, order_idx, text, heading, collapsed,"
              " created_at, updated_at, view_type")


def _run_query(db: sqlite3.Connection, expr: str) -> QueryResult | None:
    """Execute one {{query: ...}} expression, shaped for the resolved
    renderer. None on a bad expression (e.g. stale/hand-edited syntax) --
    the caller then leaves the macro's raw text in place, same fallback as
    an unresolved ((ref)). Mirrors routes_search.run_query's SQL, kept as
    its own copy (a routes module importing another routes module's
    handler internals would be the wrong direction of coupling); the
    exclusion filter and query plan themselves are shared via query.py."""
    try:
        sql, params = plan_sql(parse_query(expr))
    except QueryParseError:
        return None
    total = db.execute(
        f"""SELECT count(*) FROM ({sql}) m
              JOIN blocks b ON b.uid = m.uid
             WHERE {QUERY_SOURCE_FILTER}""",
        params).fetchone()[0]
    rows = db.execute(
        f"""SELECT b.uid, b.text, p.title AS page_title
              FROM ({sql}) m JOIN blocks b ON b.uid = m.uid
              JOIN pages p ON p.id = b.page_id
             WHERE {QUERY_SOURCE_FILTER}
             ORDER BY p.title, b.uid""",
        params).fetchall()
    order: list[str] = []
    items_by_page: dict[str, list[QueryResultItem]] = {}
    for r in rows:
        items = items_by_page.setdefault(r["page_title"], [])
        if not items:
            order.append(r["page_title"])
        items.append(QueryResultItem(uid=r["uid"], text=r["text"]))
    groups = tuple(QueryResultGroup(page_title=title,
                                    items=tuple(items_by_page[title]))
                   for title in order)
    return QueryResult(total=total, groups=groups)


def _gather_resolution_data(
    db: sqlite3.Connection, initial_texts: list[str],
) -> tuple[dict[str, str], dict[str, QueryResult]]:
    """Breadth-first, depth-capped closure of every uid and query expression
    the resolved renderer might need: round `depth` fetches/executes the
    macros found in round `depth - 1`'s freshly-discovered text, for as
    many rounds as pkm.export.resolve's own depth caps allow (so no work
    happens the renderer would just discard as capped anyway).

    A `visited` set per kind makes revisiting the same uid or expression a
    no-op rather than a refetch -- the guard against a cyclic ((ref)) chain
    looping forever, not a depth check alone (map lookups are cheap; the
    fetch itself is the thing worth not repeating)."""
    uid_to_text: dict[str, str] = {}
    query_results: dict[str, QueryResult] = {}
    visited_uids: set[str] = set()
    visited_exprs: set[str] = set()
    level_texts = initial_texts
    depth = 0
    while level_texts and depth < BLOCK_REF_MAX_DEPTH:
        next_texts: list[str] = []
        uids = sorted({u for u in collect_block_ref_uids(level_texts)
                      if u not in visited_uids})
        if uids:
            visited_uids.update(uids)
            marks = ",".join("?" * len(uids))
            rows = db.execute(
                f"SELECT uid, text FROM blocks WHERE uid IN ({marks})",
                uids).fetchall()
            for r in rows:
                uid_to_text[r["uid"]] = r["text"]
                next_texts.append(r["text"])
        if depth < QUERY_MAX_DEPTH:
            exprs = {expr for text in level_texts
                    for _, _, expr in find_query_macros(text)} - visited_exprs
            for expr in exprs:
                visited_exprs.add(expr)
                result = _run_query(db, expr)
                if result is not None:
                    query_results[expr] = result
                    for group in result.groups:
                        next_texts.extend(item.text for item in group.items)
        level_texts = next_texts
        depth += 1
    return uid_to_text, query_results


@router.get("/api/export/page/{title:path}")
def export_page_markdown(title: str,
                         db: sqlite3.Connection = Depends(get_db)) -> Response:
    title = canonicalize_title(
        title,
        plain_space=plain_space_title_canonicalization_active(db),
    )
    page = fetch_page(db, title)
    if page is None:
        raise HTTPException(status_code=404, detail="page not found")
    blocks = db.execute(
        f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
        (page["id"],)).fetchall()
    texts = [r["text"] for r in blocks]
    uid_to_text, query_results = _gather_resolution_data(db, texts)
    body = render_page_resolved(page["title"], build_tree(blocks),
                                uid_to_text, query_results)
    filename = page_filename(page["title"], set())
    return Response(
        content=body, media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/api/export.zip")
def export_all_markdown(db: sqlite3.Connection = Depends(get_db),
                        config: Config = Depends(get_config)) -> FileResponse:
    """Whole-graph export, zipped. pkm-13ty: built in a temp directory and
    streamed back via FileResponse rather than buffered whole in an
    in-memory BytesIO -- the graph has no size cap, so an unbounded
    number of pages/assets must not translate into an unbounded process
    allocation. The temp directory is removed once the response finishes,
    errors, or is interrupted (CleanupFileResponse); a failure before
    that point is cleaned up here directly and re-raised."""
    tmp_dir = Path(tempfile.mkdtemp(prefix="pkm-export-"))
    try:
        export_dir = tmp_dir / "export"
        export_graph(db, config.assets_dir, export_dir)
        zip_path = tmp_dir / "export.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(export_dir.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(export_dir))
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    filename = f"pkm-export-{date.today().isoformat()}.zip"

    async def _cleanup() -> None:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return CleanupFileResponse(
        zip_path, media_type="application/zip", filename=filename,
        cleanup=_cleanup)
