# pattern: Imperative Shell
"""Serve content-addressed assets (upload arrives in plan 3)."""
from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import sqlite3
import tempfile
import time
import uuid
import zipfile
from datetime import date
from pathlib import Path
from typing import Literal, Protocol

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse

from pkm.assets_core import (
    export_limit_violation, strip_asset_tokens, type_where, zip_arcnames)
from pkm.describe.core import derive_status
from pkm.filenames import safe_filename
from pkm.server import notify
from pkm.server.auth import require_auth
from pkm.server.config import Config
from pkm.server.db import get_config, get_db
from pkm.server.fts import phrase_query
from pkm.server.mime_sniff import resolve_stored_mime, sniff_mime
from pkm.server.response_models import AssetSearchPayload, AssetUploadResponse
from pkm.server.tempfile_response import CleanupFileResponse

router = APIRouter(dependencies=[Depends(require_auth)])

logger = logging.getLogger("pkm.assets")

_SHA_RE = re.compile(r"^[0-9a-f]{64}$")

# Read/write in bounded chunks rather than slurping the whole upload (up
# to max_upload_bytes) into one bytes object.
_CHUNK_SIZE = 1024 * 1024  # 1 MiB

# Upload allowlist (spec: images, PDF, plain text, office docs). SVG upload
# is allowed; serving forces it to download (see INLINE_MIME in Task 4).
ALLOWED_UPLOAD_MIME = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic",
    "image/svg+xml",
    "application/pdf",
    "text/plain", "text/markdown", "text/csv", "application/json",
    "application/msword", "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
})

# Safe to render in the app's origin: raster images + PDF. SVG is
# deliberately absent — it can script, so it downloads instead.
INLINE_MIME = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic",
    "application/pdf",
})

# Selected-asset export (pkm-13ty): proportionate limits for a personal,
# single-user server -- generous enough that no real selection through
# the /files browser hits them, but bounded so a request can't force the
# server to zip an unbounded number of files or an unbounded number of
# bytes. Over either limit, the request is refused outright (413) before
# the archive is built -- never silently truncated.
MAX_EXPORT_ASSET_COUNT = 500
MAX_EXPORT_TOTAL_BYTES = 1024 ** 3  # 1 GiB


def referencing_blocks(db: sqlite3.Connection,
                       sha256: str) -> list[dict[str, str]]:
    """All blocks whose text contains the asset's sha, with their page
    titles. FTS5 unicode61 keeps a 64-hex sha as one token, so an
    exact-phrase MATCH on the sha finds every block embedding the
    /assets/<sha>/<filename> URL (same trick pkm-gdi5 uses client-side).
    Uncapped: shared with pkm-jdu3's delete-warning/orphan checks, which
    need the complete list."""
    rows = db.execute(
        """SELECT b.uid, p.title AS page_title
             FROM blocks_fts f
             JOIN blocks b ON b.rowid = f.rowid
             JOIN pages p ON p.id = b.page_id
            WHERE blocks_fts MATCH ?
            ORDER BY p.title, b.uid""",
        (phrase_query(sha256),)).fetchall()
    return [{"uid": r["uid"], "page_title": r["page_title"]} for r in rows]


@router.get("/api/assets/search", response_model=AssetSearchPayload)
def search_assets(q: str = "", limit: int = 50, offset: int = 0,
                  type_: Literal["", "image", "pdf", "document", "other"]
                  = Query("", alias="type"),
                  from_ms: int | None = None, to_ms: int | None = None,
                  linked: Literal["all", "linked", "orphan"] = "all",
                  db: sqlite3.Connection = Depends(get_db)) -> dict:
    """LIKE search over description + filename (pkm-zc0c). Empty q lists
    most-recent uploads. LIKE, not FTS: personal-scale table, and no
    offline-parity burden. pkm-jdu3 adds type/date/linked filters,
    offset pagination, and a total count. linked/orphan filtering needs
    refs for every candidate, so that path scans the filtered set
    (personal scale keeps it cheap); linked=all computes refs only for
    the returned page."""
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    where_parts: list[str] = []
    params: list = []
    needle = q.strip()
    if needle:
        esc = (needle.replace("\\", "\\\\")
                     .replace("%", "\\%")
                     .replace("_", "\\_"))
        where_parts.append(r"(description LIKE ? ESCAPE '\'"
                           r" OR filename LIKE ? ESCAPE '\')")
        params += [f"%{esc}%", f"%{esc}%"]
    if type_:
        frag, type_params = type_where(type_)
        where_parts.append(frag)
        params += type_params
    if from_ms is not None:
        where_parts.append("created_at IS NOT NULL AND created_at >= ?")
        params.append(from_ms)
    if to_ms is not None:
        where_parts.append("created_at IS NOT NULL AND created_at <= ?")
        params.append(to_ms)
    where = f"WHERE {' AND '.join(where_parts)} " if where_parts else ""
    select = ("SELECT sha256, filename, mime, size, created_at,"
              " description, describe_error FROM assets ")
    order = "ORDER BY created_at IS NULL, created_at DESC, sha256 "
    if linked == "all":
        total = db.execute(f"SELECT count(*) FROM assets {where}",
                           params).fetchone()[0]
        rows = db.execute(select + where + order + "LIMIT ? OFFSET ?",
                          (*params, limit, offset)).fetchall()
        hits = [(r, referencing_blocks(db, r["sha256"])) for r in rows]
    else:
        rows = db.execute(select + where + order, params).fetchall()
        pairs = [(r, referencing_blocks(db, r["sha256"])) for r in rows]
        want_linked = linked == "linked"
        wanted = [(r, refs) for r, refs in pairs
                  if bool(refs) == want_linked]
        total = len(wanted)
        hits = wanted[offset:offset + limit]
    return {"total": total, "assets": [{
        "sha256": r["sha256"], "filename": r["filename"],
        "mime": r["mime"], "size": r["size"],
        "created_at": r["created_at"],
        "url": f"/assets/{r['sha256']}/{r['filename']}",
        "description": r["description"],
        "status": derive_status(r["description"], r["describe_error"]),
        "describe_error": r["describe_error"],
        "refs": refs,
    } for r, refs in hits]}


@router.delete("/api/assets/{sha256}")
def delete_asset(request: Request, sha256: str,
                 db: sqlite3.Connection = Depends(get_db),
                 config: Config = Depends(get_config)) -> dict:
    """Delete an asset: strip every reference token from block text
    (blocks left empty with no children are deleted outright — asset
    deletion must never cascade away real content, so emptied parents
    are kept), drop the assets row, commit, then best-effort unlink the
    file. Commit-before-unlink: a crash leaves at worst an unreferenced
    file on disk, never a row pointing at a missing file. Asset URLs
    never contribute refs rows ([[link]]/#tag/attr:: only), so no refs
    reindex is needed; refs rows of deleted blocks go via FK cascade
    (the refs table has no FTS trigger — unlike blocks, where explicit
    per-uid DELETE is required to keep the FTS delete trigger firing)."""
    if not _SHA_RE.match(sha256):
        raise HTTPException(status_code=404, detail="asset not found")
    row = db.execute("SELECT sha256 FROM assets WHERE sha256 = ?",
                     (sha256,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="asset not found")
    now_ms = int(time.time() * 1000)
    refs_removed = 0
    for ref in referencing_blocks(db, sha256):
        block = db.execute("SELECT text FROM blocks WHERE uid = ?",
                           (ref["uid"],)).fetchone()
        if block is None:
            continue
        new_text = strip_asset_tokens(block["text"], sha256)
        if new_text == block["text"]:
            continue
        refs_removed += 1
        has_children = db.execute(
            "SELECT 1 FROM blocks WHERE parent_uid = ? LIMIT 1",
            (ref["uid"],)).fetchone() is not None
        if not new_text and not has_children:
            db.execute("DELETE FROM blocks WHERE uid = ?", (ref["uid"],))
        else:
            db.execute("UPDATE blocks SET text = ?, updated_at = ?"
                       " WHERE uid = ?", (new_text, now_ms, ref["uid"]))
    db.execute("DELETE FROM assets WHERE sha256 = ?", (sha256,))
    db.commit()
    path = config.assets_dir / sha256[:2] / sha256
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("could not remove asset file %s", path)
    notify.nudge_threadpool(request, db)
    return {"deleted": True, "refs_removed": refs_removed}


@router.post("/api/assets/export.zip")
def export_assets(sha256s: list[str] = Form(default=[]),
                  db: sqlite3.Connection = Depends(get_db),
                  config: Config = Depends(get_config)) -> FileResponse:
    """Zip the selected assets under their original filenames (name
    collisions get a short sha prefix via zip_arcnames). Form-encoded so
    the web app can drive it with a plain <form method="post"> and let
    the browser own the download. Unknown, malformed, duplicate, and
    missing-on-disk shas are skipped, not errors: the zip honestly
    contains what could be exported.

    pkm-13ty: the selection's count and total bytes (summed from the
    `assets` table -- no file is opened just to measure it) are checked
    against MAX_EXPORT_ASSET_COUNT/MAX_EXPORT_TOTAL_BYTES before any zip
    is built; over either limit the request is refused with 413, never
    silently truncated. The archive itself is built in a temp directory
    and streamed back via FileResponse (not buffered whole in memory),
    with the directory removed once the response finishes, errors, or is
    interrupted (CleanupFileResponse)."""
    chosen: list[tuple[str, str, Path]] = []
    total_bytes = 0
    for sha in dict.fromkeys(sha256s):
        if not _SHA_RE.match(sha):
            continue
        row = db.execute("SELECT filename, size FROM assets WHERE sha256 = ?",
                         (sha,)).fetchone()
        if row is None:
            continue
        path = config.assets_dir / sha[:2] / sha
        if not path.is_file():
            continue
        chosen.append((sha, row["filename"], path))
        total_bytes += row["size"]
    violation = export_limit_violation(
        len(chosen), total_bytes,
        max_count=MAX_EXPORT_ASSET_COUNT, max_bytes=MAX_EXPORT_TOTAL_BYTES)
    if violation is not None:
        raise HTTPException(status_code=413, detail=violation)
    arcs = zip_arcnames([(sha, safe_filename(name)) for sha, name, _ in chosen])
    tmp_dir = Path(tempfile.mkdtemp(prefix="pkm-assets-export-"))
    zip_path = tmp_dir / "export.zip"
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for (_, _, path), (_, arc) in zip(chosen, arcs):
                zf.write(path, arc)
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    filename = f"assets-{date.today().isoformat()}.zip"

    async def _cleanup() -> None:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return CleanupFileResponse(
        zip_path, media_type="application/zip", filename=filename,
        cleanup=_cleanup)


@router.get("/assets/{sha256}/{filename}")
def get_asset(sha256: str, filename: str,
              db: sqlite3.Connection = Depends(get_db),
              config: Config = Depends(get_config)) -> FileResponse:
    if not _SHA_RE.match(sha256):
        raise HTTPException(status_code=404, detail="asset not found")
    row = db.execute("SELECT mime, filename FROM assets WHERE sha256 = ?",
                     (sha256,)).fetchone()
    path = config.assets_dir / sha256[:2] / sha256
    if row is None or not path.is_file():
        raise HTTPException(status_code=404, detail="asset not found")
    kind = "inline" if row["mime"] in INLINE_MIME else "attachment"
    return FileResponse(
        path, media_type=row["mime"], filename=row["filename"],
        content_disposition_type=kind,
        headers={"Cache-Control": "private, max-age=31536000, immutable",
                 "X-Content-Type-Options": "nosniff"})


class _ChunkReadable(Protocol):
    """The subset of UploadFile that `_stream_to_temp` needs; lets tests
    exercise the streaming/cap logic with a lightweight fake instead of a
    real UploadFile."""

    async def read(self, size: int) -> bytes: ...


async def _stream_to_temp(file: _ChunkReadable, tmp_path: Path,
                          max_bytes: int) -> tuple[str, int, bytes]:
    """Stream `file` into `tmp_path` in bounded chunks, hashing as it goes.

    Raises HTTPException(413) as soon as the running total exceeds
    `max_bytes`, without reading or writing the rest of the upload.
    Returns (sha256_hex, size, first_chunk); `first_chunk` lets the
    caller sniff the MIME type without a second read of the content.
    """
    hasher = hashlib.sha256()
    total = 0
    first_chunk = b""
    with open(tmp_path, "wb") as out:
        while True:
            chunk = await file.read(_CHUNK_SIZE)
            if not chunk:
                break
            if not first_chunk:
                first_chunk = chunk
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(status_code=413, detail="upload too large")
            out.write(chunk)
            hasher.update(chunk)
    return hasher.hexdigest(), total, first_chunk


@router.post("/api/assets", response_model=AssetUploadResponse)
async def upload_asset(request: Request, file: UploadFile,
                       db: sqlite3.Connection = Depends(get_db),
                       config: Config = Depends(get_config)) -> dict:
    declared_mime = file.content_type or "application/octet-stream"
    if declared_mime not in ALLOWED_UPLOAD_MIME:
        raise HTTPException(status_code=415,
                            detail=f"unsupported upload type {declared_mime}")
    config.assets_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = config.assets_dir / f".upload-{uuid.uuid4().hex}.tmp"
    moved = False
    try:
        sha, size, first_chunk = await _stream_to_temp(
            file, tmp_path, config.max_upload_bytes)
        if size == 0:
            raise HTTPException(status_code=400, detail="empty upload")
        mime = resolve_stored_mime(declared_mime, sniff_mime(first_chunk))
        dest = config.assets_dir / sha[:2] / sha
        if not dest.is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.replace(tmp_path, dest)
            moved = True
    finally:
        if not moved:
            tmp_path.unlink(missing_ok=True)
    filename = safe_filename(Path(file.filename or "upload").name)
    db.execute("INSERT OR IGNORE INTO assets(sha256, filename, mime, size,"
               " created_at) VALUES (?,?,?,?,?)",
               (sha, filename, mime, size, int(time.time() * 1000)))
    db.commit()
    row = db.execute(
        "SELECT filename, mime, size FROM assets WHERE sha256 = ?",
        (sha,)).fetchone()
    request.app.state.describe.maybe_enqueue(sha, mime, size)
    return {"sha256": sha, "filename": row["filename"], "mime": row["mime"],
            "size": row["size"], "url": f"/assets/{sha}/{row['filename']}"}
