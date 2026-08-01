# pattern: Imperative Shell
"""Background queue + worker that fills assets.description (pkm-zc0c).

One sequential worker per process (rate-limit friendly); the queue is
in-memory only — a restart drops it, and POST /api/assets/scan re-enqueues
anything still undescribed. Disabled (describer=None) degrades every entry
point to a no-op so uploads are never affected."""
from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from typing import Protocol

from pkm.describe.core import describe_action
from pkm.server.config import Config
from pkm.server.db import open_db

log = logging.getLogger("pkm.describe")


class DescribeError(Exception):
    """A short, storable reason a describe attempt failed."""


class ImageDescriber(Protocol):
    async def describe(self, image_bytes: bytes, mime: str) -> str:
        """Return a search-oriented description; raise DescribeError."""
        ...

    async def close(self) -> None:
        """Release resources owned by this describer."""
        ...


class DescribeService:
    def __init__(self, config: Config, describer: ImageDescriber | None,
                 reason: str | None):
        self._config = config
        self._describer = describer
        self.reason = reason
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._closed = False
        # SHAs currently queued or mid-attempt; guards at most one ordinary
        # in-flight describe per asset (pkm-1wv1). Cleared in the worker's
        # `finally` so a crash never permanently blocks a sha -- it's a
        # concurrency guard, not a history of past failures, so an
        # explicit force-retry (scan(force=True)) still reaches a sha once
        # its prior attempt has actually finished.
        self._active: set[str] = set()

    @property
    def enabled(self) -> bool:
        return self._describer is not None

    def start(self) -> None:
        """Start the worker; call from the app lifespan (needs a loop)."""
        if self._closed:
            raise RuntimeError("describe service is closed")
        if self.enabled and self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._worker())

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._task is not None:
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError:
                    pass
                self._task = None
        finally:
            if self._describer is not None:
                await self._describer.close()

    def maybe_enqueue(self, sha256: str, mime: str, size: int) -> None:
        """Fire-and-forget enqueue on upload; no-op when disabled, the mime
        can never be described (oversized still enqueues so the failure is
        recorded honestly), or the sha is already queued/in-flight."""
        if (self.enabled and describe_action(mime, size) != "skip"
                and sha256 not in self._active):
            self._active.add(sha256)
            self._queue.put_nowait(sha256)

    def scan(self, db: sqlite3.Connection, force: bool = False) -> int:
        """Enqueue every undescribed eligible asset; force retries failures.
        Skips any sha already queued/in-flight (pkm-1wv1) -- a repeat scan
        before the worker drains must not double up an attempt."""
        if not self.enabled:
            return 0
        sql = "SELECT sha256, mime, size FROM assets WHERE description IS NULL"
        if not force:
            sql += " AND describe_error IS NULL"
        queued = 0
        for row in db.execute(sql).fetchall():
            sha = row["sha256"]
            if (describe_action(row["mime"], row["size"]) != "skip"
                    and sha not in self._active):
                self._active.add(sha)
                self._queue.put_nowait(sha)
                queued += 1
        return queued

    async def drain(self) -> None:
        """Test helper: resolve once every queued item has been processed."""
        await self._queue.join()

    async def _worker(self) -> None:
        while True:
            sha = await self._queue.get()
            try:
                await self._process(sha)
            except Exception:
                # One bad asset must not kill the worker for the rest.
                log.exception("describe failed for %s", sha)
            finally:
                self._active.discard(sha)
                self._queue.task_done()

    async def _process(self, sha: str) -> None:
        assert self._describer is not None
        con = open_db(self._config.db_path)
        try:
            row = con.execute(
                "SELECT mime, size, description FROM assets WHERE sha256 = ?",
                (sha,)).fetchone()
            if row is None or row["description"] is not None:
                return
            action = describe_action(row["mime"], row["size"])
            if action == "skip":
                return
            if action == "too_large":
                self._record(con, sha, error="too large to describe")
                return
            path = self._config.assets_dir / sha[:2] / sha
            try:
                image_bytes = path.read_bytes()
            except OSError:
                self._record(con, sha, error="file missing")
                return
            try:
                text = await self._describer.describe(image_bytes, row["mime"])
            except DescribeError as e:
                self._record(con, sha, error=str(e))
                return
            self._record(con, sha, description=text)
        finally:
            con.close()

    def _record(self, con: sqlite3.Connection, sha: str, *,
                description: str | None = None,
                error: str | None = None) -> None:
        con.execute(
            "UPDATE assets SET description = ?, described_at = ?,"
            " describe_error = ? WHERE sha256 = ?",
            (description,
             int(time.time() * 1000) if description is not None else None,
             error, sha))
        con.commit()
        log.info("described %s: %s", sha[:12],
                 "ok" if description is not None else f"error: {error}")
