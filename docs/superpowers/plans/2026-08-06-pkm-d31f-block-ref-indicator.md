# Block Reference Indicator (pkm-d31f) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Blocks referenced via `((uid))` show a count badge in the right gutter; clicking it opens a popover listing the referencing locations, backlink-style, with navigation.

**Architecture:** A new `block_refs(src_block_uid, target_block_uid)` table in the replicated BASE_DDL, maintained at the same write choke points that maintain `refs` (server `ops_apply.py`, client `localOps.ts`) and *derived locally* by the client sync applier — block refs are never shipped over sync (the extractor is parity-pinned on both sides, and targets are uids needing no id resolution). Page and journal payloads gain a `block_ref_counts` map; a new `GET /api/block/{uid}/backlinks` endpoint feeds the popover, mirrored byte-identically in the offline shim.

**Tech Stack:** FastAPI + sqlite (server), React + sqlite-wasm replica (web), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-08-06-pkm-d31f-block-ref-indicator-design.md`

## Global Constraints

- Work happens in a worktree branch (`superpowers:using-git-worktrees`); merge with `git merge --no-ff`. Worktrees base on origin/main.
- Every new runtime file declares `# pattern: Functional Core` or `# pattern: Imperative Shell` (or `//` for TS) near the top.
- Bean `pkm-d31f` (`.beans/`): set `-s in-progress` at start; keep its checklist current; commit the bean file with code changes; complete it in the final task with a `## Summary of Changes`.
- Generated artifacts must be regenerated in the same commit as the change that invalidates them (server tests enforce staleness):
  - Base schema: `cd server && uv run python -m pkm.schema_dump > ../web/src/replica/baseSchema.gen.ts`
  - OpenAPI: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json` then `cd web && pnpm gen-types`
  - Shim parity: `cd server && uv run python -m pkm.server.shim_parity_dump > ../shared/fixtures/shim_parity.json`
- Verification gates before claiming done: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`; `cd web && pnpm verify` (typecheck + unit coverage + Playwright e2e; export `CI=true` for headless pnpm).
- Count semantics everywhere: **distinct referencing blocks** (the PK collapses duplicate mentions), only uids with count ≥ 1 appear in maps.
- No pagination / silent truncation on the new endpoint — return every referencing block.
- Shim responses must be deep-equal to the server's (`parity.test.ts` replays the fixture).

---

### Task 1: `block_refs` table in the schema + regenerated client schema artifact

**Files:**
- Modify: `server/src/pkm/schema.py` (BASE_DDL, after the `refs` table ~line 49)
- Regenerate: `web/src/replica/baseSchema.gen.ts`
- Modify: `server/tests/conftest.py` (seed rows)
- Test: `server/tests/test_schema.py`

**Interfaces:**
- Consumes: nothing.
- Produces: table `block_refs(src_block_uid TEXT, target_block_uid TEXT)` with index `idx_block_refs_target`, present in both server DDL and the replica's BASE_SCHEMA. conftest seed row `("uid_b5", "uid_b3")` (uid_b5's text is `"See ((uid_b3)) for details"`).

- [ ] **Step 1: Write the failing test**

Append to `server/tests/test_schema.py` (match its existing style — it exercises `init_db` output):

```python
def test_block_refs_table_exists(tmp_path):
    from pkm.server.db import init_db, open_db
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)
    con = open_db(db_path)
    cols = [r[1] for r in con.execute("PRAGMA table_info(block_refs)")]
    assert cols == ["src_block_uid", "target_block_uid"]
    indexes = {r[1] for r in con.execute("PRAGMA index_list(block_refs)")}
    assert "idx_block_refs_target" in indexes
    con.close()
```

(If `test_schema.py` already has an `init_db`/`open_db` import or a helper fixture, reuse it instead of the local import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_schema.py -q`
Expected: FAIL — `block_refs` has no columns.

- [ ] **Step 3: Add the table to BASE_DDL**

In `server/src/pkm/schema.py`, directly after `CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_page_id);`:

```sql
-- pkm-d31f: incoming ((uid)) index, the block-level analogue of refs.
-- No FK on target_block_uid: an unresolved ((uid)) is a legal state (it
-- renders unresolved), so dangling rows are permitted and simply never
-- match a count query. Rows are derived from block text at every write
-- choke point (ops_apply.py, localOps.ts, apply.ts) and NEVER shipped
-- over sync -- targets are uids, needing no id resolution, and the
-- extractor is parity-pinned (refs_parity.json).
CREATE TABLE IF NOT EXISTS block_refs(
  src_block_uid    TEXT NOT NULL REFERENCES blocks(uid) ON DELETE CASCADE,
  target_block_uid TEXT NOT NULL,
  PRIMARY KEY (src_block_uid, target_block_uid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_block_refs_target ON block_refs(target_block_uid);
```

- [ ] **Step 4: Regenerate the client schema artifact**

Run: `cd server && uv run python -m pkm.schema_dump > ../web/src/replica/baseSchema.gen.ts`

(This is what bumps the client schema hash and forces every replica to rebootstrap — the client-side "migration".)

- [ ] **Step 5: Seed conftest so the shared fixture DB stays representative**

In `server/tests/conftest.py`, add next to `SEED_REFS`:

```python
SEED_BLOCK_REFS = [
    ("uid_b5", "uid_b3"),  # "See ((uid_b3)) for details"
]
```

and in `seeded_config`, after the `SEED_REFS` executemany:

```python
    con.executemany("INSERT INTO block_refs VALUES (?,?)", SEED_BLOCK_REFS)
```

- [ ] **Step 6: Run the server suite**

Run: `cd server && uv run pytest -q`
Expected: PASS (the schema-artifact test passes because Step 4 regenerated it; if any payload-shape test fails here, STOP — nothing else changed yet, so investigate).

- [ ] **Step 7: Commit**

```bash
git add server/src/pkm/schema.py web/src/replica/baseSchema.gen.ts \
        server/tests/test_schema.py server/tests/conftest.py .beans
git commit -m "pkm-d31f: add block_refs table to the replicated schema"
```

---

### Task 2: Server write-path maintenance

**Files:**
- Modify: `server/src/pkm/server/store.py` (new helper near `index_ref`, ~line 73; and `rewrite_snapshotted_blocks`, ~line 140)
- Modify: `server/src/pkm/server/ops_apply.py` (the `ReindexRefs` branch, ~line 178)
- Test: `server/tests/test_block_ref_index.py` (new)

**Interfaces:**
- Consumes: `pkm.refs.extract(text).block_refs -> tuple[str, ...]` (already exists); `block_refs` table from Task 1.
- Produces: `store.reindex_block_refs(db: sqlite3.Connection, src_uid: str, targets: Iterable[str]) -> None` — deletes + reinserts one block's rows. Every text write through `POST /api/ops` (create, update_text, conflict-block insert) and every title-rename rewrite keeps `block_refs` current.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_block_ref_index.py`:

```python
"""pkm-d31f: block_refs stays current through every text write path."""
import sqlite3

from pkm.server.db import open_db


def _rows(config) -> set[tuple[str, str]]:
    con = open_db(config.db_path)
    try:
        return set(con.execute(
            "SELECT src_block_uid, target_block_uid FROM block_refs"))
    finally:
        con.close()


def _post_ops(client, ops, batch_id):
    r = client.post("/api/ops", json={
        "client_id": "t-d31f", "batch_id": batch_id, "ops": ops})
    assert r.status_code == 200, r.text
    return r


def test_create_indexes_block_refs(client, seeded_config):
    _post_ops(client, [{
        "op": "create", "uid": "uid_new01", "page_title": "AI",
        "parent_uid": None, "order_idx": 5,
        "text": "see ((uid_b3)) and ((uid_b3)) twice, plus ((uid_b1))",
    }], "b1")
    assert {("uid_new01", "uid_b3"), ("uid_new01", "uid_b1")} <= _rows(seeded_config)
    # duplicate mentions collapse to one row (count = referencing blocks)
    assert len([r for r in _rows(seeded_config) if r[0] == "uid_new01"]) == 2


def test_update_text_replaces_block_refs(client, seeded_config):
    _post_ops(client, [{"op": "update_text", "uid": "uid_b5",
                        "text": "now points at ((uid_b1))"}], "b2")
    rows = _rows(seeded_config)
    assert ("uid_b5", "uid_b1") in rows
    assert ("uid_b5", "uid_b3") not in rows


def test_delete_block_cascades_block_refs(client, seeded_config):
    _post_ops(client, [{"op": "delete", "uid": "uid_b5"}], "b3")
    assert all(src != "uid_b5" for src, _ in _rows(seeded_config))


def test_rename_rewrite_preserves_block_refs(client, seeded_config):
    # uid_b3's text holds [[Paper]]; renaming Paper rewrites uid_b3's text.
    # uid_b5 -> uid_b3 must survive, and uid_b3's own outgoing rows (none)
    # must be re-derived from the rewritten text without error.
    r = client.post("/api/page/Paper/rename",
                    json={"new_title": "Papers Renamed"})
    assert r.status_code == 200, r.text
    assert ("uid_b5", "uid_b3") in _rows(seeded_config)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_block_ref_index.py -q`
Expected: `test_create_indexes_block_refs` and `test_update_text_replaces_block_refs` FAIL (no rows written). `test_delete_block_cascades_block_refs` may pass vacuously already — fine. (`test_rename_rewrite_preserves_block_refs` passes only once conftest seeds rows, Task 1.)

- [ ] **Step 3: Implement**

In `server/src/pkm/server/store.py`, after `index_ref` (~line 89):

```python
def reindex_block_refs(db: sqlite3.Connection, src_uid: str,
                       targets: Iterable[str]) -> None:
    """Replace one block's outgoing ((uid)) rows (pkm-d31f). Targets may
    dangle -- an unresolved ((uid)) is a legal state -- so no existence
    check. Never commits."""
    db.execute("DELETE FROM block_refs WHERE src_block_uid = ?", (src_uid,))
    db.executemany("INSERT OR IGNORE INTO block_refs VALUES (?,?)",
                   [(src_uid, t) for t in targets])
```

(`Iterable` is already imported in store.py or add `from collections.abc import Iterable`.)

In `server/src/pkm/server/ops_apply.py`, replace the `ReindexRefs` branch:

```python
    elif isinstance(eff, ReindexRefs):
        parsed = extract(eff.text)
        db.execute("DELETE FROM refs WHERE src_block_uid = ?", (eff.uid,))
        for ref in parsed.refs:
            index_ref(db, eff.uid, ref.title, ref.kind, now_ms)
        reindex_block_refs(db, eff.uid, parsed.block_refs)
```

(import `reindex_block_refs` alongside the existing `index_ref` import.)

In `server/src/pkm/server/store.py::rewrite_snapshotted_blocks`, the loop currently ends with:

```python
        db.execute("DELETE FROM refs WHERE src_block_uid = ?", (uid,))
        for ref in extract(new_text).refs:
            index_ref(db, uid, ref.title, ref.kind, now_ms)
```

change to parse once and reindex both:

```python
        parsed = extract(new_text)
        db.execute("DELETE FROM refs WHERE src_block_uid = ?", (uid,))
        for ref in parsed.refs:
            index_ref(db, uid, ref.title, ref.kind, now_ms)
        reindex_block_refs(db, uid, parsed.block_refs)
```

(A `[[title]]` rewrite can't change `((uid))`s, but the invariant worth having is "every path that rewrites text re-derives both indexes" — cheaper to keep than to reason about per-caller.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_block_ref_index.py tests/test_ops_apply.py tests/test_ops_endpoint.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/store.py server/src/pkm/server/ops_apply.py \
        server/tests/test_block_ref_index.py .beans
git commit -m "pkm-d31f: maintain block_refs at the server write choke points"
```

---

### Task 3: One-time server backfill at startup

**Files:**
- Modify: `server/src/pkm/server/db.py` (new `_backfill_block_refs`, called from `init_db` after `_backfill_created_at`)
- Test: `server/tests/test_schema_migrations.py`

**Interfaces:**
- Consumes: `pkm.refs.extract`; `sync_meta` table (SERVER_DDL, created by the same `executescript(DDL)`).
- Produces: after any `init_db()` run, `block_refs` reflects all existing block text; `sync_meta['block_refs_backfilled'] = '1'` guards re-runs. On failure init_db raises (server refuses to start).

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_schema_migrations.py` (reuse its existing imports/helpers where present):

```python
def test_block_refs_backfill_fills_historical_rows(tmp_path):
    from pkm.server.db import init_db, open_db
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)
    con = open_db(db_path)
    con.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed) VALUES ('uid_src01', 1, NULL, 0,"
        " 'see ((uid_tgt01))', NULL, 0)")
    # simulate a pre-pkm-d31f database: rows exist but no index, no marker
    con.execute("DELETE FROM sync_meta WHERE key = 'block_refs_backfilled'")
    con.commit()
    con.close()

    init_db(db_path)  # idempotent second run performs the catch-up
    con = open_db(db_path)
    rows = set(con.execute(
        "SELECT src_block_uid, target_block_uid FROM block_refs"))
    marker = con.execute(
        "SELECT value FROM sync_meta WHERE key = 'block_refs_backfilled'"
    ).fetchone()[0]
    con.close()
    assert rows == {("uid_src01", "uid_tgt01")}
    assert marker == "1"


def test_block_refs_backfill_is_guarded(tmp_path):
    from pkm.server.db import init_db, open_db
    db_path = tmp_path / "pkm.sqlite3"
    init_db(db_path)  # empty graph: marker set, table legitimately empty
    con = open_db(db_path)
    con.execute("INSERT INTO pages VALUES (1, 'P', NULL, NULL)")
    con.execute(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed) VALUES ('uid_src02', 1, NULL, 0,"
        " 'see ((uid_tgt02))', NULL, 0)")
    con.commit()
    con.close()

    init_db(db_path)  # marker present: must NOT re-scan
    con = open_db(db_path)
    rows = list(con.execute("SELECT * FROM block_refs"))
    con.close()
    assert rows == []  # write path owns post-marker rows, not startup
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_schema_migrations.py -q`
Expected: both new tests FAIL (no marker, no rows).

- [ ] **Step 3: Implement**

In `server/src/pkm/server/db.py`, add `from pkm.refs import extract` to the imports, then after `_backfill_created_at`:

```python
def _backfill_block_refs(con: sqlite3.Connection) -> None:
    """pkm-d31f: one-time historical catch-up. Blocks written before
    ops_apply maintained block_refs are indexed exactly once, guarded by a
    sync_meta marker rather than "table is empty" -- an empty table is a
    legitimate state for a graph with no ((refs)). Runs inside init_db's
    single commit: a failure aborts startup rather than leaving a
    half-filled index that silently undercounts. The write path owns all
    rows after the marker is set."""
    done = con.execute(
        "SELECT value FROM sync_meta WHERE key = 'block_refs_backfilled'"
    ).fetchone()
    if done is not None and done[0] == "1":
        return
    for uid, text in con.execute("SELECT uid, text FROM blocks"):
        targets = extract(text).block_refs
        if targets:
            con.executemany("INSERT OR IGNORE INTO block_refs VALUES (?,?)",
                            [(uid, t) for t in targets])
    con.execute(
        "INSERT INTO sync_meta(key, value) VALUES ('block_refs_backfilled','1')"
        " ON CONFLICT(key) DO UPDATE SET value = '1'")
```

Call it in `init_db` after `_backfill_created_at(con)`:

```python
        _backfill_created_at(con)
        _backfill_block_refs(con)
```

Extend `init_db`'s docstring with one line: `_backfill_block_refs()` catches up the `((uid))` index once (pkm-d31f), guarded by a sync_meta marker.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_schema_migrations.py tests/test_schema.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/db.py server/tests/test_schema_migrations.py .beans
git commit -m "pkm-d31f: backfill block_refs once at server startup"
```

---

### Task 4: Importer populates `block_refs`

**Files:**
- Modify: `server/src/pkm/importer/rows.py` (the `Rows` dataclass ~line 36 and the flatten loop ~line 143)
- Modify: `server/src/pkm/importer/run.py` (~line 125, next to the refs INSERT)
- Test: `server/tests/test_rows.py`

**Interfaces:**
- Consumes: `extract(b.text).block_refs` — the flatten loop already binds `parsed` per block (see `parsed.refs` / `parsed.block_refs` at rows.py:143–145).
- Produces: `Rows.block_refs: list[tuple]` of `(src_uid, target_uid)` pairs, inserted by the importer with `INSERT OR IGNORE`.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/test_rows.py`, following its existing Export-building helpers (read the top of the file and reuse its fixture/builder for pages+blocks — do not invent a new one):

```python
def test_rows_collects_block_refs():
    # a block whose text embeds ((uid_target)) twice yields ONE pair
    export = _export_with_block_text("see ((uid_target)) and ((uid_target))")
    rows = flatten(export)  # match the module's actual entry point name
    src_uid = export_first_block_uid(export)
    assert rows.block_refs == [(src_uid, "uid_target")]
```

Adapt `_export_with_block_text` / `export_first_block_uid` / `flatten` to the file's real helper and entry-point names — the assertion (one deduped `(src, target)` pair on `rows.block_refs`) is the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_rows.py -q`
Expected: FAIL — `Rows` has no `block_refs` field.

- [ ] **Step 3: Implement**

In `rows.py`: add `block_refs: list[tuple]` to the `Rows` dataclass; in the flatten loop where `parsed` is in hand (next to `counts["block_ref"] += len(parsed.block_refs)`), append deduped pairs:

```python
        for target in dict.fromkeys(parsed.block_refs):
            block_refs.append((b.uid, target))
```

with `block_refs: list[tuple] = []` initialised beside `refs` and passed to the `Rows(...)` constructor.

In `run.py`, next to the refs insert (~line 125):

```python
        con.executemany("INSERT OR IGNORE INTO block_refs VALUES (?,?)",
                        rows.block_refs)
```

(The importer's fresh DB later passes through `init_db`; the marker isn't set by the importer, so startup runs one redundant-but-idempotent catch-up pass. That's fine — INSERT OR IGNORE.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_rows.py tests/test_importer_e2e.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/importer/rows.py server/src/pkm/importer/run.py \
        server/tests/test_rows.py .beans
git commit -m "pkm-d31f: importer populates block_refs"
```

---

### Task 5: `block_ref_counts` in the page and journal payloads

**Files:**
- Modify: `server/src/pkm/contracts/responses.py` (`PagePayload` ~line 70, `JournalPayload` ~line 115)
- Modify: `server/src/pkm/server/routes_pages.py` (`get_page` ~line 174, `get_journal` ~line 381, new `_block_ref_counts` helper near `_block_ref_texts` ~line 53)
- Regenerate: `web/src/api/openapi.json` + `web/src/api/types.d.ts`
- Test: `server/tests/test_block_ref_index.py`

**Interfaces:**
- Consumes: `block_refs` table; `_UID_RE`-clean uids from the payload's own block rows.
- Produces: `PagePayload.block_ref_counts: dict[str, int]` and `JournalPayload.block_ref_counts: dict[str, int]` (payload-level, one map covering all days), only uids with n ≥ 1. Helper `_block_ref_counts(db, uids: list[str]) -> dict[str, int]`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_block_ref_index.py`:

```python
def test_page_payload_carries_block_ref_counts(client):
    # seed: uid_b5 (July 7th daily) references uid_b3 (Machine Learning)
    r = client.get("/api/page/Machine%20Learning")
    assert r.status_code == 200
    assert r.json()["block_ref_counts"] == {"uid_b3": 1}


def test_page_payload_counts_are_omitted_at_zero(client):
    r = client.get("/api/page/AI")
    assert r.status_code == 200
    assert r.json()["block_ref_counts"] == {}


def test_journal_payload_carries_block_ref_counts(client):
    # make the daily's own block a ((target)) so the count rides the
    # journal payload: uid_b5 lives on "July 7th, 2026"
    _post_ops(client, [{
        "op": "create", "uid": "uid_jref1", "page_title": "AI",
        "parent_uid": None, "order_idx": 9, "text": "note ((uid_b5))",
    }], "b-j1")
    r = client.get("/api/journal?before=2026-07-08&days=3")
    assert r.status_code == 200
    payload = r.json()
    assert any(d["title"] == "July 7th, 2026" for d in payload["days"])
    assert payload["block_ref_counts"] == {"uid_b5": 1}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_block_ref_index.py -q`
Expected: the three new tests FAIL with `KeyError: 'block_ref_counts'`.

- [ ] **Step 3: Implement**

`contracts/responses.py`: add `block_ref_counts: dict[str, int]` to `PagePayload` and `JournalPayload` (same position pattern as `block_ref_texts`).

`routes_pages.py`, after `_block_ref_texts` (~line 54):

```python
def _block_ref_counts(db: sqlite3.Connection,
                      uids: list[str]) -> dict[str, int]:
    """Incoming ((ref)) count per uid, nonzero entries only (pkm-d31f).
    One GROUP BY against idx_block_refs_target; src rows CASCADE with their
    block, so every counted row has a live source."""
    if not uids:
        return {}
    marks = ",".join("?" * len(uids))
    return {r["target_block_uid"]: r["n"] for r in db.execute(
        f"""SELECT target_block_uid, count(*) AS n FROM block_refs
             WHERE target_block_uid IN ({marks})
             GROUP BY target_block_uid""", uids)}
```

`get_page`: add to the returned dict:

```python
        "block_ref_counts": _block_ref_counts(
            db, [r["uid"] for r in blocks]),
```

`get_journal`: collect uids alongside texts (`uids.extend(r["uid"] for r in blocks)` in the day loop, `uids: list[str] = []` initialised beside `texts`), and add to the return:

```python
    return {"days": out, "block_ref_texts": _block_ref_texts(db, texts),
            "block_ref_counts": _block_ref_counts(db, uids)}
```

- [ ] **Step 4: Regenerate OpenAPI artifacts**

Run: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types`

- [ ] **Step 5: Run the server suite and web typecheck**

Run: `cd server && uv run pytest -q` — expected: the new tests PASS; `test_shim_parity_fixture` now FAILS (fixture is stale — that is Task 7's job; if it fails, note it and continue) and any payload-shape parity in `test_openapi_sync` passes because of Step 4.
Run: `cd web && pnpm typecheck` — expected: PASS (field is additive; the shim's `pagePayload` return type now misses a required field — if typecheck fails on `localApi/pages.ts`/`journal.ts`, that's Task 7; record and continue only if the failure is exactly that missing field, otherwise fix here).

**Note:** if `test_shim_parity_fixture` or web typecheck fail for the reasons above, Tasks 5–7 land as one PASSING unit only at the end of Task 7. Do not "fix" by regenerating the parity fixture here — the shim must learn the field first. Prefer committing Tasks 5–7 together if the intermediate state is red; otherwise commit per task.

- [ ] **Step 6: Commit (or hold until Task 7 if the tree is red — see note)**

```bash
git add server/src/pkm/contracts/responses.py server/src/pkm/server/routes_pages.py \
        web/src/api/openapi.json web/src/api/types.d.ts \
        server/tests/test_block_ref_index.py .beans
git commit -m "pkm-d31f: page and journal payloads carry block_ref_counts"
```

---

### Task 6: `GET /api/block/{uid}/backlinks`

**Files:**
- Modify: `server/src/pkm/contracts/responses.py` (new `BlockBacklinksPayload` after `Backlinks` ~line 58)
- Modify: `server/src/pkm/server/routes_pages.py` (new route next to `get_block_refs` ~line 130)
- Regenerate: `web/src/api/openapi.json` + `web/src/api/types.d.ts`
- Test: `server/tests/test_block_ref_index.py`

**Interfaces:**
- Consumes: `group_backlinks(rows, ancestors)` (`backlinks.py`), `_fetch_ancestors(db, uids)` (routes_pages.py), `_UID_RE`.
- Produces: `GET /api/block/{uid}/backlinks` → `{"groups": [BacklinkGroup...]}` — same group shape as page backlinks (`page_id`, `page_title`, `items[{uid,text,breadcrumbs}]`), ordered by source page `updated_at DESC NULLS LAST, title, uid`. 422 malformed uid (`f"malformed uid: {uid!r}"`), 404 unknown block (`"block not found"`), empty groups legal. No pagination.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_block_ref_index.py`:

```python
def test_block_backlinks_groups(client):
    r = client.get("/api/block/uid_b3/backlinks")
    assert r.status_code == 200
    groups = r.json()["groups"]
    assert [g["page_title"] for g in groups] == ["July 7th, 2026"]
    assert [i["uid"] for i in groups[0]["items"]] == ["uid_b5"]
    assert groups[0]["items"][0]["text"] == "See ((uid_b3)) for details"
    assert groups[0]["items"][0]["breadcrumbs"] == []


def test_block_backlinks_empty_for_unreferenced_block(client):
    r = client.get("/api/block/uid_b1/backlinks")
    assert r.status_code == 200
    assert r.json() == {"groups": []}


def test_block_backlinks_unknown_uid_404s(client):
    assert client.get("/api/block/uid_nope99/backlinks").status_code == 404


def test_block_backlinks_malformed_uid_422s(client):
    assert client.get("/api/block/x!/backlinks").status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && uv run pytest tests/test_block_ref_index.py -q`
Expected: new tests FAIL with 404 (route doesn't exist; note FastAPI may match `/api/block/{uid}` patterns — expect failures, exact codes may vary before the route exists).

- [ ] **Step 3: Implement**

`contracts/responses.py`, after `Backlinks`:

```python
class BlockBacklinksPayload(BaseModel):
    """GET /api/block/{uid}/backlinks: every block referencing ((uid)),
    grouped like page backlinks. Unpaginated by design -- counts are small
    and nothing user-visible truncates silently (pkm-d31f)."""
    groups: list[BacklinkGroup]
```

`routes_pages.py`, next to `get_block_refs` (import `BlockBacklinksPayload` at the top):

```python
@router.get("/api/block/{uid}/backlinks", response_model=BlockBacklinksPayload)
def get_block_backlinks(uid: str,
                        db: sqlite3.Connection = Depends(get_db)) -> dict:
    """The ((uid)) badge's popover read (pkm-d31f): who references this
    block. Same group shape and ordering as page backlinks; the count badge
    itself rides the page/journal payloads (block_ref_counts)."""
    if not _UID_RE.fullmatch(uid):
        raise HTTPException(status_code=422, detail=f"malformed uid: {uid!r}")
    if db.execute("SELECT 1 FROM blocks WHERE uid = ?",
                  (uid,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="block not found")
    rows = db.execute(
        """SELECT b.uid, b.text, p.id AS src_page_id, p.title AS src_page_title
             FROM block_refs r
             JOIN blocks b ON b.uid = r.src_block_uid
             JOIN pages p ON p.id = b.page_id
            WHERE r.target_block_uid = ?
            ORDER BY p.updated_at DESC NULLS LAST, p.title, b.uid""",
        (uid,)).fetchall()
    ancestors = _fetch_ancestors(db, [r["uid"] for r in rows])
    return {"groups": group_backlinks(rows, ancestors)}
```

Route ordering: FastAPI matches `/api/block/{uid}/backlinks` before the greedy `/api/page/{title:path}` only by specificity of the registered order — register this route **above** `get_block` if both share a prefix conflict; verify with the 200 test.

- [ ] **Step 4: Regenerate OpenAPI artifacts**

Run: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && uv run pytest tests/test_block_ref_index.py tests/test_block_endpoint.py tests/test_openapi_sync.py -q`
Expected: PASS (parity fixture still pending Task 7).

- [ ] **Step 6: Commit (or hold with Task 5's note)**

```bash
git add server/src/pkm/contracts/responses.py server/src/pkm/server/routes_pages.py \
        web/src/api/openapi.json web/src/api/types.d.ts \
        server/tests/test_block_ref_index.py .beans
git commit -m "pkm-d31f: GET /api/block/{uid}/backlinks for the popover"
```

---

### Task 7: Replica — write-path maintenance, shim reads, parity fixture

**Files:**
- Modify: `web/src/replica/localOps.ts` (`reindexRefs`, ~line 63)
- Modify: `web/src/replica/apply.ts` (`upsertBlock` ~line 35, `applySnapshot` wipe ~line 59)
- Modify: `web/src/replica/localApi/tree.ts` (new `blockRefCounts` next to `blockRefTexts`)
- Modify: `web/src/replica/localApi/pages.ts` (`pagePayload`, plus new `blockBacklinks` + extracted `groupBacklinkRows`)
- Modify: `web/src/replica/localApi/journal.ts` (`journalPayload` return)
- Modify: `web/src/replica/localApi/router.ts` (new route match)
- Modify: `web/src/api/payloads.ts` (export `BlockBacklinksPayload`)
- Modify: `server/src/pkm/server/shim_parity_dump.py` (SEED + CASES)
- Modify: `web/src/replica/localApi/parity.test.ts` (Fixture interface + seed loop)
- Regenerate: `shared/fixtures/shim_parity.json`
- Test: `web/src/replica/localOps.test.ts`, `web/src/replica/apply.test.ts`, `web/src/replica/localApi/router.test.ts`

**Interfaces:**
- Consumes: `extractRefs(text).blockRefs: string[]` (`replica/refs.ts`); `block_refs` table (in the replica via regenerated BASE_SCHEMA, Task 1); server payload shapes from Tasks 5–6.
- Produces: `blockRefCounts(db: ReplicaDb, uids: string[]): Record<string, number>` in `tree.ts`; `blockBacklinks(db: ReplicaDb, uid: string): BlockBacklinksPayload | null` in `pages.ts` (null = block not found); router handles `GET /api/block/{uid}/backlinks`; regenerated `shim_parity.json` with `seed.block_refs` and a `block_backlinks` case.

- [ ] **Step 1: Write the failing unit tests**

In `web/src/replica/localOps.test.ts` (follow its existing openTestDb/apply setup style):

```ts
test("create and update_text maintain block_refs", () => {
  applyLocalOps(t.db, [{ op: "create", uid: "uid_src1", page_title: "P",
    parent_uid: null, order_idx: 0,
    text: "see ((uid_tgt1)) and ((uid_tgt1))" }], NOW);
  expect(t.db.select("SELECT * FROM block_refs")).toEqual([
    { src_block_uid: "uid_src1", target_block_uid: "uid_tgt1" }]);
  applyLocalOps(t.db, [{ op: "update_text", uid: "uid_src1",
    text: "now ((uid_tgt2))" }], NOW);
  expect(t.db.select("SELECT * FROM block_refs")).toEqual([
    { src_block_uid: "uid_src1", target_block_uid: "uid_tgt2" }]);
});

test("delete cascades block_refs with the block", () => {
  applyLocalOps(t.db, [{ op: "create", uid: "uid_src2", page_title: "P",
    parent_uid: null, order_idx: 0, text: "see ((uid_tgt1))" }], NOW);
  applyLocalOps(t.db, [{ op: "delete", uid: "uid_src2" }], NOW);
  expect(t.db.select(
    "SELECT * FROM block_refs WHERE src_block_uid = 'uid_src2'")).toEqual([]);
});
```

In `web/src/replica/apply.test.ts`:

```ts
test("upsertBlock derives block_refs from synced text", () => {
  // build a minimal SyncBlock via the file's existing helpers, with
  // text: "cites ((uid_tgtA))" — then:
  expect(t.db.select("SELECT * FROM block_refs")).toEqual([
    { src_block_uid: SYNCED_UID, target_block_uid: "uid_tgtA" }]);
});

test("applySnapshot wipes block_refs before rebuilding", () => {
  // pre-insert a stale row, apply a snapshot containing no block refs,
  // assert SELECT * FROM block_refs is empty.
});
```

(Flesh these out with the helper builders already in `apply.test.ts` — it has snapshot/changes constructors; keep the assertions as written.)

In `web/src/replica/localApi/router.test.ts`:

```ts
test("block backlinks route: shape, 404, 422", () => {
  // seed (reuse the file's seeding pattern): page 1 "Target" with block
  // uid_t1 "the target"; page 2 "Source" with block uid_s1 "see ((uid_t1))"
  const hit = handleLocalApi(t.db, { method: "GET",
    path: "/api/block/uid_t1/backlinks", nowMs: NOW });
  expect(hit).toEqual({ handled: true, status: 200, body: { groups: [{
    page_id: 2, page_title: "Source",
    items: [{ uid: "uid_s1", text: "see ((uid_t1))", breadcrumbs: [] }],
  }] } });
  expect(handleLocalApi(t.db, { method: "GET",
    path: "/api/block/uid_nope99/backlinks", nowMs: NOW }))
    .toEqual({ handled: true, status: 404, body: { detail: "block not found" } });
  expect(handleLocalApi(t.db, { method: "GET",
    path: "/api/block/x!/backlinks", nowMs: NOW }).handled).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test:unit -- replica`
Expected: new tests FAIL.

- [ ] **Step 3: Implement the write paths**

`localOps.ts::reindexRefs` — extend to both indexes (one `extractRefs` call):

```ts
const reindexRefs = (db: ReplicaDb, uid: string, text: string,
                     nowMs: number): void => {
  const { refs, blockRefs } = extractRefs(text);
  db.exec("DELETE FROM refs WHERE src_block_uid = ?", [uid]);
  for (const ref of refs) {
    const pageId = getOrCreateLocalPage(db, ref.title, nowMs);
    db.exec("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
            [uid, pageId, ref.kind]);
  }
  // pkm-d31f: the block-level index. Mirrors the server's ReindexRefs
  // effect; targets may dangle (unresolved ((uid)) is legal).
  db.exec("DELETE FROM block_refs WHERE src_block_uid = ?", [uid]);
  for (const target of blockRefs) {
    db.exec("INSERT OR IGNORE INTO block_refs VALUES (?,?)", [uid, target]);
  }
};
```

`apply.ts::upsertBlock` — after the refs replacement, derive locally (import `extractRefs` from `./refs`):

```ts
  // block_refs are never shipped over sync: targets are uids (no id
  // resolution, unlike refs' dependency pages) and the extractor is
  // parity-pinned, so local derivation matches the server (pkm-d31f).
  db.exec("DELETE FROM block_refs WHERE src_block_uid = ?", [b.uid]);
  for (const target of extractRefs(b.text).blockRefs) {
    db.exec("INSERT OR IGNORE INTO block_refs VALUES (?,?)", [b.uid, target]);
  }
```

`apply.ts::applySnapshot` — add to the wipe, before `DELETE FROM blocks`:

```ts
    db.exec("DELETE FROM block_refs");
```

(Tombstoned blocks clean their rows via `ON DELETE CASCADE` — the worker connection runs `PRAGMA foreign_keys=ON`, `worker.ts:36`, as does `testDb.ts`. `reconcile.ts` needs no change: block_refs holds uids only, no negative page ids to remap.)

- [ ] **Step 4: Implement the shim reads**

`localApi/tree.ts`, next to `blockRefTexts`:

```ts
export function blockRefCounts(db: ReplicaDb,
                               uids: string[]): Record<string, number> {
  if (uids.length === 0) return {};
  const marks = uids.map(() => "?").join(",");
  const out: Record<string, number> = {};
  for (const r of db.select<{ target_block_uid: string; n: number }>(
    `SELECT target_block_uid, count(*) AS n FROM block_refs
      WHERE target_block_uid IN (${marks})
      GROUP BY target_block_uid`, uids)) {
    out[r.target_block_uid] = Number(r.n);
  }
  return out;
}
```

`localApi/pages.ts`:
- Extract the group-building loop shared by `backlinks()` (lines ~86–98) into a local helper and reuse it:

```ts
function groupBacklinkRows(rows: BacklinkRow[],
                           ancestors: Map<string, string[]>): BacklinkGroup[] {
  const groups: BacklinkGroup[] = [];
  const index = new Map<number, BacklinkGroup>();
  for (const r of rows) {
    let group = index.get(r.src_page_id);
    if (!group) {
      group = { page_id: r.src_page_id, page_title: r.src_page_title,
                items: [] };
      index.set(r.src_page_id, group);
      groups.push(group);
    }
    group.items.push({ uid: r.uid, text: r.text,
                       breadcrumbs: ancestors.get(r.uid) ?? [] });
  }
  return groups;
}
```

- `pagePayload` return gains:

```ts
    block_ref_counts: blockRefCounts(db, blocks.map((r) => r.uid)),
```

- New export (import `BlockBacklinksPayload` from `../../api/payloads`):

```ts
/** null = block not found: the router 404s. */
export function blockBacklinks(db: ReplicaDb,
                               uid: string): BlockBacklinksPayload | null {
  const exists = db.select<{ one: number }>(
    "SELECT 1 AS one FROM blocks WHERE uid = ?", [uid]);
  if (exists.length === 0) return null;
  const rows = db.select<BacklinkRow>(
    `SELECT b.uid, b.text, p.id AS src_page_id, p.title AS src_page_title
       FROM block_refs r
       JOIN blocks b ON b.uid = r.src_block_uid
       JOIN pages p ON p.id = b.page_id
      WHERE r.target_block_uid = ?
      ORDER BY p.updated_at DESC NULLS LAST, p.title, b.uid`, [uid]);
  return { groups: groupBacklinkRows(rows, fetchAncestors(db, rows.map((r) => r.uid))) };
}
```

`localApi/journal.ts` — collect uids beside texts in the day loop, return gains `block_ref_counts: blockRefCounts(db, uids)` (import from `./tree`).

`localApi/router.ts` — before the `NOT_HANDLED` fallthrough:

```ts
  const blockBacklinksMatch = /^\/api\/block\/([^/]+)\/backlinks$/.exec(path);
  if (method === "GET" && blockBacklinksMatch) {
    const uid = decodeURIComponent(blockBacklinksMatch[1]);
    if (!UID_RE.test(uid)) return err(422, `malformed uid: '${uid}'`);
    const body = blockBacklinks(db, uid);
    return body === null ? err(404, "block not found") : ok(body);
  }
```

(import `blockBacklinks` from `./pages`.)

`web/src/api/payloads.ts` — add, following the file's existing alias pattern:

```ts
export type BlockBacklinksPayload = components["schemas"]["BlockBacklinksPayload"];
```

- [ ] **Step 5: Update the parity fixture — seed, case, replay**

`server/src/pkm/server/shim_parity_dump.py`:
- SEED gains (uid_b6 = `"See ((uid_b3)) for details"`, uid_b8 = `"Cites ((uid_b6)) which cites more"`):

```python
    "block_refs": [
        ["uid_b6", "uid_b3"],
        ["uid_b8", "uid_b6"],
    ],
```

- `fixture()` inserts them after the refs executemany:

```python
        con.executemany("INSERT INTO block_refs VALUES (?,?)",
                        SEED["block_refs"])
```

- CASES gains:

```python
    ("block_backlinks", "/api/block/uid_b3/backlinks"),
```

`web/src/replica/localApi/parity.test.ts`:
- `Fixture` interface gains `block_refs: [string, string][];`
- `beforeAll` seeds them:

```ts
  for (const br of fixture.seed.block_refs) {
    t.db.exec("INSERT INTO block_refs VALUES (?,?)", br);
  }
```

Regenerate: `cd server && uv run python -m pkm.server.shim_parity_dump > ../shared/fixtures/shim_parity.json`

- [ ] **Step 6: Run both suites**

Run: `cd server && uv run pytest -q` — expected: PASS, including `test_shim_parity_fixture`.
Run: `cd web && pnpm test:unit && pnpm typecheck` — expected: PASS, including `parity.test.ts` replaying the new `block_backlinks` case and the count-carrying page/journal cases.

- [ ] **Step 7: Commit**

```bash
git add web/src/replica web/src/api/payloads.ts \
        server/src/pkm/server/shim_parity_dump.py shared/fixtures/shim_parity.json .beans
git commit -m "pkm-d31f: replica derives block_refs; shim serves counts and block backlinks"
```

---

### Task 8: Badge in the outline (data plumbing + rendering)

**Files:**
- Modify: `web/src/components/EditableBlockTree.tsx` (TreeProps ~line 28, tree state ~line 71, row render ~line 337)
- Modify: `web/src/views/EditablePage.tsx` (props ~line 20, tree call ~line 86)
- Modify: `web/src/views/PageView.tsx` (~line 49)
- Modify: `web/src/views/Journal.tsx` (counts state beside the `block_ref_texts` merge ~line 125, EditablePage call ~line 219)
- Modify: `web/src/styles.css` (near `.block-stamp`, ~line 511)
- Test: `web/src/components/EditableBlockTree.test.tsx`, `web/src/styles.test.ts`

**Interfaces:**
- Consumes: `PagePayload.block_ref_counts` / `JournalPayload.block_ref_counts` (Tasks 5–7 types).
- Produces: `EditableBlockTree` prop `refCounts?: Record<string, number>`; `EditablePage` prop `refCounts?: Record<string, number>` (threaded through); tree-level state `refPopover: { uid: string; x: number; y: number } | null` plus `onOpenRefPopover(uid, x, y)` handed to rows (popover element itself is Task 9); CSS class `.block-ref-badge`. Badge shows for `count ≥ 1` regardless of `fallback`/`readOnly` (navigation is read-only-safe), and is **not** hidden in the phone media query.

- [ ] **Step 1: Write the failing tests**

In `web/src/components/EditableBlockTree.test.tsx` (reuse its existing render helpers/handler fakes):

```tsx
test("blocks with incoming refs show a count badge; others none", () => {
  render(<EditableBlockTree blocks={twoBlocks} focus={null}
           handlers={fakeHandlers} readOnly={false}
           refCounts={{ [twoBlocks[0].uid]: 3 }} />);
  const badge = screen.getByRole("button", { name: "3 references" });
  expect(badge).toHaveClass("block-ref-badge");
  expect(badge).toHaveTextContent("3");
  expect(screen.getAllByRole("button", { name: /references?$/ })).toHaveLength(1);
});

test("badge click does not focus the block", async () => {
  render(<EditableBlockTree blocks={twoBlocks} focus={null}
           handlers={fakeHandlers} readOnly={false}
           refCounts={{ [twoBlocks[0].uid]: 1 }} />);
  await userEvent.click(screen.getByRole("button", { name: "1 reference" }));
  expect(fakeHandlers.onFocusBlock).not.toHaveBeenCalled();
});
```

In `web/src/styles.test.ts` (using its `ruleFor`/`mediaRulesFor` helpers — mind the grouped-selector trap):

```ts
test("block-ref-badge is a muted pill and survives the phone media query", () => {
  const rule = ruleFor(".block-ref-badge");
  expect(rule.style.color).toBe("var(--color-text-muted)");
  expect(rule.style.background).toContain("var(--color-bg-subtle)");
  // unlike .block-stamp, the badge must NOT be display:none on phones —
  // it is the only route to the popover on touch
  const phoneRules = mediaRulesFor(".block-ref-badge");
  for (const r of phoneRules) expect(r.style.display).not.toBe("none");
});
```

(Adapt helper names to the file's actual API — the intent is fixed: badge styled from the two tokens, and no phone `display:none`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test:unit -- EditableBlockTree styles`
Expected: FAIL (`refCounts` prop unknown, class absent).

- [ ] **Step 3: Implement**

`EditableBlockTree.tsx`:
- `TreeProps` gains:

```ts
  /** Incoming ((uid)) reference counts (pkm-d31f). Payload-fresh, like
   * block_ref_texts: PageView and Journal pass it; sidebar panels stay bare. */
  refCounts?: Record<string, number>;
```

- Tree component: accept `refCounts = undefined`; add state (popover element arrives in Task 9):

```ts
  const [refPopover, setRefPopover] = useState<{
    uid: string; x: number; y: number;
  } | null>(null);
```

- Pass `refCounts` and `onOpenRefPopover={(uid, x, y) => setRefPopover({ uid, x, y })}` down through `EditableBlock` (both call sites — root map and children map), alongside `stamps`/`nowMs`.
- New row-level component next to `BlockStamp`:

```tsx
/** The gutter count of incoming ((uid)) refs (pkm-d31f). Sparse — rendered
 * only on rows that have any — so unlike BlockStamp it is not a column and
 * needs no empty placeholder; it borrows width from the flexible text cell
 * on exactly the rows where it appears. */
function RefCountBadge({ uid, count, onOpen }: {
  uid: string; count: number;
  onOpen: (uid: string, x: number, y: number) => void;
}) {
  const label = count === 1 ? "1 reference" : `${count} references`;
  return (
    <button className="block-ref-badge" title={label} aria-label={label}
            aria-haspopup="dialog"
            onClick={(e) => {
              // never bubble into the row's click-to-edit
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              onOpen(uid, rect.left, rect.bottom + 4);
            }}>
      {count}
    </button>
  );
}
```

- In `EditableBlock`'s row, between the text and the stamp cell (order `[text] [badge] [stamp]`):

```tsx
        {(refCounts?.[node.uid] ?? 0) > 0 && (
          <RefCountBadge uid={node.uid} count={refCounts![node.uid]}
                         onOpen={onOpenRefPopover} />
        )}
        {stamps && <BlockStamp node={node} nowMs={nowMs} />}
```

(`EditableBlock` props gain `refCounts?: Record<string, number>` and `onOpenRefPopover: (uid: string, x: number, y: number) => void`.)

`EditablePage.tsx`: prop `refCounts?: Record<string, number>` threaded to the tree (exactly like `stamps`).

`PageView.tsx` line ~49:

```tsx
        <EditablePage key={payload.page.title} title={payload.page.title}
                      initial={payload.blocks} composer stamps={stamps}
                      refCounts={payload.block_ref_counts} />
```

`Journal.tsx`: mirror the `block_ref_texts` merge (~line 125) with a `refCounts` state merged the same way from `p.block_ref_counts`, passed to each day's `EditablePage` (~line 219).

`styles.css`, after the `.block-stamp` rules (~line 519):

```css
/* pkm-d31f: incoming-reference count badge. Sparse per-row pill, not a
 * column (contrast .block-stamp above); sits just inside the stamp cell,
 * whose own margin-left supplies the separation. Deliberately low-ink so
 * a stamp's freshness tint stays the louder signal on rows with both.
 * NOT hidden in the phone media query: it is the only route to the
 * popover on touch. */
.block-ref-badge { flex: none; margin-left: 8px; padding: 0 6px;
  font-size: 11px; line-height: 18px; align-self: center;
  border: none; cursor: pointer; border-radius: var(--radius-control);
  color: var(--color-text-muted); background: var(--color-bg-subtle); }
.block-ref-badge:hover { border: none; color: var(--color-text); }
```

(Check how other in-flow buttons neutralise the global button base style in this stylesheet and follow that pattern; verify the focus ring appears when tabbing — the frontend.md § Focus invariants apply.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm test:unit && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/EditableBlockTree.tsx web/src/views/EditablePage.tsx \
        web/src/views/PageView.tsx web/src/views/Journal.tsx web/src/styles.css \
        web/src/components/EditableBlockTree.test.tsx web/src/styles.test.ts .beans
git commit -m "pkm-d31f: reference-count badge in the block gutter"
```

---### Task 9: The references popover

**Files:**
- Create: `web/src/components/BacklinkGroupList.tsx`
- Create: `web/src/components/BlockRefBacklinksPopover.tsx`
- Modify: `web/src/components/BacklinksSection.tsx` (replace its inline group markup, lines ~200–214)
- Modify: `web/src/components/EditableBlockTree.tsx` (render the popover from `refPopover` state)
- Modify: `web/src/styles.css` (popover styles)
- Test: `web/src/components/BlockRefBacklinksPopover.test.tsx` (new), `web/src/components/sections.test.tsx` (existing renders must stay green), `web/src/styles.test.ts`

**Interfaces:**
- Consumes: `apiGet("/api/block/{uid}/backlinks", { path: { uid } })` (typedClient, Task 6 types); `refPopover` state + setter from Task 8; `pagePath(title)` from `../paths`; `BacklinkGroup` from `../api/payloads`.
- Produces: `BacklinkGroupList({ groups, onNavigate? })` — the single renderer for backlink-group markup (`.backlink-group`, `.group-title`, `.backlink-item`, `.breadcrumbs`, `.backlink-text`), used by `BacklinksSection` and the popover; `BlockRefBacklinksPopover({ uid, x, y, onClose })` — fixed-position popover, Escape/outside-click dismiss, verbose inline error, entries navigate to `pagePath(pageTitle)#uid`.

- [ ] **Step 1: Extract the shared group renderer (no behavior change)**

Create `web/src/components/BacklinkGroupList.tsx`:

```tsx
// pattern: Imperative Shell
// The one renderer for backlink-group markup (pkm-d31f): BacklinksSection
// and the block-reference popover both render through here — same
// precedent as JournalDayReferences reusing BacklinksSection rather than
// growing a second renderer.
import type { BacklinkGroup } from "../api/payloads";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";

export function BacklinkGroupList({ groups, onNavigate }: {
  groups: BacklinkGroup[];
  /** When set, each item becomes a navigation target (the popover);
   * without it, items render inertly (the backlinks section, where
   * navigation lives on the inline links themselves). */
  onNavigate?: (pageTitle: string, uid: string) => void;
}) {
  return (
    <>
      {groups.map((g) => (
        <div className="backlink-group" key={g.page_id}>
          <h3 className="group-title"><PageLink title={g.page_title} tag={false} /></h3>
          {g.items.map((item) => (
            <div className={"backlink-item" + (onNavigate ? " navigable" : "")}
                 key={item.uid}
                 role={onNavigate ? "link" : undefined}
                 tabIndex={onNavigate ? 0 : undefined}
                 onClick={onNavigate ? (e) => {
                   // leave clicks on nested anchors/refs to their own handlers
                   if ((e.target as Element).closest("a, .block-ref")) return;
                   onNavigate(g.page_title, item.uid);
                 } : undefined}
                 onKeyDown={onNavigate ? (e) => {
                   if (e.key === "Enter" && e.target === e.currentTarget) {
                     e.preventDefault();
                     onNavigate(g.page_title, item.uid);
                   }
                 } : undefined}>
              {item.breadcrumbs.length > 0 && (
                <div className="breadcrumbs">{item.breadcrumbs.join(" › ")}</div>
              )}
              <div className="backlink-text">
                <InlineSegments segments={tokenizeBlock(item.text)} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
```

In `BacklinksSection.tsx`, replace lines ~200–214 (`{visible.map((g) => ...)}`) with:

```tsx
        <BacklinkGroupList groups={visible} />
```

(and drop the now-unused `InlineSegments`/`PageLink`/`tokenizeBlock` imports if nothing else in the file uses them).

Run: `cd web && pnpm test:unit -- sections` — expected: PASS unchanged (pure extraction).

- [ ] **Step 2: Write the failing popover tests**

Create `web/src/components/BlockRefBacklinksPopover.test.tsx`. Mock `apiGet` the way `sections.test.tsx` / `BacklinksSection` tests do (follow the file's existing `vi.mock("../api/typedClient", ...)` pattern), and wrap renders in a MemoryRouter (PageLink/useNavigate need it):

```tsx
test("fetches and renders referencing blocks", async () => {
  mockApiGet.mockResolvedValueOnce({ groups: [{
    page_id: 2, page_title: "Source Page",
    items: [{ uid: "uid_s1", text: "see ((uid_t1))", breadcrumbs: ["Parent"] }],
  }] });
  render(<BlockRefBacklinksPopover uid="uid_t1" x={10} y={20}
                                   onClose={vi.fn()} />, { wrapper });
  expect(await screen.findByText("Source Page")).toBeInTheDocument();
  expect(screen.getByText("Parent")).toBeInTheDocument();
  expect(mockApiGet).toHaveBeenCalledWith(
    "/api/block/{uid}/backlinks", { path: { uid: "uid_t1" } });
});

test("shows a verbose error when the fetch fails", async () => {
  mockApiGet.mockRejectedValueOnce(new Error("boom"));
  render(<BlockRefBacklinksPopover uid="uid_t1" x={0} y={0}
                                   onClose={vi.fn()} />, { wrapper });
  expect(await screen.findByText(/boom/)).toBeInTheDocument();
});

test("Escape closes", async () => {
  mockApiGet.mockResolvedValueOnce({ groups: [] });
  const onClose = vi.fn();
  render(<BlockRefBacklinksPopover uid="uid_t1" x={0} y={0}
                                   onClose={onClose} />, { wrapper });
  await screen.findByText(/no.*references/i);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalled();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && pnpm test:unit -- BlockRefBacklinksPopover`
Expected: FAIL (module doesn't exist).

- [ ] **Step 4: Implement the popover**

Create `web/src/components/BlockRefBacklinksPopover.tsx`:

```tsx
// pattern: Imperative Shell
// The badge's popover (pkm-d31f): who references this block. Fetches
// lazily on open (offline: the shim serves it identically); the badge
// count is payload-fresh, this list is live truth — no reconciliation.
// Dismissal mirrors BlockMenu: Escape or outside mousedown.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../api/typedClient";
import type { BacklinkGroup } from "../api/payloads";
import { pagePath } from "../paths";
import { BacklinkGroupList } from "./BacklinkGroupList";

export function BlockRefBacklinksPopover({ uid, x, y, onClose }: {
  uid: string; x: number; y: number; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  const [groups, setGroups] = useState<BacklinkGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    setError(null);
    apiGet("/api/block/{uid}/backlinks", { path: { uid } })
      .then((payload) => { if (!cancelled) setGroups(payload.groups); })
      .catch((fetchFailure: unknown) => {
        if (!cancelled) setError(String(fetchFailure));
      });
    return () => { cancelled = true; };
  }, [uid]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="block-ref-popover" role="dialog" aria-label="References"
         ref={ref} style={{ left: x, top: y }}>
      {error !== null && <p className="error">Could not load references: {error}</p>}
      {error === null && groups === null && <p className="loading">Loading…</p>}
      {groups !== null && groups.length === 0 && (
        <p className="loading">No references — the badge may be stale.</p>
      )}
      {groups !== null && groups.length > 0 && (
        <BacklinkGroupList groups={groups}
          onNavigate={(pageTitle, itemUid) => {
            onClose();
            // same-page hash navigation may not unmount the tree, so close
            // explicitly first; PageView scrolls + flashes the hash target.
            navigate(`${pagePath(pageTitle)}#${itemUid}`);
          }} />
      )}
    </div>
  );
}
```

Wire it in `EditableBlockTree.tsx`, next to the `BlockMenu` render (~line 158) — note it renders in `fallback` trees too (read-only navigation is fine):

```tsx
      {refPopover && (
        <BlockRefBacklinksPopover uid={refPopover.uid}
          x={refPopover.x} y={refPopover.y}
          onClose={() => setRefPopover(null)} />
      )}
```

`styles.css`, after the badge rules (align tokens/z-index with the existing `.block-menu` rules — read them first and reuse their shadow/border/z-index values):

```css
/* pkm-d31f: the badge's popover. Same layering and surface treatment as
 * .block-menu (styles.css ~line 855); capped height with its own scroll
 * (never the page's horizontal). */
.block-ref-popover { position: fixed; z-index: 60;
  min-width: 260px; max-width: min(480px, calc(100vw - 24px));
  max-height: 60vh; overflow-y: auto; padding: 8px 12px;
  background: var(--color-bg-surface); border: 1px solid var(--color-border-input);
  border-radius: var(--radius-panel);
  box-shadow: 0 4px 14px rgba(var(--shadow-rgb), 0.15); }
.backlink-item.navigable { cursor: pointer; border-radius: var(--radius-control); }
.backlink-item.navigable:hover { background: var(--color-bg-subtle); }
```

(These values are copied from `.block-menu` so the two popovers layer and shade identically — if `.block-menu` has changed by implementation time, match whatever it uses then.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && pnpm test:unit && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/BacklinkGroupList.tsx \
        web/src/components/BlockRefBacklinksPopover.tsx \
        web/src/components/BlockRefBacklinksPopover.test.tsx \
        web/src/components/BacklinksSection.tsx \
        web/src/components/EditableBlockTree.tsx web/src/styles.css \
        web/src/styles.test.ts .beans
git commit -m "pkm-d31f: references popover, sharing the backlink group renderer"
```

---

### Task 10: End-to-end spec

**Files:**
- Create: `web/e2e/block-ref-indicator.spec.ts`

**Interfaces:**
- Consumes: the shipped feature end to end; e2e conventions from `web/e2e/ref-open.spec.ts` (login/createPage helpers) and `assistant-asset-link.spec.ts` (ops seeding).

- [ ] **Step 1: Write the spec**

```ts
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// pkm-d31f: a referenced block shows an incoming-reference count badge in
// the right gutter; clicking it pops up the referencing locations, and an
// entry navigates to the referencing block (hash scroll + flash).

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

async function createPage(page: Page, title: string) {
  const response = await page.request.post("/api/pages", { data: { title } });
  expect(response.ok()).toBeTruthy();
}

test("badge shows the incoming count and its popover navigates", async ({ page }) => {
  const stamp = Date.now();
  const target = `RefBadgeTarget${stamp}`;
  const source = `RefBadgeSource${stamp}`;
  const targetUid = `e2ed31ftgt${stamp}`.slice(0, 32);
  const sourceUid = `e2ed31fsrc${stamp}`.slice(0, 32);
  await login(page);
  await createPage(page, target);
  await createPage(page, source);
  const ops = await page.request.post("/api/ops", { data: {
    client_id: "e2e-d31f",
    batch_id: `e2e-d31f-${stamp}`,
    ops: [
      { op: "create", uid: targetUid, page_title: target,
        parent_uid: null, order_idx: 0, text: "the referenced block" },
      { op: "create", uid: sourceUid, page_title: source,
        parent_uid: null, order_idx: 0, text: `see ((${targetUid})) here` },
    ],
  } });
  expect(ops.ok()).toBeTruthy();

  await page.goto(`/page/${encodeURIComponent(target)}`);
  const badge = page.locator(".block-ref-badge");
  await expect(badge).toHaveText("1");
  await expect(badge).toHaveAccessibleName("1 reference");

  await badge.click();
  const popover = page.getByRole("dialog", { name: "References" });
  await expect(popover.getByText(source)).toBeVisible();
  await expect(popover.getByText("the referenced block")).toBeVisible(); // the ((ref)) resolves inline

  await popover.locator(".backlink-item").click();
  await expect(page).toHaveURL(
    new RegExp(`/page/${encodeURIComponent(source)}#${sourceUid}$`));
  await expect(page.getByRole("dialog", { name: "References" })).toHaveCount(0);

  // Escape-dismiss on a fresh open
  await page.goto(`/page/${encodeURIComponent(target)}`);
  await page.locator(".block-ref-badge").click();
  await expect(page.getByRole("dialog", { name: "References" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "References" })).toHaveCount(0);
});
```

Notes for the implementer: uids must match `^[a-zA-Z0-9_-]{6,32}$`; never write to today's journal in e2e; build before running (`pnpm verify` handles it — for a single spec, `pnpm build` first if running playwright directly).

- [ ] **Step 2: Run the spec**

Run: `cd web && CI=true pnpm verify` (or the repo's single-spec invocation if one exists — check `web/package.json` scripts).
Expected: the new spec PASSES along with the whole suite. If the popover text assertion is flaky under load, prefer `await expect(...).toBeVisible()` waits over timeouts (see the e2e gotchas memory: `waitForServerText`-style helpers where applicable).

- [ ] **Step 3: Commit**

```bash
git add web/e2e/block-ref-indicator.spec.ts .beans
git commit -m "pkm-d31f: e2e spec for the reference badge and popover"
```

---

### Task 11: Architecture docs, bean completion, full verification

**Files:**
- Modify: `docs/architecture/backend.md` (API table; near the `/api/block-refs` and `/api/page/{title}` rows)
- Modify: `docs/architecture/frontend.md` (module map + a short badge/popover note near the outliner/BacklinksSection material)
- Modify: `docs/architecture/sync-and-offline.md` (derived-table note where refs/hydration is described, ~line 83)
- Modify: `docs/architecture/styling.md` (only if it enumerates control classes that should now include `.block-ref-badge` — check before editing)
- Modify: `.beans/…pkm-d31f…` (complete, with `## Summary of Changes`)

**Interfaces:** none — documentation of what shipped. Invoke the `architecture-docs` skill before editing these files; verify every claim against the code as merged, not this plan.

- [ ] **Step 1: Update the docs**

- `backend.md` API table adds:
  `| GET | /api/block/{uid}/backlinks | Blocks referencing ((uid)), grouped like page backlinks (unpaginated) |`
  and the `/api/page/{title}` + `/api/journal` rows' descriptions mention `block_ref_counts`. Grep the docs for enumerated counts that this change stales (e.g. route counts, "the N read routes" phrasing).
- `frontend.md`: module map gains `BacklinkGroupList`, `BlockRefBacklinksPopover`; one prose note where the outline/gutter is described: badge is sparse per-row (not a column like stamps), all-devices, popup fetch is live-at-open while the count is payload-fresh.
- `sync-and-offline.md`: one note where block+refs hydration is described (~line 83): `block_refs` is **derived client-side from block text** (applier + localOps), never shipped over sync — targets are uids, and the extractor is parity-pinned.
- `styling.md`: check whether its class inventories/invariants need `.block-ref-badge` / `.block-ref-popover`; add only what its structure already owns.

- [ ] **Step 2: Full verification gates**

Run, from the repo root:

```bash
cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check
cd ../web && CI=true pnpm verify
```

Expected: all PASS. Fix anything red before proceeding (superpowers:verification-before-completion).

- [ ] **Step 3: Complete the bean and commit**

Update the pkm-d31f bean: all checklist items checked, `-s completed`, and a `## Summary of Changes` describing: schema + write-path index, startup backfill, importer, counts in page/journal payloads, block-backlinks endpoint, replica derivation + shim parity, badge + popover UI, e2e, docs.

```bash
git add docs/architecture .beans
git commit -m "pkm-d31f: architecture docs for the reference indicator; close bean

docs: corrected nothing; added the new route, payload field, derived-table
note, and frontend module entries."
```

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch — merge to main with `git merge --no-ff`, run the gates once more on main, do not deploy (deploys are a separate, user-initiated action).

---

## Self-Review Notes (already applied)

- Spec coverage: data layer → Tasks 1–4; API & parity → Tasks 5–7; frontend → Tasks 8–9; error handling → Tasks 6 (status codes), 9 (verbose popover error, stale-badge empty state); testing → every task + Task 10 e2e; docs → Task 11.
- Type consistency: `reindex_block_refs` (py) / `blockRefCounts`, `blockBacklinks`, `groupBacklinkRows` (ts) / props `refCounts`, `onOpenRefPopover`, state `refPopover` — names match across tasks.
- Known intermediate redness: Tasks 5–7 form one green unit (shim parity + typecheck); the plan says to hold commits if red rather than regenerate the fixture early.
- Deliberate non-goals restated: no badge in sidebar panels or CLI/MCP reads; `_block_is_referenced` (journal cleanup's LIKE scan) is left untouched — switching it to the index changes code-fence semantics; a follow-up bean may consider it.
