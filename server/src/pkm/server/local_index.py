# pattern: Imperative Shell
"""List the files under Config.local_docs_root for the link-to-local-file
picker, without trusting the filesystem to answer.

The walk only lists directories (`os.scandir`) and stats entries; it never
opens a file, so an evicted iCloud file is not downloaded by being listed.
It can still block, though: listing a directory in an iCloud container can
hang under launchd. So, like `local_open.OpenProber`, the walk runs on a
daemon thread the caller can abandon after a timeout, and at most one walk
is ever in flight (there is a single root), shared by every caller that
arrives while it runs. The thread is never anyio's pool, so a stuck walk
cannot starve the sync routes."""
from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, TimeoutError as FutureTimeout
from pathlib import Path

from pkm.local_docs import index_order, is_within, visible_name

logger = logging.getLogger("pkm.local")

DEFAULT_TIMEOUT = 5.0


def walk_local_tree(root: Path) -> list[str]:
    """Relative `/`-separated paths of every visible file under `root`
    (already resolved), in `index_order`. A symlink is followed only when
    its target stays inside `root`, and each directory is entered once by
    resolved path, so a symlink loop cannot recurse. An unreadable directory
    at any depth raises `OSError`, so a partial listing is never returned;
    only an entry whose symlink cannot be resolved is skipped."""
    found: list[str] = []
    visited = {root}
    pending: list[tuple[Path, str]] = [(root, "")]
    while pending:
        directory, prefix = pending.pop()
        with os.scandir(directory) as it:
            entries = list(it)
        for entry in entries:
            try:
                is_dir = entry.is_dir()
                is_file = entry.is_file()
                if not (is_dir or is_file):
                    continue
                shown = visible_name(entry.name, is_dir)
                if shown is None:
                    continue
                resolved = Path(entry.path).resolve()
            except (OSError, RuntimeError):
                continue
            if not is_within(root, resolved):
                continue
            rel = prefix + shown
            if is_dir:
                if resolved not in visited:
                    visited.add(resolved)
                    pending.append((Path(entry.path), rel + "/"))
            else:
                found.append(rel)
    return index_order(found)


class TreeScanner:
    def __init__(self, walker: Callable[[Path], list[str]] = walk_local_tree,
                 timeout: float = DEFAULT_TIMEOUT) -> None:
        self._walker = walker
        self._timeout = timeout
        self._lock = threading.Lock()
        self._inflight: tuple[Future[list[str]], float] | None = None

    def scan(self, root: Path) -> list[str] | None:
        """The listing, or None when it is unreadable: a timeout, an
        `OSError`, or a root that is missing or not a directory. A caller
        joining a walk already in flight waits only for what is left of
        the timeout, so a walk that has already overrun answers None at
        once rather than starting a second walker."""
        with self._lock:
            if self._inflight is None:
                fut: Future[list[str]] = Future()
                started = time.monotonic()
                self._inflight = (fut, started)
                try:
                    threading.Thread(target=self._run, args=(root, fut), daemon=True,
                                     name="local-index-scan").start()
                except RuntimeError as e:
                    self._inflight = None
                    logger.warning("local index scan could not start a thread: %s", e)
                    return None
            else:
                fut, started = self._inflight
        wait = max(0.0, self._timeout - (time.monotonic() - started))
        try:
            return fut.result(timeout=wait)
        except FutureTimeout:
            logger.warning("local index scan timed out after %ss", self._timeout)
            return None
        except BaseException as e:
            if not fut.done():
                raise  # an interrupt of this caller, not the walker's outcome
            logger.warning("local index scan failed: %s", e)
            return None

    def _run(self, root: Path, fut: Future[list[str]]) -> None:
        try:
            result = self._walker(root)
        except BaseException as e:  # noqa: BLE001 - surfaced through the future
            self._finish()
            fut.set_exception(e)
        else:
            self._finish()
            fut.set_result(result)

    def _finish(self) -> None:
        with self._lock:
            self._inflight = None


default_scanner = TreeScanner()
