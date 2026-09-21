# pattern: Imperative Shell
"""Serve files from Config.local_docs_root read-only (pkm-g1ep). This is
the one route that reads outside the data dir, so the containment
check in local_docs.py is load-bearing: anything it rejects is a 404,
and a resolved path that is not under the resolved root (a symlink out,
say) is a 404 too. Never a 403: the response must not confirm what
exists.

iCloud can evict a file, leaving only a `.Name.ext.icloud` stub. That
case is a 503 with Retry-After, after a best-effort `brctl download` so
the next click usually succeeds."""
from __future__ import annotations

import logging
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse, JSONResponse

from pkm.local_docs import (disposition_for, is_within, media_type_for,
                            resolve_relative)
from pkm.server.auth import require_auth
from pkm.server.config import Config
from pkm.server.db import get_config

router = APIRouter(dependencies=[Depends(require_auth)])
logger = logging.getLogger("pkm.local")

_NOT_FOUND = HTTPException(status_code=404, detail="not found")


def _request_download(path: Path) -> None:
    """Ask iCloud to materialise an evicted file. Best effort: a missing
    brctl, a non-zero exit, or a timeout are all logged and ignored."""
    try:
        subprocess.run(["brctl", "download", str(path)], check=False,
                       timeout=2, capture_output=True)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        logger.info("brctl download skipped for %s: %s", path, e)


def _locate(config: Config, url_path: str) -> tuple[Path, Path, str]:
    """(root, unresolved candidate, rel) or raise 404. Does no stat."""
    if config.local_docs_root is None:
        raise _NOT_FOUND
    rel = resolve_relative(url_path)
    if rel is None:
        raise _NOT_FOUND
    root = config.local_docs_root.resolve()
    return root, root / rel, rel


@router.get("/api/local/{path:path}")
def get_local_file(path: str,
                   config: Config = Depends(get_config)) -> Response:
    root, candidate, rel = _locate(config, path)
    stub = candidate.parent / f".{candidate.name}.icloud"
    if not candidate.exists() and stub.is_file() and is_within(root, stub.resolve()):
        _request_download(candidate)
        return JSONResponse(
            status_code=503, headers={"Retry-After": "5"},
            content={"detail": "not downloaded on the host", "path": rel})
    resolved = candidate.resolve()
    if not is_within(root, resolved) or not resolved.is_file():
        raise _NOT_FOUND
    return FileResponse(
        resolved, media_type=media_type_for(resolved.name),
        filename=resolved.name,
        content_disposition_type=disposition_for(resolved.name),
        headers={"Cache-Control": "private, max-age=0, must-revalidate",
                 "X-Content-Type-Options": "nosniff"})
