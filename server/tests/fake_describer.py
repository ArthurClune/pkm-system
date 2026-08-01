"""ImageDescriber test double (same convention as fake_engine.py)."""
import asyncio
import threading

from pkm.describe.service import DescribeError

PNG = b"\x89PNG\r\n\x1a\n" + b"fakepixels"


class FakeDescriber:
    def __init__(self, text: str = "a bar chart of monthly revenue",
                 error: str | None = None):
        self.text = text
        self.error = error
        self.calls: list[str] = []
        self.close_calls = 0
        self.events: list[str] = []

    async def describe(self, image_bytes: bytes, mime: str) -> str:
        self.calls.append(mime)
        if self.error is not None:
            raise DescribeError(self.error)
        return self.text

    async def close(self) -> None:
        self.close_calls += 1
        self.events.append("closed")


class BlockingCloseDescriber(FakeDescriber):
    """Hold provider shutdown until a lifecycle test explicitly releases it."""

    def __init__(self):
        super().__init__()
        self.close_started = asyncio.Event()
        self.close_release = asyncio.Event()
        self.close_completed = asyncio.Event()

    async def close(self) -> None:
        self.close_calls += 1
        self.close_started.set()
        await self.close_release.wait()
        self.close_completed.set()
        self.events.append("closed")


class BlockingDescriber:
    """A describer that genuinely holds the in-flight state until the test
    releases it (pkm-1wv1 dedup tests). `started` is set the instant
    `describe()` is entered; the coroutine then blocks (via a worker
    thread, so it never freezes the caller's event loop) until `release`
    is set. pkm-mbcc: a fake that "is slow" must actually block at the
    awaited point, not just claim to -- a plain call counter can't prove
    two concurrent enqueues collapsed into one in-flight attempt."""

    def __init__(self, text: str = "a bar chart of monthly revenue",
                 error: str | None = None):
        self.text = text
        self.error = error
        self.calls: list[str] = []
        self.close_calls = 0
        self.events: list[str] = []
        self.started = threading.Event()
        self.release = threading.Event()

    async def describe(self, image_bytes: bytes, mime: str) -> str:
        self.calls.append(mime)
        self.started.set()
        try:
            await asyncio.to_thread(self.release.wait, 5)
        finally:
            self.events.append("describe-finished")
        if self.error is not None:
            raise DescribeError(self.error)
        return self.text

    async def close(self) -> None:
        self.close_calls += 1
        self.events.append("closed")
