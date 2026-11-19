# pattern: Imperative Shell
"""The web build the server serves, advertised as `X-Pkm-Build` on every
response so a client running a cached bundle can tell it is stale
(docs/architecture/frontend.md § Build notes).

The SPA route reads `web_dist` from disk per request, so a rebuild without
a restart serves new files at once. The id follows the same files: it is
re-read whenever `build-id.json` changes, or a stale header would put up a
banner that the clean reload cannot clear."""
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


def read_build_id(path: Path) -> str | None:
    """The id in a `build-id.json`, or None when it is missing or not a
    valid id."""
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


class BuildStamp:
    """`web_dist`'s current build id, re-read only when the file changes."""

    def __init__(self, web_dist: Path) -> None:
        self._path = web_dist / BUILD_ID_FILE
        self._key: tuple[int, int] | None = None
        self._build: str | None = None

    def current(self) -> str | None:
        try:
            st = self._path.stat()
        except OSError:
            self._key, self._build = None, None
            return None
        key = (st.st_mtime_ns, st.st_size)
        if key != self._key:
            self._key, self._build = key, read_build_id(self._path)
        return self._build


class BuildHeaderMiddleware:
    def __init__(self, app: ASGIApp, stamp: BuildStamp) -> None:
        self.app = app
        self.stamp = stamp

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_header(message: Message) -> None:
            if message["type"] == "http.response.start":
                build = self.stamp.current()
                if build is not None:
                    MutableHeaders(scope=message)[BUILD_HEADER] = build
            await send(message)

        await self.app(scope, receive, send_with_header)
