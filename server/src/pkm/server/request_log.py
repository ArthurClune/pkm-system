# pattern: Imperative Shell
"""ASGI middleware logging one `pkm.access` line per HTTP request.

Replaces uvicorn's access log (which has no durations): the line is
emitted after the response body finishes, so the duration covers the
whole request including body send. Unhandled exceptions log as 500 and
propagate."""
from __future__ import annotations

import logging
import time

from pkm.server.logfmt import request_line

logger = logging.getLogger("pkm.access")


class RequestLogMiddleware:
    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        start = time.perf_counter()
        status = 500  # what the client sees if we never reach response.start
        path = scope["path"]
        if scope.get("query_string"):
            path += "?" + scope["query_string"].decode("latin-1")

        async def send_and_capture_status(message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_and_capture_status)
        finally:
            client = scope.get("client")
            logger.info(request_line(
                client[0] if client else None, scope["method"], path,
                status, (time.perf_counter() - start) * 1000))
