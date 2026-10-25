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
`create_app`.

A public request that may carry a body (`POST /api/login` is the only
one) has it read here, session or not, and replayed to the app as one
message. No session bounds such a body, and FastAPI would read any size
before the route runs. The gate keeps at most `PUBLIC_BODY_MAX_BYTES`: a
declared length past it gets 413 unread, and a streamed body gets 413 as
soon as it passes it. Reading stops one server message past the cap, so
the server's read size (uvicorn's) bounds the overshoot."""
from __future__ import annotations

from fastapi.responses import JSONResponse
from starlette.requests import HTTPConnection
from starlette.routing import get_route_path
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from pkm.server.auth import (NOT_AUTHENTICATED_DETAIL,
                             NOT_AUTHENTICATED_WS_CODE, session_is_valid)
from pkm.server.auth_gate_core import (PUBLIC_BODY_MAX_BYTES,
                                       declared_over_cap, is_public)
from pkm.server.origin_core import SAFE_METHODS

BODY_TOO_LARGE_DETAIL = "request body too large"


class AuthGateMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if is_public(scope["type"], scope.get("method"), get_route_path(scope)):
            if scope["type"] == "http" and scope["method"] not in SAFE_METHODS:
                await self._capped(scope, receive, send)
            else:
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

    async def _capped(self, scope: Scope, receive: Receive,
                      send: Send) -> None:
        if declared_over_cap(scope["headers"], PUBLIC_BODY_MAX_BYTES):
            await _too_large(scope, receive, send)
            return
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > PUBLIC_BODY_MAX_BYTES:
                await _too_large(scope, receive, send)
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        replayed = False

        async def replay() -> Message:
            # The whole body once; after that the client's own messages,
            # so a later disconnect still reaches the route.
            nonlocal replayed
            if replayed:
                return await receive()
            replayed = True
            return {"type": "http.request", "body": b"".join(chunks),
                    "more_body": False}

        await self.app(scope, replay, send)


async def _too_large(scope: Scope, receive: Receive, send: Send) -> None:
    await JSONResponse({"detail": BODY_TOO_LARGE_DETAIL},
                       status_code=413)(scope, receive, send)
