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
import tempfile
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

FROZEN_NOW = datetime(2026, 7, 9, 12, 0, tzinfo=ZoneInfo("Europe/London"))
DAILY_TITLE = title_for_date(FROZEN_NOW.date())

# Provisional per-test example counts under the `merge` profile; Task 5
# calibrates these against what each generator actually needs to reach its
# interesting cases.
MERGE_EXAMPLES: dict[str, int] = {"smoke": 4, "ops_state": 200, "planner": 500}


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
