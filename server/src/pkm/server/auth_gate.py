# pattern: Imperative Shell
"""ASGI middleware refusing an anonymous request before its body is read.

FastAPI reads and parses a request body before it runs any dependency, so
`Depends(require_auth)` refuses an anonymous upload only after the server
has taken all of it in. This gate runs before routing: a request outside
the public surface (`auth_gate_core.is_public`) without a valid session
gets 401 `{"detail": "not authenticated"}`, or a WebSocket close 4401
before accept, and `receive` is never called.

`require_auth` stays on every router as the route's own check: it is the
only check on a `GET` outside `/api` and `/assets`, which the gate admits.
The config is read from `app.state` on each request, not captured here,
because the proptest server replaces `app.state.config` after
`create_app`."""
from __future__ import annotations

from fastapi.responses import JSONResponse
from starlette._utils import get_route_path
from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from pkm.server.auth import (NOT_AUTHENTICATED_DETAIL,
                             NOT_AUTHENTICATED_WS_CODE, session_is_valid)
from pkm.server.auth_gate_core import is_public


class AuthGateMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if is_public(scope["type"], scope.get("method"), get_route_path(scope)):
            await self.app(scope, receive, send)
            return
        if session_is_valid(HTTPConnection(scope),
                            scope["app"].state.config):
            await self.app(scope, receive, send)
        elif scope["type"] == "websocket":
            await WebSocketClose(code=NOT_AUTHENTICATED_WS_CODE)(
                scope, receive, send)
        else:
            await JSONResponse({"detail": NOT_AUTHENTICATED_DETAIL},
                               status_code=401)(scope, receive, send)
