# pattern: Imperative Shell
"""ASGI middleware refusing a foreign `Origin` on `/api/ws` and on every
request whose method may change state.

`ts.net` is a public suffix, so every host on a tailnet is same-site with
the app: `SameSite=Lax` sends the session cookie with a sibling host's
WebSocket handshake and with its simple POSTs (a form, a Blob, a beacon).
Only the origin tells such a request from the app's own. A request with
no `Origin` passes, because browsers send one on every request this guard
checks, so only non-browser clients (the CLI, the MCP server, curl) omit
it. Which origins are allowed is decided in origin_core."""
from __future__ import annotations

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from pkm.server.origin_core import checks_origin, origin_allowed

ORIGIN_REFUSED_DETAIL = "origin not allowed"
# Sent before accept, so uvicorn answers the handshake with HTTP 403.
ORIGIN_REFUSED_WS_CODE = 4403


class OriginGuardMiddleware:
    def __init__(self, app: ASGIApp, allowed: frozenset[str]) -> None:
        self.app = app
        self.allowed = allowed

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not checks_origin(scope["type"], scope.get("method")):
            await self.app(scope, receive, send)
            return
        # Every `origin` entry, so a duplicated header is seen and refused.
        origins = [value.decode("latin-1")
                   for name, value in scope["headers"] if name == b"origin"]
        if origin_allowed(origins, self.allowed):
            await self.app(scope, receive, send)
        elif scope["type"] == "websocket":
            await WebSocketClose(code=ORIGIN_REFUSED_WS_CODE)(
                scope, receive, send)
        else:
            await JSONResponse({"detail": ORIGIN_REFUSED_DETAIL},
                               status_code=403)(scope, receive, send)
