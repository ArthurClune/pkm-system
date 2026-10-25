# pattern: Functional Core
"""Which requests the auth gate lets through without a session.

Decided by path shape, not by matching the route table: a read (`GET`,
`HEAD`) outside `/api` and `/assets` is public (the login page, healthz,
the SPA shell and its static files), as is `POST /api/login`. Everything
else, every WebSocket handshake included, needs a session. The path is
the one the router matches (`starlette.routing.get_route_path`).

A public request may still carry a body (`POST /api/login`), and no
session bounds it, so the gate caps it at `PUBLIC_BODY_MAX_BYTES`.

An authenticated body is capped too, at `PRIVATE_BODY_MAX_BYTES`, because
FastAPI reads and parses a whole body before the route's own limits run:
a batch of hundreds of MiB would cost GiBs before `MAX_OPS_PER_BATCH`
refused it. Uploads (`UNCAPPED_PRIVATE_ROUTES`) are exempt: their route
streams the file to disk under its own size limit, and a file may be
larger than any JSON body."""
from __future__ import annotations

from collections.abc import Iterable

from pkm.server.origin_core import SAFE_METHODS

PUBLIC_BODY_MAX_BYTES = 8192
# 64 MiB: 500 ops of the largest text a block holds today fit many times
# over, and a batch near it still parses in about a second.
PRIVATE_BODY_MAX_BYTES = 64 << 20
UNCAPPED_PRIVATE_ROUTES: frozenset[tuple[str, str]] = frozenset(
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


def private_body_cap(method: str, route_path: str) -> int | None:
    """The most an authenticated request's body may carry, or None when
    the gate leaves its body alone: a safe method carries none worth
    capping, and an upload route bounds its own."""
    if method in SAFE_METHODS or (method, route_path) in UNCAPPED_PRIVATE_ROUTES:
        return None
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
