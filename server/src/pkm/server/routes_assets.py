# pattern: Imperative Shell
"""Serve content-addressed assets (upload arrives in plan 3)."""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse

from pkm.server.auth import require_auth
from pkm.server.config import Config
from pkm.server.db import get_config, get_db

router = APIRouter(dependencies=[Depends(require_auth)])

_SHA_RE = re.compile(r"^[0-9a-f]{64}$")

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


@router.get("/assets/{sha256}/{filename}")
def get_asset(sha256: str, filename: str,
              db: sqlite3.Connection = Depends(get_db),
              config: Config = Depends(get_config)) -> FileResponse:
    if not _SHA_RE.match(sha256):
        raise HTTPException(status_code=404, detail="asset not found")
    row = db.execute("SELECT mime FROM assets WHERE sha256 = ?",
                     (sha256,)).fetchone()
    path = config.assets_dir / sha256[:2] / sha256
    if row is None or not path.is_file():
        raise HTTPException(status_code=404, detail="asset not found")
    return FileResponse(
        path, media_type=row["mime"],
        headers={"Cache-Control": "private, max-age=31536000, immutable"})


@router.post("/api/assets")
async def upload_asset(file: UploadFile,
                       db: sqlite3.Connection = Depends(get_db),
                       config: Config = Depends(get_config)) -> dict:
    mime = file.content_type or "application/octet-stream"
    if mime not in ALLOWED_UPLOAD_MIME:
        raise HTTPException(status_code=415,
                            detail=f"unsupported upload type {mime}")
    # read one byte past the cap: a short read proves the whole file fit
    data = await file.read(config.max_upload_bytes + 1)
    if len(data) > config.max_upload_bytes:
        raise HTTPException(status_code=413, detail="upload too large")
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")
    sha = hashlib.sha256(data).hexdigest()
    dest = config.assets_dir / sha[:2] / sha
    if not dest.is_file():
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.parent / f"{sha}.tmp"
        tmp.write_bytes(data)
        os.replace(tmp, dest)
    filename = Path(file.filename or "upload").name or "upload"
    db.execute("INSERT OR IGNORE INTO assets VALUES (?,?,?,?,?)",
               (sha, filename, mime, len(data), int(time.time() * 1000)))
    db.commit()
    row = db.execute(
        "SELECT filename, mime, size FROM assets WHERE sha256 = ?",
        (sha,)).fetchone()
    return {"sha256": sha, "filename": row["filename"], "mime": row["mime"],
            "size": row["size"], "url": f"/assets/{sha}/{row['filename']}"}
