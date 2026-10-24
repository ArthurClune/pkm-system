# pattern: Functional Core
"""Which browser origins may open `/api/ws` or send an unsafe request.

A browser serialises `Origin` canonically (lower-case scheme and host, no
default port, no path), so a header is compared to the allowed set as an
exact string; configured origins are put in that same form on load."""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from urllib.parse import urlsplit

SAFE_METHODS: frozenset[str] = frozenset({"GET", "HEAD", "OPTIONS"})

_DEFAULT_PORTS = {"http": 80, "https": 443}
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def _host_part(host: str) -> str:
    return f"[{host}]" if ":" in host else host


def canonical_origin(value: str) -> str:
    """`value` as a browser would send it in `Origin`, or ValueError when it
    is not a bare http(s) origin."""
    parts = urlsplit(value)
    if parts.scheme not in _DEFAULT_PORTS:
        raise ValueError(f"not an http(s) origin: {value!r}")
    if not parts.hostname:
        raise ValueError(f"origin has no host: {value!r}")
    if parts.username is not None or parts.password is not None:
        raise ValueError(f"origin carries userinfo: {value!r}")
    if parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError(f"origin carries a path, query or fragment: "
                         f"{value!r}")
    port = parts.port  # raises ValueError for a port out of range
    origin = f"{parts.scheme}://{_host_part(parts.hostname)}"
    if port is not None and port != _DEFAULT_PORTS[parts.scheme]:
        origin += f":{port}"
    return origin


def allowed_origins(serve_origins: Iterable[str], bind_hosts: Iterable[str],
                    port: int) -> frozenset[str]:
    """The configured Serve origins, each listener the server binds, and
    loopback under every name a local browser may use for it."""
    direct = {f"http://{_host_part(h)}:{port}"
              for h in (*bind_hosts, *_LOOPBACK_HOSTS)}
    return frozenset({*serve_origins, *direct})


def checks_origin(scope_type: str, method: str | None) -> bool:
    """Every WebSocket handshake, and HTTP methods that may change state."""
    if scope_type == "websocket":
        return True
    return scope_type == "http" and method not in SAFE_METHODS


def origin_allowed(origins: Sequence[str], allowed: frozenset[str]) -> bool:
    """No `Origin` header passes: browsers send one on every request the
    guard checks, so only a non-browser client omits it. More than one is
    refused, since which one a proxy or framework reads is unknowable."""
    if not origins:
        return True
    return len(origins) == 1 and origins[0] in allowed
