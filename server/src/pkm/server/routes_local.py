# pattern: Imperative Shell
"""Serve files from Config.local_docs_root read-only. This is
the one route that reads outside the data dir, so the containment
check in local_docs.py is the only guard: anything it rejects is a 404,
and a resolved path that is not under the resolved root (a symlink out,
say) is a 404 too. Never a 403: the response must not confirm what
exists.

iCloud can evict a file, leaving only a `.Name.ext.icloud` stub. That
case is a 503 with Retry-After, after a best-effort `brctl download` so
the next click usually succeeds. A dataless file (macOS's newer eviction,
no stub) is treated the same way.

A resolved file is probed with `local_open` before `FileResponse` sees
it: `open()` on an iCloud path can block for good, and FileResponse
would do that on anyio's shared pool. A probe that fails or times out
is a 503, never a hang.

When the request is a browser navigation (Sec-Fetch-Mode, else Accept:
text/html), every failure is a short HTML page with the same status and
headers instead of JSON, so a person following the link never sees raw
JSON; fetch()/pdf.js requests keep the JSON bodies."""
from __future__ import annotations

import logging
import os
import sqlite3
import subprocess
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from pkm.contracts.responses import LocalCheckPayload, LocalCheckProblem
from pkm.local_docs import (LOCAL_PREFIX, clean_relative, disposition_for,
                            error_page_html, extract_local_hrefs, is_within,
                            media_type_for, resolve_relative, wants_html_error)
from pkm.server.auth import require_auth
from pkm.server.config import Config
from pkm.server.db import get_config, get_db
from pkm.server.local_open import default_prober

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


_SF_DATALESS = 0x40000000


def _st_flags(path: Path) -> int:
    return getattr(os.stat(path), "st_flags", 0)


def _is_dataless(path: Path) -> bool:
    """True when macOS reports `path` as an evicted placeholder (the
    SF_DATALESS flag); opening it would block while it downloads."""
    try:
        return bool(_st_flags(path) & _SF_DATALESS)
    except OSError:
        return False


def _classify(root: Path, href: str) -> Literal[
        "ok", "missing", "evicted", "invalid", "unreadable", "unchecked"]:
    rel = resolve_relative(href[len(LOCAL_PREFIX):])
    if rel is None:
        return "invalid"
    candidate = root / rel
    resolved = _resolve_contained_file(root, candidate)
    if resolved is not None:
        if _is_dataless(resolved):
            return "evicted"
        outcome = default_prober.probe(resolved)
        if outcome == "busy":
            return "unchecked"
        return "ok" if outcome == "ok" else "unreadable"
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


_NOT_DOWNLOADED = "The file isn't downloaded on the host yet. The host has asked iCloud for it; try again in a few seconds."
_NOT_FOUND_MESSAGE = "That file isn't in the local documents folder on the host."
_OPEN_FAILED = "The host can't open this file; the server log has the reason."
_OPEN_BUSY = "Too many file opens are in flight on the host; try again shortly."


def _failure(html_wanted: bool, status: int, message: str, shown: str,
             body: dict[str, str], retry: bool) -> Response:
    """The JSON body fetch() callers have always got, or the HTML page a
    browser navigation gets; same status and Retry-After either way."""
    headers = {"Retry-After": "5"} if retry else {}
    if html_wanted:
        return HTMLResponse(
            error_page_html(status, message, shown), status_code=status,
            headers={**headers, "Cache-Control": "no-store",
                     "X-Content-Type-Options": "nosniff"})
    return JSONResponse(status_code=status, headers=headers, content=body)


@router.get("/api/local/{path:path}")
def get_local_file(path: str, request: Request,
                   config: Config = Depends(get_config)) -> Response:
    html_wanted = wants_html_error(request.headers.get("sec-fetch-mode"),
                                   request.headers.get("sec-fetch-dest"),
                                   request.headers.get("accept"))

    def not_found() -> Response:
        return _failure(html_wanted, 404, _NOT_FOUND_MESSAGE, path,
                        {"detail": "not found"}, retry=False)

    try:
        root, candidate, rel = _locate(config, path)
    except HTTPException:
        return not_found()
    if _is_evicted(root, candidate):
        _request_download(candidate)
        return _failure(html_wanted, 503, _NOT_DOWNLOADED, rel,
                        {"detail": "not downloaded on the host", "path": rel}, retry=True)
    resolved = _resolve_contained_file(root, candidate)
    if resolved is None:
        return not_found()
    if _is_dataless(resolved):
        _request_download(resolved)
        return _failure(html_wanted, 503, _NOT_DOWNLOADED, rel,
                        {"detail": "not downloaded on the host", "path": rel}, retry=True)
    outcome = default_prober.probe(resolved)
    if outcome != "ok":
        busy = outcome == "busy"
        detail = ("too many file opens are in flight on the host; see the server log"
                  if busy else "the host can't open this file")
        return _failure(html_wanted, 503, _OPEN_BUSY if busy else _OPEN_FAILED, rel,
                        {"detail": detail, "path": rel}, retry=True)
    return FileResponse(
        resolved, media_type=media_type_for(resolved.name),
        filename=resolved.name,
        content_disposition_type=disposition_for(resolved.name),
        headers={"Cache-Control": "private, max-age=0, must-revalidate",
                 "X-Content-Type-Options": "nosniff"})
