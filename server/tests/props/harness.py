"""Non-fixture helpers shared by every property test: a per-process template
database, and a fresh app per Hypothesis example. These are plain functions,
not pytest fixtures, because Hypothesis calls the per-example ones (and
state machines call `template_db_path` directly) far more often than a
fixture's one-per-test lifetime would allow."""
from __future__ import annotations

import atexit
import functools
import os
import shutil
import sqlite3
import tempfile
from collections.abc import Generator, Sequence
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from conftest import TEST_PASSWORD, make_config, seed_db
from fastapi.testclient import TestClient

from pkm.contracts.daily import title_for_date
from pkm.server.app import create_app
from pkm.server.config import Config
from pkm.server.db import open_db
from props.model import MBlock

FROZEN_NOW = datetime(2026, 7, 9, 12, 0, tzinfo=ZoneInfo("Europe/London"))
DAILY_TITLE = title_for_date(FROZEN_NOW.date())

# Per-test example counts under the `merge` profile, sized so
# `proptest/check.sh server` runs in about 3 minutes.
MERGE_EXAMPLES: dict[str, int] = {"smoke": 4, "ops_state": 420, "planner": 1050}


def examples(key: str) -> int:
    """Example count for `key`, by profile: `MERGE_EXAMPLES[key]` under
    `merge`, capped at 20 under every other profile (`dev`'s default and
    the test run's own speed matter more than full coverage there)."""
    n = MERGE_EXAMPLES[key]
    profile = os.environ.get("HYPOTHESIS_PROFILE", "dev")
    return n if profile == "merge" else min(n, 20)


@functools.cache
def template_db_path() -> Path:
    """A seeded database built once per process, in a tempfile dir cleaned
    up at interpreter exit. Hypothesis calls `fresh_app` far more often
    than a session fixture would tolerate re-seeding, so every example
    copies this file instead of rebuilding it."""
    root = Path(tempfile.mkdtemp(prefix="pkm-proptest-template-"))
    db_path = root / "pkm.sqlite3"
    seed_db(db_path)
    con = open_db(db_path)
    try:
        # Flushes the WAL into the main file, so a plain `shutil.copyfile`
        # of `db_path` alone (no `-wal`/`-shm` sidecar) is a complete copy.
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        con.close()
    atexit.register(shutil.rmtree, root, ignore_errors=True)
    return db_path


@dataclass
class FreshApp:
    client: TestClient
    config: Config
    root: Path

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


def fresh_app(template: Path) -> FreshApp:
    """A logged-in app over its own copy of `template`, isolated from every
    other example: nothing an earlier example wrote can leak into this
    one, which is what lets Hypothesis shrink a failure to this example
    alone."""
    root = Path(tempfile.mkdtemp(prefix="pkm-proptest-app-"))
    config = make_config(root)
    shutil.copyfile(template, config.db_path)
    client = TestClient(create_app(config))
    r = client.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    return FreshApp(client=client, config=config, root=root)


def seed_ops(page: str, rows: Sequence[MBlock]) -> list[dict]:
    """One `/api/ops` batch that builds `rows` (a `seed_tree` draw: parents
    before children, gapped keys) as plain creates, led by a `create_page`
    of `page` so the batch is never empty and the page exists even when
    the seed has no block on it."""
    return [{"op": "create_page", "page_title": page},
            *({"op": "create", "uid": b.uid, "page_title": b.page,
               "parent_uid": b.parent, "order_idx": b.order_idx,
               "text": b.text, "heading": b.heading,
               "view_type": b.view_type} for b in rows)]


@contextmanager
def read_db(db_path: Path) -> Generator[sqlite3.Connection]:
    """A read-only connection to an app's database, for invariants: a
    check that could write would hide the very drift it looks for."""
    with closing(sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)) as con:
        yield con


def assert_unique_keys(db_path: Path) -> None:
    """No two siblings (same page, same parent) share an order_idx: the
    write path's shift-then-place keeps keys unique, never contiguous."""
    with read_db(db_path) as con:
        dupes = con.execute(
            "SELECT page_id, parent_uid, order_idx, COUNT(*) FROM blocks"
            " GROUP BY page_id, parent_uid, order_idx"
            " HAVING COUNT(*) > 1").fetchall()
    assert dupes == [], f"duplicate sibling keys: {dupes}"


def assert_well_formed(db_path: Path) -> None:
    """Every parent exists on its child's page, and walking up from any
    block reaches a top-level block: no cycle, no dangling parent."""
    with read_db(db_path) as con:
        rows = {uid: (page_id, parent) for uid, page_id, parent in
                con.execute("SELECT uid, page_id, parent_uid FROM blocks")}
    for uid, (page_id, parent) in rows.items():
        if parent is None:
            continue
        assert parent in rows, f"{uid}: parent {parent} does not exist"
        assert rows[parent][0] == page_id, (
            f"{uid}: parent {parent} is on another page")
    for uid in rows:
        cur: str | None = uid
        for _ in range(len(rows) + 1):
            if cur is None:
                break
            cur = rows[cur][1]
        assert cur is None, f"{uid}: parent chain does not terminate"
