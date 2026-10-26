# pattern: Functional Core
"""Which requests the auth gate lets through without a session.

Decided by path shape, not by matching the route table: a read (`GET`,
`HEAD`) outside `/api` and `/assets` is public (the login page, healthz,
the SPA shell and its static files), as is `POST /api/login`. Everything
else, every WebSocket handshake included, needs a session. The path is
the one the router matches (`starlette.routing.get_route_path`).

A public request may still carry a body (`POST /api/login`), and no
session bounds it, so the gate caps it at `PUBLIC_BODY_MAX_BYTES` and
reads it within `PUBLIC_BODY_READ_TIMEOUT_S`.

An authenticated body is capped too, at `PRIVATE_BODY_MAX_BYTES`, because
FastAPI reads and parses a whole body before the route's own limits run:
a batch of hundreds of MiB would cost GiBs before `MAX_OPS_PER_BATCH`
refused it. An upload (`UPLOAD_ROUTES`) is capped at the configured
`max_upload_bytes` plus `UPLOAD_ENVELOPE_BYTES` instead, since a file may
be larger than any JSON body. FastAPI parses the whole multipart form,
spooling the file to disk and holding other fields in memory, before
`upload_asset` checks the file's size, so without this cap the spool and
those fields would grow without limit."""
from __future__ import annotations

from collections.abc import Iterable
from typing import Final

from pkm.server.origin_core import SAFE_METHODS

PUBLIC_BODY_MAX_BYTES: Final = 8192
# A whole public body (a login) is a few hundred bytes, so ten seconds is
# far beyond any honest client and bounds how long a drip holds a
# connection.
PUBLIC_BODY_READ_TIMEOUT_S: Final = 10.0
# 64 MiB: 500 ops of the largest text a block holds today fit many times
# over, and a batch near it still parses in about a second.
PRIVATE_BODY_MAX_BYTES: Final = 64 * 1024 * 1024
# The multipart framing around an upload's file: boundary lines, part
# headers and the filename, a few hundred bytes from a browser. 64 KiB
# holds the longest filename many times over, so a browser's upload of a
# file within its limit passes the gate, and one just past it gets the
# route's own "upload too large"; past the slack the gate answers.
UPLOAD_ENVELOPE_BYTES: Final = 64 * 1024
UPLOAD_ROUTES: Final[frozenset[tuple[str, str]]] = frozenset(
    {("POST", "/api/assets")})
PRIVATE_FIRST_SEGMENTS: frozenset[str] = frozenset({"api", "assets"})
PUBLIC_UNSAFE_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {("POST", "/api/login")})

_READ_METHODS = frozenset({"GET", "HEAD"})


def is_public(scope_type: str, method: str | None, route_path: str) -> bool:
    if scope_type != "http" or method is None:
        return False
    if (method, route_path) in PUBLIC_UNSAFE_ROUTES:
        return True
    # A path that does not start with "/" matches no route, so nothing is
    # lost by refusing it; admitting it would rest on how the router
    # treats an odd root_path.
    if method not in _READ_METHODS or not route_path.startswith("/"):
        return False
    return route_path.split("/", 2)[1] not in PRIVATE_FIRST_SEGMENTS


def private_body_cap(method: str, route_path: str,
                     max_upload_bytes: int) -> int | None:
    """The most an authenticated request's body may carry, or None when
    the gate leaves its body alone: a safe method carries none worth
    capping. An upload may carry a file of `max_upload_bytes` (the
    config's limit) and its multipart framing."""
    if method in SAFE_METHODS:
        return None
    if (method, route_path) in UPLOAD_ROUTES:
        return max_upload_bytes + UPLOAD_ENVELOPE_BYTES
    return PRIVATE_BODY_MAX_BYTES


def _declared_length(value: bytes) -> int | None:
    digits = value.strip()
    if not digits.isdigit():
        return None
    try:
        return int(digits)
    except ValueError:  # past int()'s limit on digits in a string
        return None


def declared_content_length(
        headers: Iterable[tuple[bytes, bytes]]) -> int | None:
    """The length the body is framed to, or None when nothing declares
    one the server will hold the body to. A `transfer-encoding` header
    makes it None whatever `content-length` says, because h11 frames such
    a body by its chunks and ignores the length. Of two lengths, the
    larger, so the request is judged by the one that could carry more."""
    lengths: list[int] = []
    for name, value in headers:
        lowered = name.lower()
        if lowered == b"transfer-encoding":
            return None
        if lowered == b"content-length":
            length = _declared_length(value)
            if length is not None:
                lengths.append(length)
    return max(lengths, default=None)
