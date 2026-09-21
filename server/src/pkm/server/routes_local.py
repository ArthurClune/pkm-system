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
import sqlite3
import subprocess
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse, JSONResponse

from pkm.contracts.responses import LocalCheckPayload, LocalCheckProblem
from pkm.local_docs import (LOCAL_PREFIX, clean_relative, disposition_for,
                            extract_local_hrefs, is_within, media_type_for,
                            resolve_relative)
from pkm.server.auth import require_auth
from pkm.server.config import Config
from pkm.server.db import get_config, get_db

router = APIRouter(dependencies=[Depends(require_auth)])
logger = logging.getLogger("pkm.local")

_NOT_FOUND = HTTPException(status_code=404, detail="not found")


def _request_download(path: Path) -> None:
    """Ask iCloud to materialise an evicted file. Best effort: a missing
    brctl, a non-zero exit, or a timeout are all logged and ignored."""
    try:
        subprocess.run(["brctl", "download", str(path)], check=False,
                       timeout=2, capture_output=True)
    except (OSError, subprocess.TimeoutExpired) as e:
        logger.info("brctl download skipped for %s: %s", path, e)


def _locate(config: Config, url_path: str) -> tuple[Path, Path, str]:
    """(root, unresolved candidate, rel) or raise 404. Does no stat.
    `url_path` is the `{path:path}` route parameter, which uvicorn has
    already percent-decoded once, so this calls `clean_relative`
    directly rather than `resolve_relative` (which would decode again)."""
    if config.local_docs_root is None:
        raise _NOT_FOUND
    rel = clean_relative(url_path)
    if rel is None:
        raise _NOT_FOUND
    root = config.local_docs_root.resolve()
    return root, root / rel, rel


def _resolve_contained_file(root: Path, candidate: Path) -> Path | None:
    """Resolve `candidate` and return it only if it is within `root` and
    is a regular file; otherwise None. `Path.resolve()` raises
    `RuntimeError` on a symlink loop and `Path.is_file()` can raise
    `OSError` (e.g. ENAMETOOLONG); both are treated as "not found"
    rather than propagating as a 500."""
    try:
        resolved = candidate.resolve()
        if is_within(root, resolved) and resolved.is_file():
            return resolved
    except (OSError, RuntimeError):
        pass
    return None


def _is_evicted(root: Path, candidate: Path) -> bool:
    """True when `candidate` itself is absent but its `.icloud` stub is
    present and contained in `root`. The single source of truth for
    eviction, shared by the file route and /api/local/check so they can
    never disagree about a symlinked-out stub. Any filesystem error
    while checking (e.g. ENAMETOOLONG, or a symlink loop from
    `resolve()`) is treated as "not evicted", the same as "not found"."""
    stub = candidate.parent / f".{candidate.name}.icloud"
    try:
        return not candidate.exists() and stub.is_file() and is_within(root, stub.resolve())
    except (OSError, RuntimeError):
        return False


def _classify(root: Path, href: str) -> Literal["ok", "missing", "evicted", "invalid"]:
    rel = resolve_relative(href[len(LOCAL_PREFIX):])
    if rel is None:
        return "invalid"
    candidate = root / rel
    if _resolve_contained_file(root, candidate) is not None:
        return "ok"
    if _is_evicted(root, candidate):
        return "evicted"
    return "missing"


@router.get("/api/local/check", response_model=LocalCheckPayload)
def check_local_links(db: sqlite3.Connection = Depends(get_db),
                      config: Config = Depends(get_config)) -> LocalCheckPayload:
    if config.local_docs_root is None:
        return LocalCheckPayload(enabled=False, total=0, ok=0, problems=[])
    root = config.local_docs_root.resolve()
    rows = db.execute(
        "SELECT b.uid, p.title, b.text FROM blocks b JOIN pages p ON p.id = b.page_id"
        " WHERE instr(b.text, ?) > 0 ORDER BY p.title, b.uid", (LOCAL_PREFIX,)).fetchall()
    total = ok = 0
    problems: list[LocalCheckProblem] = []
    for uid, title, text in rows:
        for href in extract_local_hrefs(text):
            total += 1
            status = _classify(root, href)
            if status == "ok":
                ok += 1
            else:
                problems.append(LocalCheckProblem(
                    uid=uid, page=title, href=href, status=status))
    return LocalCheckPayload(enabled=True, total=total, ok=ok, problems=problems)


@router.get("/api/local/{path:path}")
def get_local_file(path: str,
                   config: Config = Depends(get_config)) -> Response:
    root, candidate, rel = _locate(config, path)
    if _is_evicted(root, candidate):
        _request_download(candidate)
        return JSONResponse(
            status_code=503, headers={"Retry-After": "5"},
            content={"detail": "not downloaded on the host", "path": rel})
    resolved = _resolve_contained_file(root, candidate)
    if resolved is None:
        raise _NOT_FOUND
    return FileResponse(
        resolved, media_type=media_type_for(resolved.name),
        filename=resolved.name,
        content_disposition_type=disposition_for(resolved.name),
        headers={"Cache-Control": "private, max-age=0, must-revalidate",
                 "X-Content-Type-Options": "nosniff"})
