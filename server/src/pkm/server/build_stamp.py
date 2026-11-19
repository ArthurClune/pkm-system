# pattern: Imperative Shell
"""The web build the server serves, advertised as `X-Pkm-Build` on every
response so a client running a cached bundle can tell it is stale
(docs/architecture/frontend.md § Build notes).

The id is read once at startup: deploy rebuilds `web/dist` before it
restarts the service, so a running server's id always names its files."""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = logging.getLogger(__name__)

BUILD_ID_FILE = "build-id.json"
BUILD_HEADER = "X-Pkm-Build"
# Anything else could smuggle CR/LF or bulk into a response header.
_VALID_ID = re.compile(r"[A-Za-z0-9-]{1,64}")


def read_build_id(web_dist: Path) -> str | None:
    """The id in `web_dist/build-id.json`, or None when it is missing or
    not a valid id."""
    path = web_dist / BUILD_ID_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        log.warning("unreadable %s: %s", path, e)
        return None
    build = data.get("build") if isinstance(data, dict) else None
    if not isinstance(build, str) or not _VALID_ID.fullmatch(build):
        log.warning("no valid build id in %s", path)
        return None
    return build


class BuildHeaderMiddleware:
    def __init__(self, app: ASGIApp, build: str) -> None:
        self.app = app
        self.build = build

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_header(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)[BUILD_HEADER] = self.build
            await send(message)

        await self.app(scope, receive, send_with_header)
