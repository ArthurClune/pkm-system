# pattern: Imperative Shell
"""A FileResponse whose cleanup always runs, even when sending is
interrupted (a client disconnect mid-download, or the file going missing
before the first byte is sent).

Stock Starlette `FileResponse.background` is only awaited *after*
`__call__`'s send loop returns without raising -- it is not wrapped in a
`finally`. A route that streams a large temp-file-backed archive and
relies on `background` to remove that temp file would leak it on every
cancelled/interrupted download. `CleanupFileResponse` wraps the same send
in `try/finally` so routes (see `routes_export.py`, `routes_assets.py`)
can hand it a temp-directory teardown that is guaranteed to run."""
from __future__ import annotations

from collections.abc import Awaitable, Callable

from starlette.responses import FileResponse
from starlette.types import Receive, Scope, Send


class CleanupFileResponse(FileResponse):
    """Same as `FileResponse`, but `cleanup` runs unconditionally --
    success, an error raised while sending, or the file being unreadable
    -- instead of only after a fully completed send."""

    def __init__(self, *args: object,
                cleanup: Callable[[], Awaitable[None]],
                **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # pyrefly: ignore
        self._cleanup = cleanup

    async def __call__(self, scope: Scope, receive: Receive,
                       send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self._cleanup()
