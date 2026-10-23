# pattern: Imperative Shell
"""ASGI middleware adding fixed security headers to every HTTP response.

`X-DNS-Prefetch-Control: off` stops a browser resolving the host of every
`<a href>` on a plain-HTTP page, which would leak a hostname an attacker
put in a reply through DNS."""
from __future__ import annotations

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["X-DNS-Prefetch-Control"] = "off"
            await send(message)

        await self.app(scope, receive, send_with_headers)
