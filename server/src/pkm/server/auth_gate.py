# pattern: Imperative Shell
"""ASGI middleware refusing an anonymous request before its body is read,
and capping the bodies FastAPI would otherwise parse whole before any
dependency or route limit runs. `auth_gate_core` decides which requests are
public and how large each body may be; the rules and their reasons are in
docs/architecture/backend.md#auth.

A 401 or 413 leaves the connection open: closing with a body still in
flight resets the connection, and a client still sending could lose the
answer. `http_protocol.DeadlineH11Protocol` closes it if the leftover body
and the next request head take longer than its deadline."""
from __future__ import annotations

import asyncio
from enum import Enum

from fastapi import HTTPException
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


class _BodyOverCap(HTTPException):
    """Raised out of `receive` when a counted body passes its cap. An
    `HTTPException` because FastAPI passes one raised while parsing a body
    on to its own handler, so the 413 matches the gate's; it turns any
    other exception there into a 400."""

    def __init__(self) -> None:
        super().__init__(status_code=413, detail=BODY_TOO_LARGE_DETAIL)


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
               else private_body_cap(
                   scope["method"], get_route_path(scope),
                   scope["app"].state.config.max_upload_bytes))
        if cap is None:
            await self.app(scope, receive, send)
            return
        declared = declared_content_length(scope["headers"])
        if declared is not None and declared > cap:
            await _refuse(scope, receive, send, 413, BODY_TOO_LARGE_DETAIL)
            return
        if declared is not None:
            await self.app(scope, receive, send)
            return
        seen = 0

        async def counted() -> Message:
            nonlocal seen
            message = await receive()
            seen += len(message.get("body", b""))
            if seen > cap:
                raise _BodyOverCap()
            return message

        await self.app(scope, counted, send)

    async def _capped(self, scope: Scope, receive: Receive, send: Send,
                      cap: int, read_timeout: float) -> None:
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
