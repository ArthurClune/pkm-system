# pattern: Imperative Shell
"""Serve content-addressed assets (upload arrives in plan 3)."""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Protocol

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse

from pkm.filenames import safe_filename
from pkm.server.auth import require_auth
from pkm.server.config import Config
from pkm.server.db import get_config, get_db
from pkm.server.mime_sniff import resolve_stored_mime, sniff_mime

router = APIRouter(dependencies=[Depends(require_auth)])

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


@router.post("/api/assets")
async def upload_asset(file: UploadFile,
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
    db.execute("INSERT OR IGNORE INTO assets VALUES (?,?,?,?,?)",
               (sha, filename, mime, size, int(time.time() * 1000)))
    db.commit()
    row = db.execute(
        "SELECT filename, mime, size FROM assets WHERE sha256 = ?",
        (sha,)).fetchone()
    return {"sha256": sha, "filename": row["filename"], "mime": row["mime"],
            "size": row["size"], "url": f"/assets/{sha}/{row['filename']}"}
