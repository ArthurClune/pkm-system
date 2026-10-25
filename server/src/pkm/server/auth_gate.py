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
the server's read size (uvicorn's) bounds the overshoot. The whole read
must finish within `PUBLIC_BODY_READ_TIMEOUT_S` or gets 408, so a client
dripping a login body cannot hold the connection.

An authenticated body is capped the same way at `PRIVATE_BODY_MAX_BYTES`
(`auth_gate_core.private_body_cap` says which), for the same reason:
FastAPI would parse any size before the route's own limits run. Uploads
are exempt and bound themselves while streaming to disk. A declared length
within the cap passes untouched, without the buffered read and replay:
the server (h11) frames the body to that length, so no more can arrive
than was declared. A length sent beside `Transfer-Encoding` is no such
promise (h11 frames by the chunks), so `declared_content_length` ignores
it and that body is counted here like any chunked one. An authenticated
body has no read deadline: an upload over a slow link may take minutes.

A 401 or 413 leaves the connection open. uvicorn then reads and drops the
rest of the refused body, and `http_protocol.DeadlineH11Protocol` closes
the connection if that and the next request head take longer than its
deadline. Closing at once would discard a body still in flight, and a TCP
close with unread data resets the connection, so a client still sending
could lose the answer. A 408 carries `Connection: close`, as RFC 9110
advises: its client has shown it will not finish."""
from __future__ import annotations

import asyncio
from enum import Enum

from fastapi.responses import JSONResponse
from starlette.requests import HTTPConnection
from starlette.routing import get_route_path
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from pkm.server.auth import (NOT_AUTHENTICATED_DETAIL,
                             NOT_AUTHENTICATED_WS_CODE, session_is_valid)
from pkm.server.auth_gate_core import (PUBLIC_BODY_MAX_BYTES,
                                       PUBLIC_BODY_READ_TIMEOUT_S,
                                       declared_content_length, is_public,
                                       private_body_cap)
from pkm.server.origin_core import SAFE_METHODS

BODY_TOO_LARGE_DETAIL = "request body too large"
BODY_TIMED_OUT_DETAIL = "request body timed out"


class _Unread(Enum):
    DISCONNECTED = "disconnected"
    OVER_CAP = "over cap"


class AuthGateMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if is_public(scope["type"], scope.get("method"), get_route_path(scope)):
            if scope["type"] == "http" and scope["method"] not in SAFE_METHODS:
                await self._capped(scope, receive, send,
                                   PUBLIC_BODY_MAX_BYTES,
                                   PUBLIC_BODY_READ_TIMEOUT_S)
            else:
                await self.app(scope, receive, send)
            return
        if session_is_valid(HTTPConnection(scope),
                            scope["app"].state.config):
            await self._private(scope, receive, send)
        elif scope["type"] == "websocket":
            await WebSocketClose(code=NOT_AUTHENTICATED_WS_CODE)(
                scope, receive, send)
        else:
            await _refuse(scope, receive, send, 401,
                          NOT_AUTHENTICATED_DETAIL)

    async def _private(self, scope: Scope, receive: Receive,
                       send: Send) -> None:
        cap = (None if scope["type"] != "http"
               else private_body_cap(scope["method"], get_route_path(scope)))
        if cap is None:
            await self.app(scope, receive, send)
            return
        declared = declared_content_length(scope["headers"])
        if declared is not None and declared <= cap:
            await self.app(scope, receive, send)
            return
        await self._capped(scope, receive, send, cap)

    async def _capped(self, scope: Scope, receive: Receive, send: Send,
                      cap: int, read_timeout: float | None = None) -> None:
        declared = declared_content_length(scope["headers"])
        if declared is not None and declared > cap:
            await _refuse(scope, receive, send, 413, BODY_TOO_LARGE_DETAIL)
            return
        try:
            async with asyncio.timeout(read_timeout):
                body = await _read_body(receive, cap)
        except TimeoutError:
            await _refuse(scope, receive, send, 408, BODY_TIMED_OUT_DETAIL,
                          close=True)
            return
        if body is _Unread.DISCONNECTED:
            return
        if body is _Unread.OVER_CAP:
            await _refuse(scope, receive, send, 413, BODY_TOO_LARGE_DETAIL)
            return
        replayed = False

        async def replay() -> Message:
            # The whole body once; after that the client's own messages,
            # so a later disconnect still reaches the route.
            nonlocal replayed
            if replayed:
                return await receive()
            replayed = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)


async def _read_body(receive: Receive, cap: int) -> bytes | _Unread:
    """The whole body, unless the client leaves or it passes `cap`, in which
    case reading stops at the message that passed it."""
    chunks: list[bytes] = []
    size = 0
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return _Unread.DISCONNECTED
        chunk = message.get("body", b"")
        size += len(chunk)
        if size > cap:
            return _Unread.OVER_CAP
        chunks.append(chunk)
        if not message.get("more_body", False):
            return b"".join(chunks)


async def _refuse(scope: Scope, receive: Receive, send: Send, status: int,
                  detail: str, *, close: bool = False) -> None:
    headers = {"Connection": "close"} if close else None
    await JSONResponse({"detail": detail}, status_code=status,
                       headers=headers)(scope, receive, send)
