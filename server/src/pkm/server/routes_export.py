# pattern: Imperative Shell
"""Markdown export HTTP routes (pkm-uvqf): plain downloads, not JSON API
payloads, so neither declares a `response_model` (see EXEMPT_READ_ROUTES in
tests/test_openapi_sync.py). Both reuse the same Core render/writer that the
nightly backup job drives (pkm.export.markdown / pkm.export.writer)."""
from __future__ import annotations

import io
import sqlite3
import tempfile
import zipfile
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response

from pkm.export.markdown import page_filename, render_page
from pkm.export.writer import export_graph
from pkm.server.auth import require_auth
from pkm.server.config import Config
from pkm.server.db import get_config, get_db
from pkm.server.store import fetch_page
from pkm.server.tree import build_tree, collect_block_ref_uids

router = APIRouter(dependencies=[Depends(require_auth)])

# Matches the column set build_tree() reads (see routes_pages._BLOCK_COLS) --
# kept as its own copy rather than a cross-module import since it's a plain
# SQL literal, not shared behaviour.
_BLOCK_COLS = ("uid, parent_uid, order_idx, text, heading, collapsed,"
              " created_at, updated_at, view_type")


def _uid_to_text(db: sqlite3.Connection, texts: list[str]) -> dict[str, str]:
    """One-level ((ref)) resolution: the uid's own text, unexpanded further --
    matches export_graph()'s single-pass behaviour, not the live API's
    transitive chase (there is no client to keep re-rendering nested refs)."""
    uids = collect_block_ref_uids(texts)
    if not uids:
        return {}
    marks = ",".join("?" * len(uids))
    rows = db.execute(f"SELECT uid, text FROM blocks WHERE uid IN ({marks})",
                      uids).fetchall()
    return {r["uid"]: r["text"] for r in rows}


@router.get("/api/export/page/{title:path}")
def export_page_markdown(title: str,
                         db: sqlite3.Connection = Depends(get_db)) -> Response:
    page = fetch_page(db, title)
    if page is None:
        raise HTTPException(status_code=404, detail="page not found")
    blocks = db.execute(
        f"SELECT {_BLOCK_COLS} FROM blocks WHERE page_id = ?",
        (page["id"],)).fetchall()
    texts = [r["text"] for r in blocks]
    body = render_page(page["title"], build_tree(blocks), _uid_to_text(db, texts))
    filename = page_filename(page["title"], set())
    return Response(
        content=body, media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/api/export.zip")
def export_all_markdown(db: sqlite3.Connection = Depends(get_db),
                        config: Config = Depends(get_config)) -> Response:
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp) / "export"
        export_graph(db, config.assets_dir, export_dir)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(export_dir.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(export_dir))
        content = buf.getvalue()
    filename = f"pkm-export-{date.today().isoformat()}.zip"
    return Response(
        content=content, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'})
