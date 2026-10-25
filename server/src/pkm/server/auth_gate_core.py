# pattern: Functional Core
"""Which requests the auth gate lets through without a session.

Decided by path shape, not by matching the route table: a read (`GET`,
`HEAD`) outside `/api` and `/assets` is public (the login page, healthz,
the SPA shell and its static files), as is `POST /api/login`. Everything
else, every WebSocket handshake included, needs a session. The path is
the one the router matches (`starlette.routing.get_route_path`).

A public request may still carry a body (`POST /api/login`), and no
session bounds it, so the gate caps it at `PUBLIC_BODY_MAX_BYTES`."""
from __future__ import annotations

from collections.abc import Iterable

PUBLIC_BODY_MAX_BYTES = 8192
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


def _declared_length(value: bytes) -> int | None:
    digits = value.strip()
    if not digits.isdigit():
        return None
    try:
        return int(digits)
    except ValueError:  # past int()'s limit on digits in a string
        return None


def declared_over_cap(headers: Iterable[tuple[bytes, bytes]],
                      cap: int) -> bool:
    """True when any `content-length` header claims more than `cap` bytes.
    An absent or unparsable one is False: the gate's counted read still
    stops at the cap."""
    for name, value in headers:
        if name.lower() == b"content-length":
            length = _declared_length(value)
            if length is not None and length > cap:
                return True
    return False
