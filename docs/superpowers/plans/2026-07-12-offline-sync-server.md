# Offline Sync — Server Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the server half of the offline-editing protocol (spec: `docs/superpowers/specs/2026-07-12-offline-editing-design.md`, build-order steps 1–2): trigger-maintained change journal, windowed changes feed + snapshot endpoints, WS seq nudges, idempotent op batches, text-hash conflict handling, and a `create_page` op.

**Architecture:** All schema additions are `CREATE TABLE/TRIGGER IF NOT EXISTS` appended to `schema.py` (no column changes to existing tables). Journal rows come from row-level triggers, never per-route code. Feed reads happen in one explicit SQLite read transaction. Conflict planning stays in the Functional Core (`ops_core.py`); context assembly and uid generation stay in the Imperative Shell (`ops_apply.py`).

**Tech Stack:** FastAPI + Pydantic + sqlite3 (server), pytest, openapi-typescript (generated TS types).

## Global Constraints

- Every new runtime file declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top (CLAUDE.md FCIS rule).
- Schema changes: idempotent statements appended to `server/src/pkm/schema.py` only — SQLite has no `ADD COLUMN IF NOT EXISTS`; this plan adds **no columns to existing tables**.
- Ops without `batch_id` / `base_text_hash` must behave byte-for-byte as today (current web client keeps working unchanged).
- Guardrail (spec): WS nudges are emitted **strictly after a successful commit**; a failed send drops that connection (the existing `Hub.broadcast` discard behaviour) so the client reconnects and catch-up-pulls.
- Verification commands (run from repo root): `cd server && uv run pytest -q`, `cd server && uv run pyrefly check`, `cd server && uv run ruff check`, `cd web && pnpm test -- --run`, `cd web && pnpm typecheck`.
- Any task that adds/changes routes or request models trips `server/tests/test_openapi_sync.py`. When it fails, regenerate in that task (`cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types`) and include both generated files in the task's commit; Task 8 is the final consolidation pass.
- Commit after every task; include the bean file (`.beans/`) when its checklist moves. Push after committing. Check `git status -sb` before every commit (parallel sessions may switch the shared checkout's branch — if not on the expected branch, stop and re-establish).

## File Structure

- `server/src/pkm/schema.py` — split `DDL` into `BASE_DDL` (existing content, shared with future client) + `SERVER_DDL` (journal, triggers, `applied_batches`); `DDL = BASE_DDL + SERVER_DDL`.
- `server/src/pkm/server/db.py` — `PRAGMA recursive_triggers=ON` (cascade deletes must fire journal triggers).
- `server/src/pkm/server/sync_core.py` (new, Functional Core) — window dedupe.
- `server/src/pkm/server/routes_sync.py` (new, Imperative Shell) — `/api/sync/changes`, `/api/sync/snapshot`.
- `server/src/pkm/server/response_models.py` — sync payload models.
- `server/src/pkm/server/notify.py` (new, Imperative Shell) — post-commit seq nudge helper for threadpool (sync-`def`) routes.
- `server/src/pkm/server/routes_ops.py` — batch dedup, nudge.
- `server/src/pkm/server/routes_pages.py`, `routes_sidebar.py`, `routes_assets.py` — nudge after existing commits.
- `server/src/pkm/server/ops_core.py` — `CreatePageOp`, `base_text_hash`, `batch_id`, conflict planning.
- `server/src/pkm/server/ops_apply.py` — context assembly for conflicts.
- `web/src/sync/socket.ts` — ignore non-batch WS frames (nudges must not crash the current client).
- Tests: `server/tests/test_sync_journal.py`, `test_sync_core.py`, `test_sync_endpoints.py`, `test_ops_idempotency.py` (new); `test_ws.py`, `test_ops_core.py`, `test_ops_endpoint.py` (extended).

---

### Task 1: Changes journal — schema split, triggers, recursive-trigger pragma

**Files:**
- Modify: `server/src/pkm/schema.py`
- Modify: `server/src/pkm/server/db.py:41` (init) and `:48-53` (open_db)
- Test: `server/tests/test_sync_journal.py` (new)

**Interfaces:**
- Produces: `changes` table (`seq, kind, entity_id, deleted`) populated by triggers on `blocks`/`pages`/`sidebar_entries`; `pkm.schema.BASE_DDL` and `pkm.schema.SERVER_DDL` strings (`DDL` unchanged as their concatenation). Later tasks read `changes` and rely on `BASE_DDL` existing as a separate constant.

- [ ] **Step 1: Write failing tests for journal coverage**

Create `server/tests/test_sync_journal.py`:

```python
"""Journal triggers: every row change lands in `changes`, including rows
changed as side effects of an op (sibling shifts, subtree moves, cascade
deletes, implicit page creation)."""
import pytest

from pkm.server.db import init_db, open_db


@pytest.fixture()
def db(tmp_path):
    path = tmp_path / "t.sqlite3"
    init_db(path)
    con = open_db(path)
    yield con
    con.close()


def _changed(db, kind):
    return {r["entity_id"] for r in db.execute(
        "SELECT entity_id FROM changes WHERE kind = ?", (kind,))}


def _seed_page_with_blocks(db):
    db.execute("INSERT INTO pages(id, title) VALUES (1, 'P')")
    db.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
        " VALUES (?,1,?,?,?)",
        [("uid_aa1", None, 0, "first"),
         ("uid_aa2", None, 1, "second"),
         ("uid_aa3", "uid_aa2", 0, "child of second")])
    db.commit()


def test_insert_update_delete_journal_block_rows(db):
    _seed_page_with_blocks(db)
    assert {"uid_aa1", "uid_aa2", "uid_aa3"} <= _changed(db, "block")
    db.execute("UPDATE blocks SET collapsed = 1 WHERE uid = 'uid_aa1'")
    db.commit()
    assert db.execute(
        "SELECT COUNT(*) FROM changes WHERE kind='block'"
        " AND entity_id='uid_aa1'").fetchone()[0] == 2


def test_sibling_shift_journals_every_shifted_row(db):
    _seed_page_with_blocks(db)
    before = db.execute("SELECT MAX(seq) FROM changes").fetchone()[0]
    # what ShiftSiblings does: bump order_idx of top-level blocks
    db.execute("UPDATE blocks SET order_idx = order_idx + 1"
               " WHERE page_id = 1 AND parent_uid IS NULL")
    db.commit()
    shifted = {r["entity_id"] for r in db.execute(
        "SELECT entity_id FROM changes WHERE kind='block' AND seq > ?",
        (before,))}
    assert shifted == {"uid_aa1", "uid_aa2"}


def test_cascade_delete_journals_descendant_tombstones(db):
    _seed_page_with_blocks(db)
    db.execute("DELETE FROM pages WHERE id = 1")
    db.commit()
    tombs = {r["entity_id"] for r in db.execute(
        "SELECT entity_id FROM changes WHERE kind='block' AND deleted=1")}
    # ON DELETE CASCADE removed all three blocks: all must be journaled
    assert tombs == {"uid_aa1", "uid_aa2", "uid_aa3"}
    assert "1" in {r["entity_id"] for r in db.execute(
        "SELECT entity_id FROM changes WHERE kind='page' AND deleted=1")}


def test_page_and_sidebar_writes_journal(db):
    db.execute("INSERT INTO pages(id, title) VALUES (7, 'Implicit')")
    db.execute("INSERT INTO sidebar_entries(id, title, order_idx)"
               " VALUES (3, 'Implicit', 0)")
    db.commit()
    assert "7" in _changed(db, "page")
    assert "3" in _changed(db, "sidebar")
    db.execute("DELETE FROM sidebar_entries WHERE id = 3")
    db.commit()
    assert db.execute(
        "SELECT deleted FROM changes WHERE kind='sidebar' AND entity_id='3'"
        " ORDER BY seq DESC LIMIT 1").fetchone()[0] == 1


def test_base_ddl_contains_no_server_tables():
    from pkm.schema import BASE_DDL
    assert "changes" not in BASE_DDL
    assert "applied_batches" not in BASE_DDL
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_sync_journal.py -q`
Expected: FAIL — `no such table: changes` / `ImportError: cannot import name 'BASE_DDL'`.

- [ ] **Step 3: Split the DDL and add journal + triggers**

In `server/src/pkm/schema.py`: rename the existing `DDL = """..."""` literal to `BASE_DDL` (content unchanged), keep the `SIDEBAR_ENTRIES_DDL` append targeting `BASE_DDL`, then add:

```python
# Server-only DDL: the change journal (offline sync, pkm-y8p0) and batch
# idempotency records. Deliberately NOT part of BASE_DDL: the client
# replica is built from BASE_DDL alone -- installing these triggers there
# would grow an unused local journal on every upsert (spec section 3).
#
# Journal rows come from row-level triggers, not per-route code: a single
# op touches many rows beyond its target (sibling shifts, subtree moves,
# cascade deletes, implicit page creation), and triggers capture every
# affected row on every write path, current and future. Cascade deletes
# fire these triggers only when PRAGMA recursive_triggers=ON (db.py).
SERVER_DDL = """
CREATE TABLE IF NOT EXISTS changes(
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK(kind IN ('block','page','sidebar')),
  entity_id  TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS blocks_chg_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO changes(kind, entity_id, deleted) VALUES ('block', new.uid, 0);
END;
CREATE TRIGGER IF NOT EXISTS blocks_chg_au AFTER UPDATE ON blocks BEGIN
  INSERT INTO changes(kind, entity_id, deleted) VALUES ('block', new.uid, 0);
END;
CREATE TRIGGER IF NOT EXISTS blocks_chg_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO changes(kind, entity_id, deleted) VALUES ('block', old.uid, 1);
END;

CREATE TRIGGER IF NOT EXISTS pages_chg_ai AFTER INSERT ON pages BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('page', CAST(new.id AS TEXT), 0);
END;
CREATE TRIGGER IF NOT EXISTS pages_chg_au AFTER UPDATE ON pages BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('page', CAST(new.id AS TEXT), 0);
END;
CREATE TRIGGER IF NOT EXISTS pages_chg_ad AFTER DELETE ON pages BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('page', CAST(old.id AS TEXT), 1);
END;

CREATE TRIGGER IF NOT EXISTS sidebar_chg_ai AFTER INSERT ON sidebar_entries BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('sidebar', CAST(new.id AS TEXT), 0);
END;
CREATE TRIGGER IF NOT EXISTS sidebar_chg_au AFTER UPDATE ON sidebar_entries BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('sidebar', CAST(new.id AS TEXT), 0);
END;
CREATE TRIGGER IF NOT EXISTS sidebar_chg_ad AFTER DELETE ON sidebar_entries BEGIN
  INSERT INTO changes(kind, entity_id, deleted)
  VALUES ('sidebar', CAST(old.id AS TEXT), 1);
END;

CREATE TABLE IF NOT EXISTS applied_batches(
  batch_id     TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response     TEXT NOT NULL,
  applied_at   INTEGER NOT NULL
);
"""

DDL = BASE_DDL + SERVER_DDL
```

Update the module docstring to mention the split. `blocks_chg_au` fires on **any** column update (no `OF text` clause) — order_idx shifts and collapse changes must journal.

In `server/src/pkm/server/db.py`, add `PRAGMA recursive_triggers=ON` to **both** connections (without it, `ON DELETE CASCADE` does not fire the delete triggers and cascade-deleted blocks silently vanish from the feed):

```python
# init_db(), before executescript:
        con.execute("PRAGMA recursive_triggers=ON")
# open_db(), next to the foreign_keys pragma:
    con.execute("PRAGMA recursive_triggers=ON")
```

- [ ] **Step 4: Run the new tests, then the full server suite**

Run: `cd server && uv run pytest tests/test_sync_journal.py -q` — expected: PASS.
Run: `cd server && uv run pytest -q` — expected: PASS (existing tests must not care about the extra table/triggers; if `test_schema.py` asserts an exact table list, extend it).

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/schema.py server/src/pkm/server/db.py server/tests/test_sync_journal.py
git commit -m "feat(server): change journal via row-level triggers (pkm-y8p0)"
```

---

### Task 2: Window dedupe (pure core)

**Files:**
- Create: `server/src/pkm/server/sync_core.py`
- Test: `server/tests/test_sync_core.py` (new)

**Interfaces:**
- Produces: `dedupe_window(rows: Sequence[tuple[int, str, str]]) -> Window` where `Window` is a frozen dataclass with `next_since: int` and `entities: tuple[tuple[str, str], ...]` (unique `(kind, entity_id)` pairs). `rows` are `(seq, kind, entity_id)` in ascending seq order. Task 3 consumes both.

- [ ] **Step 1: Write failing tests**

Create `server/tests/test_sync_core.py`:

```python
from pkm.server.sync_core import dedupe_window


def test_next_since_is_last_scanned_row_not_last_distinct_entity():
    # The A@1/B@2/A@100 case from the spec: with the window cut at seq 2,
    # next_since must be 2 (B's row), never 100 -- or B is skipped forever.
    win = dedupe_window([(1, "block", "A"), (2, "block", "B")])
    assert win.next_since == 2
    assert set(win.entities) == {("block", "A"), ("block", "B")}


def test_dedupes_within_window_only():
    win = dedupe_window(
        [(1, "block", "A"), (2, "block", "B"), (3, "block", "A")])
    assert win.next_since == 3
    assert win.entities == (("block", "A"), ("block", "B"))


def test_same_id_different_kind_not_merged():
    win = dedupe_window([(1, "page", "7"), (2, "sidebar", "7")])
    assert set(win.entities) == {("page", "7"), ("sidebar", "7")}


def test_empty_window():
    win = dedupe_window([])
    assert win.next_since == 0
    assert win.entities == ()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_sync_core.py -q`
Expected: FAIL — `ModuleNotFoundError: pkm.server.sync_core`.

- [ ] **Step 3: Implement**

Create `server/src/pkm/server/sync_core.py`:

```python
# pattern: Functional Core
"""Windowing for the sync changes feed. The cursor advances over RAW
journal rows -- next_since is the last row scanned, not the last distinct
entity -- so a client can never skip an entity whose older journal row
fell inside a window that also contained a newer row for something else
(spec section 1, the A@1/B@2/A@100 case)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class Window:
    next_since: int
    entities: tuple[tuple[str, str], ...]  # unique (kind, entity_id)


def dedupe_window(rows: Sequence[tuple[int, str, str]]) -> Window:
    seen: dict[tuple[str, str], None] = {}  # insertion-ordered set
    last_seq = 0
    for seq, kind, entity_id in rows:
        last_seq = seq
        seen.setdefault((kind, entity_id), None)
    return Window(next_since=last_seq, entities=tuple(seen))
```

- [ ] **Step 4: Run tests**

Run: `cd server && uv run pytest tests/test_sync_core.py -q` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/sync_core.py server/tests/test_sync_core.py
git commit -m "feat(server): pure window dedupe for the changes feed (pkm-y8p0)"
```

---

### Task 3: `/api/sync/changes` + `/api/sync/snapshot`

**Files:**
- Create: `server/src/pkm/server/routes_sync.py`
- Modify: `server/src/pkm/server/response_models.py` (append models)
- Modify: `server/src/pkm/server/app.py` (register router)
- Test: `server/tests/test_sync_endpoints.py` (new)

**Interfaces:**
- Consumes: `changes` table (Task 1), `dedupe_window` (Task 2).
- Produces: `GET /api/sync/changes?since=&limit=` → `ChangesPayload{reset, next_since, latest_seq, pages: [SyncPage], blocks: [SyncBlock], sidebar: [SyncSidebarEntry], tombstones: [SyncTombstone]}`; `GET /api/sync/snapshot` → `SnapshotPayload{seq, pages, blocks, sidebar}`. `SyncBlock` carries `refs: [SyncRef{target_page_id, kind}]`. Clients apply pages → blocks → refs → tombstones.

- [ ] **Step 1: Write failing endpoint tests**

Create `server/tests/test_sync_endpoints.py` (the `client` fixture is the authed TestClient from `conftest.py`; seed data from `conftest.py` — pages 1–5, blocks `uid_b1..uid_b6` — is journaled by the Task 1 triggers because the seeds INSERT through the schema):

```python
"""Changes feed + snapshot. Hydration must be dependency-complete: a
window shipping a block+refs also ships the referenced pages, and reads
happen inside one transaction."""


def _drain(client, since=0, limit=1000):
    r = client.get(f"/api/sync/changes?since={since}&limit={limit}")
    assert r.status_code == 200
    return r.json()


def test_bootstrap_snapshot_has_everything_and_a_seq(client):
    r = client.get("/api/sync/snapshot")
    assert r.status_code == 200
    snap = r.json()
    assert snap["seq"] > 0
    assert {p["title"] for p in snap["pages"]} >= {"Machine Learning", "AI"}
    blocks = {b["uid"]: b for b in snap["blocks"]}
    assert blocks["uid_b3"]["text"].startswith("[[Attention")
    assert {r_["target_page_id"] for r_ in blocks["uid_b3"]["refs"]} == {4, 5}


def test_feed_returns_full_block_payload_and_advances_cursor(client):
    start = _drain(client)["latest_seq"]
    r = client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "update_text", "uid": "uid_b1", "text": "now says [[AI]]"}]})
    assert r.status_code == 200
    feed = _drain(client, since=start)
    assert feed["reset"] is False
    uids = {b["uid"] for b in feed["blocks"]}
    assert "uid_b1" in uids
    blk = next(b for b in feed["blocks"] if b["uid"] == "uid_b1")
    assert blk["text"] == "now says [[AI]]"
    assert feed["next_since"] == feed["latest_seq"]  # window covered all rows
    # feed is empty when drained from next_since
    again = _drain(client, since=feed["next_since"])
    assert again["blocks"] == [] and again["tombstones"] == []


def test_window_split_ships_dependency_page_for_refs(client):
    """A block whose text creates an implicit page: even a limit=1 window
    containing only the block's journal row must ship the referenced page
    payload so the client's refs FK target exists."""
    start = _drain(client)["latest_seq"]
    r = client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "update_text", "uid": "uid_b6",
         "text": "links [[Brand New Page]]"}]})
    assert r.status_code == 200
    # walk the new rows one journal row at a time
    seen_pages, seen_block = set(), False
    since = start
    while True:
        feed = _drain(client, since=since, limit=1)
        if not feed["blocks"] and not feed["pages"] and not feed["tombstones"]:
            break
        for b in feed["blocks"]:
            if b["uid"] == "uid_b6":
                seen_block = True
                # every window carrying this block must carry its dep page
                assert "Brand New Page" in {p["title"] for p in feed["pages"]}
        seen_pages |= {p["title"] for p in feed["pages"]}
        since = feed["next_since"]
    assert seen_block and "Brand New Page" in seen_pages


def test_delete_yields_tombstones_for_whole_subtree(client):
    start = _drain(client)["latest_seq"]
    r = client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "delete", "uid": "uid_b2"}]})
    assert r.status_code == 200
    feed = _drain(client, since=start)
    tombs = {(t["kind"], t["entity_id"]) for t in feed["tombstones"]}
    assert ("block", "uid_b2") in tombs and ("block", "uid_b3") in tombs


def test_cursor_ahead_of_journal_requests_reset(client):
    feed = _drain(client, since=10_000_000)
    assert feed["reset"] is True


def test_sync_requires_auth(anon_client):
    assert anon_client.get("/api/sync/changes").status_code in (401, 403)
    assert anon_client.get("/api/sync/snapshot").status_code in (401, 403)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_sync_endpoints.py -q`
Expected: FAIL — 404s (routes don't exist).

- [ ] **Step 3: Add response models**

Append to `server/src/pkm/server/response_models.py`:

```python
class SyncRef(BaseModel):
    target_page_id: int
    kind: str


class SyncBlock(BaseModel):
    uid: str
    page_id: int
    parent_uid: str | None
    order_idx: int
    text: str
    heading: int | None
    collapsed: int
    created_at: int | None
    updated_at: int | None
    refs: list[SyncRef]


class SyncPage(BaseModel):
    id: int
    title: str
    created_at: int | None
    updated_at: int | None


class SyncSidebarEntry(BaseModel):
    id: int
    title: str
    order_idx: int


class SyncTombstone(BaseModel):
    kind: str
    entity_id: str


class ChangesPayload(BaseModel):
    reset: bool = False
    next_since: int
    latest_seq: int
    pages: list[SyncPage]
    blocks: list[SyncBlock]
    sidebar: list[SyncSidebarEntry]
    tombstones: list[SyncTombstone]


class SnapshotPayload(BaseModel):
    seq: int
    pages: list[SyncPage]
    blocks: list[SyncBlock]
    sidebar: list[SyncSidebarEntry]
```

(Match the import style / `BaseModel` usage already in the file.)

- [ ] **Step 4: Implement the routes**

Create `server/src/pkm/server/routes_sync.py`:

```python
# pattern: Imperative Shell
"""Sync-down protocol: windowed changes feed + bootstrap snapshot.

Both endpoints do ALL reads inside one explicit read transaction
(python's sqlite3 runs bare SELECTs in autocommit, where each statement
sees its own snapshot): without BEGIN, a write landing between the
journal scan and the hydration queries could advance the data past the
cursor we return -- reflected in the cursor but missing from the payload.
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from pkm.server.auth import require_auth
from pkm.server.db import get_db
from pkm.server.response_models import (ChangesPayload, SnapshotPayload,
                                        SyncBlock, SyncPage, SyncRef,
                                        SyncSidebarEntry, SyncTombstone)
from pkm.server.sync_core import dedupe_window

router = APIRouter(dependencies=[Depends(require_auth)])

MAX_LIMIT = 5000


def _block_payloads(db: sqlite3.Connection,
                    uids: list[str]) -> tuple[list[SyncBlock], set[int]]:
    """Hydrate blocks + their refs; also return every page id referenced
    by those refs (dependency pages -- spec section 1: a window boundary
    can split a block+refs from the implicitly-created page it points at,
    so referenced pages ship with the block)."""
    blocks: list[SyncBlock] = []
    dep_pages: set[int] = set()
    for uid in uids:
        row = db.execute(
            "SELECT uid, page_id, parent_uid, order_idx, text, heading,"
            " collapsed, created_at, updated_at FROM blocks WHERE uid = ?",
            (uid,)).fetchone()
        if row is None:
            continue  # deleted again since -- the tombstone row covers it
        refs = [SyncRef(target_page_id=r["target_page_id"], kind=r["kind"])
                for r in db.execute(
                    "SELECT target_page_id, kind FROM refs"
                    " WHERE src_block_uid = ?", (uid,))]
        dep_pages.update(r.target_page_id for r in refs)
        blocks.append(SyncBlock(**dict(row) | {"refs": refs}))
    return blocks, dep_pages


def _page_payloads(db: sqlite3.Connection, ids: set[int]) -> list[SyncPage]:
    return [SyncPage(**dict(row)) for pid in sorted(ids)
            if (row := db.execute(
                "SELECT id, title, created_at, updated_at FROM pages"
                " WHERE id = ?", (pid,)).fetchone()) is not None]


@router.get("/api/sync/changes", response_model=ChangesPayload)
def sync_changes(since: int = 0, limit: int = 1000,
                 db: sqlite3.Connection = Depends(get_db)) -> ChangesPayload:
    limit = max(1, min(limit, MAX_LIMIT))
    db.execute("BEGIN")  # one consistent read snapshot for scan + hydration
    try:
        latest = db.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
        if since > latest:
            # cursor from a different/rebuilt database (importer swap):
            # the client must re-bootstrap from the snapshot
            return ChangesPayload(reset=True, next_since=0, latest_seq=latest,
                                  pages=[], blocks=[], sidebar=[],
                                  tombstones=[])
        rows = db.execute(
            "SELECT seq, kind, entity_id FROM changes WHERE seq > ?"
            " ORDER BY seq LIMIT ?", (since, limit)).fetchall()
        win = dedupe_window([(r["seq"], r["kind"], r["entity_id"])
                             for r in rows])
        block_uids = [e for k, e in win.entities if k == "block"]
        page_ids = {int(e) for k, e in win.entities if k == "page"}
        sidebar_ids = [int(e) for k, e in win.entities if k == "sidebar"]

        blocks, dep_pages = _block_payloads(db, block_uids)
        pages = _page_payloads(db, page_ids | dep_pages)
        sidebar = [SyncSidebarEntry(**dict(row)) for sid in sidebar_ids
                   if (row := db.execute(
                       "SELECT id, title, order_idx FROM sidebar_entries"
                       " WHERE id = ?", (sid,)).fetchone()) is not None]

        present_blocks = {b.uid for b in blocks}
        present_pages = {p.id for p in pages}
        present_sidebar = {s.id for s in sidebar}
        tombstones = [
            SyncTombstone(kind=k, entity_id=e) for k, e in win.entities
            if (k == "block" and e not in present_blocks)
            or (k == "page" and int(e) not in present_pages)
            or (k == "sidebar" and int(e) not in present_sidebar)]
        return ChangesPayload(
            next_since=win.next_since if rows else since,
            latest_seq=latest, pages=pages, blocks=blocks, sidebar=sidebar,
            tombstones=tombstones)
    finally:
        db.rollback()  # end the read transaction; nothing was written


@router.get("/api/sync/snapshot", response_model=SnapshotPayload)
def sync_snapshot(db: sqlite3.Connection = Depends(get_db)
                  ) -> SnapshotPayload:
    db.execute("BEGIN")
    try:
        seq = db.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
        uids = [r["uid"] for r in db.execute("SELECT uid FROM blocks")]
        blocks, _ = _block_payloads(db, uids)
        pages = [SyncPage(**dict(r)) for r in db.execute(
            "SELECT id, title, created_at, updated_at FROM pages")]
        sidebar = [SyncSidebarEntry(**dict(r)) for r in db.execute(
            "SELECT id, title, order_idx FROM sidebar_entries")]
        return SnapshotPayload(seq=seq, pages=pages, blocks=blocks,
                               sidebar=sidebar)
    finally:
        db.rollback()
```

Register in `server/src/pkm/server/app.py` next to the other routers:

```python
from pkm.server.routes_sync import router as sync_router
# ...
app.include_router(sync_router)
```

- [ ] **Step 5: Run the tests**

Run: `cd server && uv run pytest tests/test_sync_endpoints.py -q` — expected: PASS.
Run: `cd server && uv run pytest -q` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/pkm/server/routes_sync.py server/src/pkm/server/response_models.py server/src/pkm/server/app.py server/tests/test_sync_endpoints.py
git commit -m "feat(server): windowed changes feed + bootstrap snapshot (pkm-y8p0)"
```

---

### Task 4: WS seq nudge from every journal-advancing commit

**Files:**
- Create: `server/src/pkm/server/notify.py`
- Modify: `server/src/pkm/server/routes_ops.py:29-35`
- Modify: `server/src/pkm/server/routes_pages.py` (after commits at lines 134, 157, 176, 232)
- Modify: `server/src/pkm/server/routes_sidebar.py` (after commits at lines 47, 58, 74)
- Modify: `web/src/sync/socket.ts:36-38`
- Test: extend `server/tests/test_ws.py`; extend `web/src/sync/SyncProvider.test.tsx` or `socket` coverage via a small unit test

**Interfaces:**
- Consumes: `changes` table (Task 1), `Hub.broadcast` (existing).
- Produces: WS frame `{"type": "seq", "seq": <int>}` after every commit that advanced the journal. `notify.nudge_threadpool(request, db)` for sync-`def` routes; async routes `await notify.nudge(request, db)`.

- [ ] **Step 1: Write failing tests**

Append to `server/tests/test_ws.py`:

```python
def _frames_until_seq(ws, tries=5):
    frames = []
    for _ in range(tries):
        frames.append(ws.receive_json())
        if frames[-1].get("type") == "seq":
            return frames
    raise AssertionError(f"no seq nudge in {frames}")


def test_ops_commit_emits_seq_nudge_after_batch_frame(client):
    with client.websocket_connect("/api/ws") as ws:
        r = client.post("/api/ops", json={
            "client_id": "n1",
            "ops": [{"op": "update_text", "uid": "uid_b1", "text": "x"}]})
        assert r.status_code == 200
        frames = _frames_until_seq(ws)
        assert frames[-1]["seq"] > 0


def test_non_op_write_paths_emit_seq_nudge(client):
    # sidebar write and page create commit outside /api/ops -- the exact
    # paths the spec calls out as silent today
    with client.websocket_connect("/api/ws") as ws:
        assert client.post("/api/sidebar",
                           json={"title": "AI"}).status_code == 200
        assert _frames_until_seq(ws)[-1]["type"] == "seq"
    with client.websocket_connect("/api/ws") as ws:
        assert client.post("/api/pages",
                           json={"title": "Nudge Page"}).status_code == 200
        assert _frames_until_seq(ws)[-1]["type"] == "seq"


def test_daily_autocreate_on_get_emits_seq_nudge(client):
    with client.websocket_connect("/api/ws") as ws:
        r = client.get("/api/page/July%2013th,%202026")
        assert r.status_code == 200
        assert _frames_until_seq(ws)[-1]["type"] == "seq"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_ws.py -q`
Expected: new tests FAIL (no seq frame arrives; `_frames_until_seq` raises or times out).

- [ ] **Step 3: Implement the nudge helper and wire the routes**

Create `server/src/pkm/server/notify.py`:

```python
# pattern: Imperative Shell
"""Post-commit WS nudges. Invariant (spec section 1): every transaction
that advances changes.seq emits a nudge -- strictly AFTER a successful
commit. Nudges are best-effort signals; the client's cursor pull is the
correctness mechanism, and Hub.broadcast drops connections whose send
fails, so a lost nudge becomes a reconnect + catch-up pull."""
from __future__ import annotations

import sqlite3

import anyio.from_thread
from fastapi import Request


def _seq_frame(db: sqlite3.Connection) -> dict:
    seq = db.execute("SELECT COALESCE(MAX(seq), 0) FROM changes").fetchone()[0]
    return {"type": "seq", "seq": seq}


async def nudge(request: Request, db: sqlite3.Connection) -> None:
    """From async routes, after db.commit()."""
    await request.app.state.hub.broadcast(_seq_frame(db))


def nudge_threadpool(request: Request, db: sqlite3.Connection) -> None:
    """From sync-def routes, after db.commit(). Starlette runs these in an
    anyio worker thread, so from_thread.run reaches the event loop."""
    frame = _seq_frame(db)
    anyio.from_thread.run(request.app.state.hub.broadcast, frame)
```

Wire it in:

- `routes_ops.py`: the route already has `request`; after the existing `await request.app.state.hub.broadcast({...})` add `await nudge(request, db)`.
- `routes_pages.py` and `routes_sidebar.py`: each write handler gains a `request: Request` parameter (FastAPI injects it alongside existing params); immediately after each `db.commit()` at the listed lines add `nudge_threadpool(request, db)`. That is: sidebar add/delete/reorder, page create, page delete, the daily auto-create commit inside `get_page` (line 134 — nudge only in the branch that actually created the page), and the journal-view daily auto-create (line 232, same conditional treatment).
- `routes_assets.py:136` commits only to the `assets` table, which is not journaled — no nudge needed; leave it and note why in the code only if a reviewer asks.

Update `web/src/sync/socket.ts` so the new frame can't crash the current client (today every frame is cast to `WsBatch` and its `ops` array is iterated):

```typescript
    ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as unknown;
      // Nudge frames ({type:"seq"}) arrive once the server ships the
      // offline sync protocol (pkm-y8p0); the replica consumes them in a
      // later phase. Only op batches are dispatched here.
      if (!msg || !Array.isArray((msg as WsBatch).ops)) return;
      opts.onBatch(msg as WsBatch);
    };
```

- [ ] **Step 4: Run server and web verification**

Run: `cd server && uv run pytest tests/test_ws.py -q` — expected: PASS.
Run: `cd server && uv run pytest -q` — expected: PASS (existing broadcast test still sees the batch frame first: the nudge is emitted after it).
Run: `cd web && pnpm test -- --run` and `cd web && pnpm typecheck` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/notify.py server/src/pkm/server/routes_ops.py server/src/pkm/server/routes_pages.py server/src/pkm/server/routes_sidebar.py server/tests/test_ws.py web/src/sync/socket.ts
git commit -m "feat(server): post-commit WS seq nudge on every journaled write (pkm-y8p0)"
```

---

### Task 5: Idempotent op batches (`batch_id` + `applied_batches`)

**Files:**
- Modify: `server/src/pkm/server/ops_core.py:64-66` (OpBatch) + new `batch_request_hash`
- Modify: `server/src/pkm/server/routes_ops.py`
- Test: `server/tests/test_ops_idempotency.py` (new)

**Interfaces:**
- Consumes: `applied_batches` table (Task 1).
- Produces: `OpBatch.batch_id: str | None`; `batch_request_hash(batch: OpBatch) -> str` (sha256 hex over the canonical ops JSON, excluding `client_id`/`batch_id`). Replayed `batch_id` + same hash → stored response, no effects; same id + different hash → 409.

- [ ] **Step 1: Write failing tests**

Create `server/tests/test_ops_idempotency.py`:

```python
"""batch_id dedup: a committed-but-unacknowledged batch retried by the
durable client queue must not double-apply (spec section 1)."""

BATCH = {
    "client_id": "c1",
    "batch_id": "batch-0001-aaaa",
    "ops": [{"op": "create", "uid": "uid_idem1", "page_title": "AI",
             "parent_uid": None, "order_idx": 0, "text": "queued offline"}],
}


def test_replay_returns_stored_ack_and_applies_nothing(client):
    r1 = client.post("/api/ops", json=BATCH)
    assert r1.status_code == 200
    r2 = client.post("/api/ops", json=BATCH)  # retry after lost ack
    assert r2.status_code == 200
    assert r2.json() == r1.json()
    # the create ran once: a second application would 400 (uid exists),
    # and the block must exist exactly once
    page = client.get("/api/page/AI").json()
    uids = [b["uid"] for b in page["blocks"]]
    assert uids.count("uid_idem1") == 1


def test_same_batch_id_different_ops_is_rejected(client):
    r1 = client.post("/api/ops", json=BATCH)
    assert r1.status_code == 200
    evil = dict(BATCH, ops=[{"op": "update_text", "uid": "uid_b1",
                             "text": "different payload"}])
    r2 = client.post("/api/ops", json=evil)
    assert r2.status_code == 409


def test_batch_without_batch_id_behaves_as_today(client):
    body = {"client_id": "c1", "ops": [
        {"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]}
    assert client.post("/api/ops", json=body).status_code == 200
    # replaying WITHOUT batch_id re-applies (idempotent op, still 200):
    assert client.post("/api/ops", json=body).status_code == 200


def test_rejected_batch_is_not_recorded(client):
    bad = {"client_id": "c1", "batch_id": "batch-0002-bbbb",
           "ops": [{"op": "update_text", "uid": "no_such_uid", "text": "x"}]}
    assert client.post("/api/ops", json=bad).status_code == 400
    # the same batch_id with a now-valid payload must not be poisoned
    ok = {"client_id": "c1", "batch_id": "batch-0002-bbbb",
          "ops": [{"op": "update_text", "uid": "uid_b1", "text": "fixed"}]}
    assert client.post("/api/ops", json=ok).status_code == 200
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_ops_idempotency.py -q`
Expected: FAIL — first test 400s on replay (`uid already exists`), second returns 200 not 409.

- [ ] **Step 3: Implement**

In `server/src/pkm/server/ops_core.py`, extend `OpBatch` and add the hash helper (hashlib/json are pure — Functional Core compatible):

```python
class OpBatch(BaseModel):
    client_id: str = Field(min_length=1, max_length=64)
    # Durable client queues retry pushes; batch_id makes the retry safe.
    # Absent => pre-offline client, applied unconditionally as before.
    batch_id: str | None = Field(default=None, min_length=8, max_length=64)
    ops: list[BlockOp] = Field(min_length=1, max_length=500)
```

```python
import hashlib
import json


def batch_request_hash(batch: OpBatch) -> str:
    """Canonical content hash binding a batch_id to one payload forever
    (spec section 1): replay with a different payload is rejected, so a
    buggy client can't silently swap the ops behind an acknowledged id."""
    canon = json.dumps([op.model_dump() for op in batch.ops],
                       sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()
```

In `server/src/pkm/server/routes_ops.py`, replace the handler body:

```python
@router.post("/api/ops")
async def post_ops(request: Request,
                   batch: OpBatch,
                   db: sqlite3.Connection = Depends(get_db)) -> dict:
    now = int(time.time() * 1000)
    rhash = batch_request_hash(batch) if batch.batch_id is not None else None
    if batch.batch_id is not None:
        row = db.execute(
            "SELECT request_hash, response FROM applied_batches"
            " WHERE batch_id = ?", (batch.batch_id,)).fetchone()
        if row is not None:
            if row["request_hash"] != rhash:
                raise HTTPException(
                    status_code=409,
                    detail="batch_id was already used with different ops")
            return json.loads(row["response"])  # replay: stored ack, no effects
    try:
        broadcast_ops = apply_batch(db, batch, now)
    except OpError as e:
        db.rollback()
        raise HTTPException(status_code=400,
                            detail={"index": e.index, "reason": e.reason})
    response = {"ok": True, "ts": now, "applied": len(batch.ops)}
    if batch.batch_id is not None:
        try:
            db.execute(
                "INSERT INTO applied_batches VALUES (?,?,?,?)",
                (batch.batch_id, rhash, json.dumps(response), now))
        except sqlite3.IntegrityError:
            # two concurrent submissions of the same batch raced; this one
            # loses -- roll back its effects and serve the winner's ack
            db.rollback()
            row = db.execute(
                "SELECT response FROM applied_batches WHERE batch_id = ?",
                (batch.batch_id,)).fetchone()
            assert row is not None
            return json.loads(row["response"])
    db.commit()
    await request.app.state.hub.broadcast({
        "client_id": batch.client_id,
        "ts": now,
        "ops": broadcast_ops,
    })
    await nudge(request, db)
    return response
```

Add `import json` and `from pkm.server.ops_core import batch_request_hash` (extend the existing import); keep the Task 4 `nudge` import.

Retention is deliberate: **no pruning** of `applied_batches` (spec: a durable client queue can outlive any expiry window; rows are tiny).

- [ ] **Step 4: Run tests**

Run: `cd server && uv run pytest tests/test_ops_idempotency.py tests/test_ops_endpoint.py -q` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/ops_core.py server/src/pkm/server/routes_ops.py server/tests/test_ops_idempotency.py
git commit -m "feat(server): idempotent op batches via batch_id dedup (pkm-y8p0)"
```

---

### Task 6: `create_page` op

**Files:**
- Modify: `server/src/pkm/server/ops_core.py` (new model, union, planner branch)
- Modify: `server/src/pkm/server/ops_apply.py:53-70` (`_context_for`)
- Test: extend `server/tests/test_ops_endpoint.py`

**Interfaces:**
- Consumes: `get_or_create_page` (existing), journal triggers (Task 1).
- Produces: op `{"op": "create_page", "page_title": str}` accepted by `/api/ops`; idempotent; page creation journaled. The web offline shim (later phase) enqueues this for explicit page creates.

- [ ] **Step 1: Write failing tests**

Append to `server/tests/test_ops_endpoint.py`:

```python
def test_create_page_op_creates_and_is_idempotent(client):
    body = {"client_id": "c1", "ops": [
        {"op": "create_page", "page_title": "Offline Made Me"}]}
    assert client.post("/api/ops", json=body).status_code == 200
    assert client.post("/api/ops", json=body).status_code == 200  # replayable
    r = client.get("/api/page/Offline%20Made%20Me")
    assert r.status_code == 200
    # exactly one page: titles endpoint returns it once
    titles = client.get("/api/titles?q=Offline%20Made%20Me").json()["titles"]
    assert titles.count("Offline Made Me") == 1


def test_create_page_op_reaches_changes_feed(client):
    start = client.get("/api/sync/changes").json()["latest_seq"]
    client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "create_page", "page_title": "Feed Visible"}]})
    feed = client.get(f"/api/sync/changes?since={start}").json()
    assert "Feed Visible" in {p["title"] for p in feed["pages"]}
```

(If the titles response shape differs, mirror `test_titles_endpoint.py`'s accessor.)

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_ops_endpoint.py -q`
Expected: FAIL — 422 (unknown op discriminator).

- [ ] **Step 3: Implement**

In `server/src/pkm/server/ops_core.py`:

```python
class CreatePageOp(BaseModel):
    """Durable push path for offline page creation (spec section 1): an
    empty page created offline has no block op to carry its title, so page
    creation is itself an op -- get_or_create semantics, safely replayable."""
    op: Literal["create_page"]
    page_title: str = Field(min_length=1)
```

Add `CreatePageOp` to the `BlockOp` union. In `plan_op`, branch **before** any `op.uid` access (CreatePageOp has no uid):

```python
def plan_op(index: int, op: BlockOp, ctx: OpContext) -> tuple[Effect, ...]:
    if isinstance(op, CreatePageOp):
        if ctx.page_id is None:
            raise OpError(index, "page could not be resolved")
        # creation happened in context assembly (get_or_create, same as
        # CreateOp); the journal trigger recorded it. Nothing to execute.
        return ()
    if isinstance(op, CreateOp):
        ...
```

In `server/src/pkm/server/ops_apply.py` `_context_for`, branch before `_block_info(db, op.uid)` (same reason):

```python
def _context_for(db: sqlite3.Connection, op, now_ms: int) -> OpContext:
    if isinstance(op, CreatePageOp):
        page = get_or_create_page(db, op.page_title, now_ms)
        return OpContext(page_id=page["id"])
    block = _block_info(db, op.uid)
    ...
```

Add `CreatePageOp` to the `ops_core` import list in `ops_apply.py`.

- [ ] **Step 4: Run tests**

Run: `cd server && uv run pytest tests/test_ops_endpoint.py tests/test_ops_core.py -q` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/ops_core.py server/src/pkm/server/ops_apply.py server/tests/test_ops_endpoint.py
git commit -m "feat(server): create_page op for offline page creation (pkm-y8p0)"
```

---

### Task 7: `base_text_hash` conflict handling

**Files:**
- Modify: `server/src/pkm/server/ops_core.py` (op field, ctx fields, planner, marker helpers, `text_hash`)
- Modify: `server/src/pkm/server/ops_apply.py` (`_context_for` for update ops)
- Test: extend `server/tests/test_ops_core.py` (planner matrix) and `server/tests/test_ops_endpoint.py` (end-to-end)

**Interfaces:**
- Consumes: `OpContext`, `plan_op`, effects (existing); `pkm.server.daily.title_for_date`; journal (Task 1).
- Produces: `UpdateTextOp.base_text_hash: str | None`; `text_hash(text: str) -> str` (sha256 hex — the client computes the same); conflict-copy text format `"[[conflict]] " + lost_text` and orphan format `"[[conflict]] (original block deleted) " + text`. `OpContext` gains `current_text`, `order_idx`, `conflict_uid`, `daily_page_id`, `daily_append_idx` (all optional).

- [ ] **Step 1: Write failing planner tests**

Append to `server/tests/test_ops_core.py`:

```python
from pkm.server.ops_core import (BlockInfo, InsertBlock, OpContext,
                                 ShiftSiblings, TouchPage, UpdateText,
                                 UpdateTextOp, plan_op, text_hash)

_BLK = BlockInfo("uid_t1", page_id=1, parent_uid=None)


def _ctx(current="old text", order=2):
    return OpContext(block=_BLK, current_text=current, order_idx=order,
                     conflict_uid="uid_cf1")


def _op(text="new text", base="old text"):
    return UpdateTextOp(op="update_text", uid="uid_t1", text=text,
                        base_text_hash=text_hash(base))


def test_check_1_missing_block_lands_on_daily_page():
    ctx = OpContext(block=None, conflict_uid="uid_cf1",
                    daily_page_id=9, daily_append_idx=4)
    effs = plan_op(0, _op(), ctx)
    ins = next(e for e in effs if isinstance(e, InsertBlock))
    assert ins.page_id == 9 and ins.order_idx == 4 and ins.parent_uid is None
    assert ins.text == "[[conflict]] (original block deleted) new text"


def test_check_2_identical_text_is_noop_even_with_stale_hash():
    # device 2 pushes the same text device 1 already synced: base hash is
    # stale but the content matches -- never a conflict (spec section 2)
    effs = plan_op(0, _op(text="same", base="anything else"),
                   _ctx(current="same"))
    assert effs == ()


def test_check_3_absent_hash_applies_as_today():
    op = UpdateTextOp(op="update_text", uid="uid_t1", text="new")
    effs = plan_op(0, op, OpContext(block=_BLK))
    assert any(isinstance(e, UpdateText) for e in effs)
    assert not any(isinstance(e, InsertBlock) for e in effs)


def test_check_4_matching_hash_applies_without_conflict():
    effs = plan_op(0, _op(), _ctx())
    assert any(isinstance(e, UpdateText) for e in effs)
    assert not any(isinstance(e, InsertBlock) for e in effs)


def test_check_5_stale_hash_wins_and_preserves_loser_as_sibling():
    effs = plan_op(0, _op(base="what I saw before going offline"),
                   _ctx(current="server text meanwhile"))
    upd = next(e for e in effs if isinstance(e, UpdateText))
    assert upd.text == "new text"  # incoming wins (LWW)
    shift = next(e for e in effs if isinstance(e, ShiftSiblings))
    ins = next(e for e in effs if isinstance(e, InsertBlock))
    assert shift.from_idx == 3 and ins.order_idx == 3  # right after target
    assert ins.text == "[[conflict]] server text meanwhile"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && uv run pytest tests/test_ops_core.py -q`
Expected: FAIL — `base_text_hash` unknown field / `text_hash` import error.

- [ ] **Step 3: Implement the core**

In `server/src/pkm/server/ops_core.py`:

```python
class UpdateTextOp(BaseModel):
    op: Literal["update_text"]
    uid: str
    text: str
    # sha256 hex of the text this edit was based on. Absent => legacy
    # client, LWW-apply as always. Present => conflict detection per spec
    # section 2 (text hash, not a version counter: structural changes must
    # never manufacture a text conflict).
    base_text_hash: str | None = Field(default=None, min_length=64,
                                       max_length=64)


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def conflict_copy_text(lost_text: str) -> str:
    """Overwritten text preserved as an ordinary block, [[conflict]]-tagged
    so it is findable via search and the conflict page's backlinks."""
    return f"[[conflict]] {lost_text}"


def orphan_conflict_text(text: str) -> str:
    return f"[[conflict]] (original block deleted) {text}"
```

Extend `OpContext`:

```python
@dataclass(frozen=True)
class OpContext:
    block: BlockInfo | None = None
    page_id: int | None = None
    parent: BlockInfo | None = None
    parent_chain: tuple[str, ...] = ()
    subtree: tuple[str, ...] = ()
    # update_text conflict handling (spec section 2); populated by the
    # shell only when the op carries base_text_hash
    current_text: str | None = None      # target's text right now
    order_idx: int | None = None         # target's order_idx
    conflict_uid: str | None = None      # fresh uid for a conflict copy
    daily_page_id: int | None = None     # orphan landing page
    daily_append_idx: int | None = None  # next top-level idx there
```

In `plan_op`, insert the orphan branch immediately before the generic `if ctx.block is None: raise OpError(...)`:

```python
    if (isinstance(op, UpdateTextOp) and op.base_text_hash is not None
            and ctx.block is None):
        # edit-vs-delete race: uid+text is all we have, the deleted row's
        # page/parent are gone -> conflict block appended to today's daily
        # page rather than dropping the edit (spec section 2, check 1)
        if (ctx.conflict_uid is None or ctx.daily_page_id is None
                or ctx.daily_append_idx is None):
            raise OpError(index, "conflict context missing")
        text = orphan_conflict_text(op.text)
        return (InsertBlock(ctx.conflict_uid, ctx.daily_page_id, None,
                            ctx.daily_append_idx, text, None),
                ReindexRefs(ctx.conflict_uid, text),
                TouchPage(ctx.daily_page_id))
```

Replace the `UpdateTextOp` branch:

```python
    if isinstance(op, UpdateTextOp):
        base_effects = (UpdateText(op.uid, op.text),
                        ReindexRefs(op.uid, op.text),
                        TouchPage(ctx.block.page_id))
        if op.base_text_hash is None:
            return base_effects                      # check 3: legacy
        if ctx.current_text is None or ctx.order_idx is None \
                or ctx.conflict_uid is None:
            raise OpError(index, "conflict context missing")
        if op.text == ctx.current_text:
            return ()                                # check 2: identical
        if text_hash(ctx.current_text) == op.base_text_hash:
            return base_effects                      # check 4: clean apply
        # check 5: concurrent edit -- incoming wins, loser preserved as a
        # sibling right after the target
        lost = conflict_copy_text(ctx.current_text)
        idx = ctx.order_idx + 1
        return (ShiftSiblings(ctx.block.page_id, ctx.block.parent_uid, idx),
                InsertBlock(ctx.conflict_uid, ctx.block.page_id,
                            ctx.block.parent_uid, idx, lost, None),
                ReindexRefs(ctx.conflict_uid, lost),
                *base_effects)
```

- [ ] **Step 4: Wire the shell context and run the planner tests**

In `server/src/pkm/server/ops_apply.py` `_context_for`, replace the fallthrough `return OpContext(block=block)` handling for update ops:

```python
    if isinstance(op, UpdateTextOp) and op.base_text_hash is not None:
        conflict_uid = _new_uid()
        if block is None:
            daily = get_or_create_page(
                db, title_for_date(date.today()), now_ms)
            idx = db.execute(
                "SELECT COALESCE(MAX(order_idx) + 1, 0) FROM blocks"
                " WHERE page_id = ? AND parent_uid IS NULL",
                (daily["id"],)).fetchone()[0]
            return OpContext(block=None, conflict_uid=conflict_uid,
                             daily_page_id=daily["id"],
                             daily_append_idx=idx)
        row = db.execute(
            "SELECT text, order_idx FROM blocks WHERE uid = ?",
            (op.uid,)).fetchone()
        return OpContext(block=block, current_text=row["text"],
                         order_idx=row["order_idx"],
                         conflict_uid=conflict_uid)
    return OpContext(block=block)
```

With imports and the uid helper at module level:

```python
import secrets
from datetime import date

from pkm.server.daily import title_for_date


def _new_uid() -> str:
    return secrets.token_urlsafe(9)  # 12 chars of [A-Za-z0-9_-]: fits UID_RE
```

(`UpdateTextOp` joins the existing `ops_core` import list.)

Run: `cd server && uv run pytest tests/test_ops_core.py -q` — expected: PASS.

- [ ] **Step 5: Write and run end-to-end conflict tests**

Append to `server/tests/test_ops_endpoint.py`:

```python
from pkm.server.ops_core import text_hash


def test_conflict_copy_lands_next_to_target(client):
    # uid_b1's live text is "Tags:: #AI" (conftest seed); simulate an
    # offline edit based on stale text
    r = client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "update_text", "uid": "uid_b1", "text": "offline edit",
         "base_text_hash": text_hash("some stale base")}]})
    assert r.status_code == 200
    page = client.get("/api/page/Machine%20Learning").json()
    texts = [b["text"] for b in page["blocks"]]
    i = texts.index("offline edit")
    assert texts[i + 1] == "[[conflict]] Tags:: #AI"


def test_no_false_conflict_after_structural_change(client):
    base = "Tags:: #AI"
    # a collapse (structural op) between base and push must NOT conflict
    client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]})
    r = client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "update_text", "uid": "uid_b1", "text": "clean edit",
         "base_text_hash": text_hash(base)}]})
    assert r.status_code == 200
    page = client.get("/api/page/Machine%20Learning").json()
    assert not any("[[conflict]]" in b["text"] for b in page["blocks"])


def test_orphaned_edit_lands_on_todays_daily_page(client):
    from datetime import date
    from pkm.server.daily import title_for_date
    client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "delete", "uid": "uid_b6"}]})
    r = client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "update_text", "uid": "uid_b6", "text": "edited after delete",
         "base_text_hash": text_hash("whatever")}]})
    assert r.status_code == 200
    daily = client.get(f"/api/page/{title_for_date(date.today())}").json()
    assert any(
        b["text"] == "[[conflict]] (original block deleted) edited after delete"
        for b in daily["blocks"])


def test_hashless_update_on_missing_block_still_400s(client):
    r = client.post("/api/ops", json={"client_id": "c1", "ops": [
        {"op": "update_text", "uid": "gone_uid1", "text": "x"}]})
    assert r.status_code == 400
```

Run: `cd server && uv run pytest tests/test_ops_endpoint.py -q` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/pkm/server/ops_core.py server/src/pkm/server/ops_apply.py server/tests/test_ops_core.py server/tests/test_ops_endpoint.py
git commit -m "feat(server): base_text_hash conflict handling with conflict-copy blocks (pkm-y8p0)"
```

---

### Task 8: Regenerate API artifacts + full verification

**Files:**
- Modify: `web/src/api/openapi.json` (regenerated)
- Modify: `web/src/api/types.d.ts` (regenerated)
- Modify: `web/src/api/ops.ts` (only if `test_openapi_sync.py` / typecheck demand the new op alias)
- Modify: `.beans/pkm-y8p0--offline-editing-paving-the-way-for-native-apps-ios.md`

**Interfaces:**
- Produces: web-visible types for `batch_id`, `base_text_hash`, `CreatePageOp`, sync payloads — consumed by the web phases (child beans 3–6).

- [ ] **Step 1: Regenerate the OpenAPI schema and TS types**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
```

- [ ] **Step 2: Add the new op alias if the generated schema includes it**

In `web/src/api/ops.ts`, extend the alias block (keeps the "server models are the single source of truth" contract):

```typescript
export type CreatePageOp = components["schemas"]["CreatePageOp"];

export type BlockOp =
  | CreateOp | UpdateTextOp | MoveOp | DeleteOp | SetCollapsedOp
  | SetHeadingOp | CreatePageOp;
```

- [ ] **Step 3: Run the complete verification suite**

```bash
cd server && uv run pytest -q          # expected: all pass
cd server && uv run pyrefly check      # expected: clean
cd server && uv run ruff check         # expected: clean
cd web && pnpm test -- --run           # expected: all pass
cd web && pnpm typecheck               # expected: clean
```

- [ ] **Step 4: Update the epic bean and commit**

Tick the server-phase child beans (created alongside this plan) and note in `pkm-y8p0` that the server protocol is implemented. Commit:

```bash
git add web/src/api/openapi.json web/src/api/types.d.ts web/src/api/ops.ts .beans/
git commit -m "chore(api): regenerate schema/types for sync protocol (pkm-y8p0)"
```

---

## Deliberately NOT in this plan (web phases, separate plans)

Replica worker + bootstrap (child bean 3), persisted queue + optimistic apply + TS refs + negative-id reconciliation (bean 4), apiFetch offline shim (bean 5), offline FTS search (bean 6), service worker + asset cache (bean 7). Two spec guardrails bind those plans: schema-mismatch recovery reads the pending queue **before** any teardown (queue table `pending_ops(id, batch_id, ops_json)`, additive changes only), and quota-exhausted-offline rejects edits rather than holding a volatile queue.
