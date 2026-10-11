# pattern: Imperative Shell
"""Probe whether this process can open a file, without trusting open()
to return.

Under launchd on macOS, `open()` on a file in an iCloud container can
block in the kernel indefinitely while the system waits for a privacy
consent. A blocked `open()` cannot be cancelled from Python, so the
defences are: run it on a thread we can abandon, give the caller a
timeout, share one thread among callers asking about the same path, and
cap how many threads can be stuck at once. The threads are daemons (a
`ThreadPoolExecutor` joins its workers at interpreter exit, so one
stuck in `open()` would hold up shutdown) and are never anyio's pool,
so they cannot starve the sync routes."""
from __future__ import annotations

import logging
import os
import threading
from concurrent.futures import Future, TimeoutError as FutureTimeout
from typing import Callable, Literal

logger = logging.getLogger("pkm.local")

ProbeResult = Literal["ok", "unreadable", "busy"]

DEFAULT_TIMEOUT = 3.0
DEFAULT_CAP = 4


def _open_and_close(path: str | os.PathLike[str]) -> None:
    os.close(os.open(path, os.O_RDONLY))


class OpenProber:
    def __init__(self, opener: Callable[[str], None] = _open_and_close,
                 timeout: float = DEFAULT_TIMEOUT, cap: int = DEFAULT_CAP) -> None:
        self._opener = opener
        self._timeout = timeout
        self._cap = cap
        self._lock = threading.Lock()
        self._inflight: dict[str, Future[None]] = {}

    def probe(self, path: str | os.PathLike[str]) -> ProbeResult:
        key = os.fspath(path)
        with self._lock:
            fut = self._inflight.get(key)
            if fut is None:
                if len(self._inflight) >= self._cap:
                    logger.warning("local open probe for %s refused: %d probes already stuck",
                                   key, len(self._inflight))
                    return "busy"
                fut = Future()
                self._inflight[key] = fut
                threading.Thread(target=self._run, args=(key, fut), daemon=True,
                                 name="local-open-probe").start()
        try:
            fut.result(timeout=self._timeout)
        except FutureTimeout:
            logger.warning("local open probe for %s timed out after %ss", key, self._timeout)
            return "unreadable"
        except Exception as e:
            logger.warning("local open probe for %s failed: %s", key, e)
            return "unreadable"
        return "ok"

    def _run(self, key: str, fut: Future[None]) -> None:
        try:
            self._opener(key)
        except BaseException as e:  # noqa: BLE001 - surfaced through the future
            self._finish(key)
            fut.set_exception(e)
        else:
            self._finish(key)
            fut.set_result(None)

    def _finish(self, key: str) -> None:
        with self._lock:
            self._inflight.pop(key, None)


default_prober = OpenProber()
