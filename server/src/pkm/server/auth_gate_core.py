# pattern: Functional Core
"""Which requests the auth gate lets through without a session.

Decided by path shape, not by matching the route table: a read (`GET`,
`HEAD`) outside `/api` and `/assets` is public (the login page, healthz,
the SPA shell and its static files), as is `POST /api/login`. Everything
else, every WebSocket handshake included, needs a session. The path is
the one the router matches (`starlette._utils.get_route_path`)."""
from __future__ import annotations

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
