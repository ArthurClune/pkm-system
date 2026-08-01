# pattern: Imperative Shell
"""A FileResponse whose cleanup always runs, even if the response never
gets as far as a completed send.

Stock Starlette `FileResponse.background` is only awaited *after*
`__call__` returns without raising -- it is not wrapped in a `finally`.
That gap does NOT cover an ordinary client disconnect under this
project's actual ASGI server: uvicorn's `send()` (h11_impl.py/
httptools_impl.py, checked against the installed 0.49.0) silently
no-ops once the connection is marked disconnected rather than raising,
so `_handle_simple`'s send loop still runs to completion and stock
`background` still fires on a real disconnect. What genuinely reaches
`CleanupFileResponse`'s `finally` instead: `os.stat`-time failures
(`FileResponse.__call__` raises `RuntimeError` for a missing/non-regular
file *before* reaching its own `background` line) and a differently-
behaved ASGI server whose `send()` raises instead of no-oping on a
dropped connection -- worth defending against since it isn't guaranteed
by the ASGI spec, only by this one server's implementation choice.
`CleanupFileResponse` wraps the whole call in `try/finally` so routes
(see `routes_export.py`, `routes_assets.py`) can hand it a
temp-directory teardown that is guaranteed to run regardless of which of
those paths is taken."""
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
