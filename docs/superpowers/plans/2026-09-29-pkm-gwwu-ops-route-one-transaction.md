# The ops route owns one transaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /api/ops` (`server/src/pkm/server/routes_ops.py`) issues `BEGIN IMMEDIATE` before its batch_id dedupe read, so the read of a batch's context and the write of its effects can never straddle a concurrent `delete_page`/`rename_page`/`cleanup_journal` commit — the race that currently lets a page deletion land between the context read and the `UPDATE`, matching zero rows and silently swallowing the edited text under a stored `{"ok": true}` ack.

**Architecture:** No change to `ops_apply.py` or `ops_core.py` — the fix is entirely in `routes_ops.py`'s transaction boundary. `BEGIN IMMEDIATE` moves to the top of `post_ops`, before `rhash`/`replay_hash` are even computed. Every exit after that point ends the transaction: the replay branch and the 409 mismatched-hash branch roll back before returning/raising (they don't today), the `OpError` branch keeps its existing rollback, a lock the busy timeout could not take (`sqlite3.OperationalError` on the `BEGIN IMMEDIATE` itself) returns 503 with `Retry-After`, and the success path commits as now. The `except sqlite3.IntegrityError` branch on the `applied_batches` INSERT is deleted: with context and effects in one transaction, the concurrent same-batch_id insert it used to catch cannot happen — a racing request now blocks on `BEGIN IMMEDIATE` and, once unblocked, discovers the row via the ordinary dedupe SELECT.

**Tech Stack:** Python 3, FastAPI, stdlib `sqlite3` (no ORM), pytest.

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md` § F2 The ops route owns one transaction, § Shared rules, § Verification per branch. Background: `docs/2026-09-29-sync-subsystem-review-consolidated.md` § F2 (lines ~60-70 as of `2a95e4a8`; main is that commit plus docs-only merges).

## Global Constraints

- TDD: every new/rewritten race test goes red against the current (unfixed) code before the fix lands, and the delete-race test must reproduce the literal bug — an `{"ok": true}` ack whose text update matched zero rows — not just a downstream symptom.
- Every runtime file touched declares `# pattern: Functional Core` or `# pattern: Imperative Shell` near the top (or `Mixed` with a reason). `routes_ops.py` already declares `# pattern: Imperative Shell` — leave it, don't add one to test files (exempt).
- Code comments in files this fix touches state the rule the code enforces and carry **no bean id**. Bean ids (`pkm-gwwu`) are fine in commit messages and in `docs/troubleshooting.md`'s `Ref` column only.
- The branch includes: the D1 doc correction (`routes_ops.py` docstring, `backend.md` § The write path, `sync-and-offline.md`'s one-transaction line) and one new row in `docs/troubleshooting.md` (symptom, cause, owning section, bean id `pkm-gwwu`). Any edit under `docs/architecture/` is done under the `architecture-docs` skill.
- A route or docstring change regenerates `web/src/api/openapi.json` (`uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json` from `server/`) and the web types (`pnpm gen-types` from `web/`) before the branch is reviewed; `server/tests/test_openapi_sync.py` fails loudly if this is skipped.
- The two new "second connection" tests (concurrent delete, concurrent rename) are the spec's composed test across the routes_ops/routes_pages boundary — they are Task 1, not optional polish.
- Final verification, in order: `cd server && uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`; confirm the regen checklist ran (route/docstring changed) and `cd web && pnpm typecheck` passes; `perf/check.sh backend` (AGENTS.md rules for regression/unstable/stale/lost apply); then update the bean's checklist, add `## Summary of Changes` to the bean, mark it completed, and commit bean + code together.

## Review Focus

- A concurrent `delete_page`/`cleanup_journal` commit landing between the batch's context read and its `UPDATE` must no longer silently swallow the text under an `ok` ack (Astra's variant) — Task 1.
- A concurrent `rename_page` commit must not let a stale `_hint_page_exists` read cause `ReindexRefs`/`get_or_create_page` to resurrect the old title with a 200 (Fable's variant) — Task 1.
- A write lock the busy timeout cannot take must surface as `503` with `Retry-After`, not an uncaught `sqlite3.OperationalError` (a raw 500) — Task 2.
- The batch_id-insert race this bean's fix makes impossible must be proven impossible, not just deleted: the second connection blocks and the original batch's own effects still land — Task 3.
- `cleanup_journal` (`routes_pages.py:493`) calls the exact same `store.delete_page_rows` as `delete_page` (`routes_pages.py:266`) before its own `db.commit()` — Task 1's delete-race test, which drives `delete_page_rows` directly, already covers both routes' vulnerability; no separate test is needed, noted here so it isn't mistaken for a gap.

---

## Task 1: Composed-boundary race tests — concurrent delete and concurrent rename (red)

**Files:**
- Create: `server/tests/test_ops_concurrency.py`

**Interfaces:**
- Consumes: `pkm.server.ops_apply._context_for(db, op, now_ms) -> OpContext`, `pkm.server.ops_apply._hint_page_exists(db, page_title) -> bool` (monkeypatch targets, called as bare module globals from `ops_apply.apply_batch`/`_missing_target_context`); `pkm.server.store.fetch_page(db, title) -> sqlite3.Row | None`; `pkm.server.store.delete_page_rows(db, page_id, title) -> None`; `pkm.server.store.rename_page_rows(db, page_id, old_title, new_title, now_ms) -> None`; `pkm.server.db.open_db(path) -> sqlite3.Connection`; conftest's `client`/`seeded_config` fixtures (SEED_PAGES has page "AI" id 2 with sole block `uid_b6`; page "Machine Learning" id 1).
- Produces: nothing later tasks import; these tests just need to go from red to green across Task 4.

Both tests use the same technique as the existing `test_batch_id_insert_race_serves_winner_ack_and_rolls_back` in `test_ops_idempotency.py`: monkeypatch a function `ops_apply.apply_batch` calls internally, and inside the patched wrapper open a **second** connection via `open_db()` with a shortened `PRAGMA busy_timeout` (e.g. 50ms) and attempt the racing write there — deterministic, no threads.

- [ ] **Step 1: Write `test_concurrent_page_delete_cannot_land_inside_the_batch(client, seeded_config, monkeypatch)`**

```python
def test_concurrent_page_delete_cannot_land_inside_the_batch(
        client, seeded_config, monkeypatch):
    from pkm.server import ops_apply
    from pkm.server.db import open_db
    from pkm.server.store import delete_page_rows, fetch_page

    real_context_for = ops_apply._context_for

    def racing(db, op, now_ms):
        ctx = real_context_for(db, op, now_ms)  # sees uid_b6 still on "AI"
        con2 = open_db(seeded_config.db_path)
        con2.execute("PRAGMA busy_timeout=50")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            page = fetch_page(con2, "AI")
            delete_page_rows(con2, page["id"], "AI")
        con2.close()
        return ctx

    monkeypatch.setattr(ops_apply, "_context_for", racing)
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "gwwu-delete-race",
        "ops": [{"op": "update_text", "uid": "uid_b6",
                 "text": "typed during delete"}]})
    assert r.status_code == 200
    page = client.get("/api/page/AI").json()
    assert any(b["text"] == "typed during delete" for b in page["blocks"])
```

Add the needed `import sqlite3` and `import pytest` at module top.

- [ ] **Step 2: Run it against the current (unfixed) code and confirm it fails**

Run: `cd server && uv run pytest tests/test_ops_concurrency.py::test_concurrent_page_delete_cannot_land_inside_the_batch -v`
Expected: FAIL — the `pytest.raises(sqlite3.OperationalError)` block does not raise (nothing holds the write lock yet under the current code, so the racing delete commits cleanly), demonstrating the swallow: today's code would then also fail the final assertion, since page "AI" and `uid_b6` are gone and the text landed nowhere.

- [ ] **Step 3: Write `test_concurrent_rename_cannot_resurrect_the_old_title(client, seeded_config, monkeypatch)`**

```python
def test_concurrent_rename_cannot_resurrect_the_old_title(
        client, seeded_config, monkeypatch):
    from pkm.server import ops_apply
    from pkm.server.db import open_db
    from pkm.server.store import fetch_page, rename_page_rows

    real_hint_page_exists = ops_apply._hint_page_exists

    def racing(db, page_title):
        exists = real_hint_page_exists(db, page_title)  # True: not renamed yet
        con2 = open_db(seeded_config.db_path)
        con2.execute("PRAGMA busy_timeout=50")
        page = fetch_page(con2, "Machine Learning")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            rename_page_rows(con2, page["id"], "Machine Learning",
                             "ML Renamed", 1_800_000_000_000)
        con2.close()
        return exists

    monkeypatch.setattr(ops_apply, "_hint_page_exists", racing)
    r = client.post("/api/ops", json={
        "client_id": "c1", "batch_id": "gwwu-rename-race",
        "ops": [{"op": "update_text", "uid": "uid_zz_renamed",
                 "text": "typed during rename",
                 "page_title": "Machine Learning"}]})
    assert r.status_code == 200
    con = open_db(seeded_config.db_path)
    row = con.execute(
        "SELECT 1 FROM pages WHERE title = 'Machine Learning'").fetchone()
    con.close()
    assert row is not None  # the race never landed: nothing to resurrect
```

`uid_zz_renamed` names no block (matches the existing sequential test in
`test_ops_endpoint.py`'s naming convention) — the op is an orphan edit from
the start, which is what puts `_hint_page_exists` on the path.

- [ ] **Step 4: Run it against the current (unfixed) code and confirm it fails**

Run: `cd server && uv run pytest tests/test_ops_concurrency.py::test_concurrent_rename_cannot_resurrect_the_old_title -v`
Expected: FAIL — the `pytest.raises` block does not raise (the racing rename commits with no lock in its way), demonstrating the resurrection is possible today.

- [ ] **Step 5: Commit**

```bash
git add server/tests/test_ops_concurrency.py
git commit -m "test(pkm-gwwu): red — a concurrent delete/rename can land inside post_ops's read/write window"
```

## Task 2: Lock-contention test — 503 with Retry-After (red)

**Files:**
- Modify: `server/tests/test_ops_concurrency.py`

**Interfaces:**
- Consumes: `pkm.server.db.BUSY_TIMEOUT_MS` (module attribute, monkeypatchable — `open_db()` reads it at call time via `f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}"`), `pkm.server.db.open_db`.

- [ ] **Step 1: Write `test_lock_contention_on_begin_immediate_returns_503(client, seeded_config, monkeypatch)`**

```python
def test_lock_contention_on_begin_immediate_returns_503(
        client, seeded_config, monkeypatch):
    from pkm.server import db as db_module

    monkeypatch.setattr(db_module, "BUSY_TIMEOUT_MS", 50)
    blocker = db_module.open_db(seeded_config.db_path)
    blocker.execute("BEGIN IMMEDIATE")  # takes the write lock and holds it
    try:
        r = client.post("/api/ops", json={
            "client_id": "c1", "batch_id": "gwwu-503-race",
            "ops": [{"op": "update_text", "uid": "uid_b1", "text": "x"}]})
        assert r.status_code == 503
        assert r.headers["retry-after"] == "1"
    finally:
        blocker.commit()
        blocker.close()
```

- [ ] **Step 2: Run it against the current (unfixed) code and confirm it fails**

Run: `cd server && uv run pytest tests/test_ops_concurrency.py::test_lock_contention_on_begin_immediate_returns_503 -v`
Expected: FAIL — current `post_ops` issues no `BEGIN IMMEDIATE` and has no code path that returns 503; the request either 500s with an uncaught `OperationalError` or succeeds outright (depending on where the first write lands), not 503.

- [ ] **Step 3: Commit**

```bash
git add server/tests/test_ops_concurrency.py
git commit -m "test(pkm-gwwu): red — a lock the busy timeout can't take should 503, not 500"
```

## Task 3: Rewrite `test_ops_idempotency.py`'s injected-commit test (red)

**Files:**
- Modify: `server/tests/test_ops_idempotency.py:67-100` (`test_batch_id_insert_race_serves_winner_ack_and_rolls_back`)

**Interfaces:**
- Consumes: `pkm.server.routes_ops.apply_batch` (monkeypatch target — same as today), `pkm.server.db.open_db`, `pkm.server.ops_core.batch_request_hash`.

- [ ] **Step 1: Replace the test with `test_batch_id_insert_race_blocks_on_the_batchs_transaction(client, monkeypatch)`**

Same shape as the existing test (open a second connection inside a monkeypatched `routes_ops.apply_batch`, before calling through to the real one), but the second connection now uses a short busy timeout and is expected to **block**, not win:

```python
def test_batch_id_insert_race_blocks_on_the_batchs_transaction(client,
                                                               monkeypatch):
    """pkm-gwwu: BEGIN IMMEDIATE now covers the dedupe SELECT through the
    commit, so a second connection trying to insert the same batch_id can
    no longer land inside that window -- it blocks on the write lock the
    batch already holds, and the batch's own effects are unaffected."""
    import json
    import sqlite3

    import pytest

    from pkm.server import routes_ops
    from pkm.server.db import open_db
    from pkm.server.ops_core import batch_request_hash

    real = routes_ops.apply_batch

    def racing(db, batch, now):
        con = open_db(client.app.state.config.db_path)
        con.execute("PRAGMA busy_timeout=50")
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            con.execute(
                "INSERT INTO applied_batches VALUES (?,?,?,?)",
                (batch.batch_id, batch_request_hash(batch),
                 json.dumps({"ok": True, "ts": 1, "applied": 99}), 1))
        con.close()
        return real(db, batch, now)

    monkeypatch.setattr(routes_ops, "apply_batch", racing)
    r = client.post("/api/ops", json=BATCH)
    assert r.status_code == 200
    assert r.json()["applied"] == len(BATCH["ops"])  # its own ack, not a fake
    monkeypatch.setattr(routes_ops, "apply_batch", real)
    page = client.get("/api/page/AI").json()
    assert "uid_idem1" in {b["uid"] for b in page["blocks"]}  # unaffected
```

- [ ] **Step 2: Run it against the current (unfixed) code and confirm it fails**

Run: `cd server && uv run pytest tests/test_ops_idempotency.py::test_batch_id_insert_race_blocks_on_the_batchs_transaction -v`
Expected: FAIL — under current code the racing INSERT has no lock in its way and succeeds, so the `pytest.raises` block raises `Failed: DID NOT RAISE`.

- [ ] **Step 3: Commit**

```bash
git add server/tests/test_ops_idempotency.py
git commit -m "test(pkm-gwwu): red — rewrite the insert-race test for the coming one-transaction fix"
```

## Task 4: `post_ops` owns one transaction

**Files:**
- Modify: `server/src/pkm/server/routes_ops.py:21-89`

**Interfaces:**
- Consumes: `sqlite3.OperationalError`, `HTTPException(status_code, detail, headers)`.
- Produces: no change to `post_ops`'s external contract other than the new 503 path and the docstring.

- [ ] **Step 1: Add a docstring to `post_ops`**

Directly under the `async def post_ops(...)` signature (the function currently has none; the module docstring alone doesn't reach `openapi.json`). State, in your own words: one SQLite transaction now covers the batch_id dedupe check through the commit; a write lock the busy timeout could not take (a concurrent `delete_page`/`rename_page`/`cleanup_journal`) returns 503 with `Retry-After`. No bean id.

- [ ] **Step 2: Issue `BEGIN IMMEDIATE` first, with contention handling**

Immediately inside the function body, before `now = int(time.time() * 1000)` or right after it (your choice, no observable difference) and before `rhash`/`replay_hash`/the dedupe SELECT:

```python
try:
    db.execute("BEGIN IMMEDIATE")
except sqlite3.OperationalError as exc:
    if "locked" not in str(exc):
        raise
    raise HTTPException(status_code=503, headers={"Retry-After": "1"},
                        detail="database busy, retry") from exc
```

- [ ] **Step 3: Roll back on both exits of the `row is not None:` dedupe branch**

The 409 mismatched-hash branch (currently `raise HTTPException(409, ...)` with no rollback) and the plain replay branch (currently `return json.loads(row["response"])` with no rollback) each need `db.rollback()` immediately before their `raise`/`return`. The `except OpError` branch already rolls back — leave it.

- [ ] **Step 4: Delete the `except sqlite3.IntegrityError` branch on the `applied_batches` INSERT**

Replace:
```python
try:
    db.execute("INSERT INTO applied_batches VALUES (?,?,?,?)", (...))
except sqlite3.IntegrityError:
    db.rollback()
    row = db.execute(...).fetchone()
    assert row is not None
    return json.loads(row["response"])
db.commit()
```
with a bare `db.execute(...)` followed directly by `db.commit()` — the race it used to catch cannot happen once `BEGIN IMMEDIATE` is held from before the dedupe SELECT (a racing second `post_ops` call blocks on `BEGIN IMMEDIATE` and, once unblocked, finds the row via the ordinary dedupe SELECT/replay path, not an `IntegrityError`).

- [ ] **Step 5: Run the three new/rewritten tests and confirm they pass**

Run: `cd server && uv run pytest tests/test_ops_concurrency.py tests/test_ops_idempotency.py -v`
Expected: PASS, including `test_batch_id_insert_race_blocks_on_the_batchs_transaction`, `test_concurrent_page_delete_cannot_land_inside_the_batch`, `test_concurrent_rename_cannot_resurrect_the_old_title`, `test_lock_contention_on_begin_immediate_returns_503`.

- [ ] **Step 6: Run the full ops test suite and confirm no regressions**

Run: `cd server && uv run pytest tests/test_ops_endpoint.py tests/test_ops_idempotency.py tests/test_ops_core.py tests/test_ops_concurrency.py tests/test_db_concurrency.py -v`
Expected: PASS, in particular `test_same_batch_id_different_ops_is_rejected`, `test_conflicting_batch_id_409_detail_shape_matches_400`, `test_rejected_batch_is_not_recorded`, `test_orphan_conflict_names_hinted_page`, and `test_orphan_conflict_hint_naming_a_renamed_away_page_does_not_recreate_it` (the two sequential, non-racing precursors to Task 1's tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/pkm/server/routes_ops.py
git commit -m "fix(pkm-gwwu): post_ops holds BEGIN IMMEDIATE from the dedupe read through the commit"
```

## Task 5: Regenerate `openapi.json` and web types

**Files:**
- Modify: `web/src/api/openapi.json`, `web/src/api/types.d.ts`

- [ ] **Step 1: Regenerate the schema**

Run: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`

- [ ] **Step 2: Regenerate the TS types**

Run: `cd web && pnpm gen-types`

- [ ] **Step 3: Web typecheck**

Run: `cd web && pnpm typecheck`
Expected: PASS (the docstring only adds a `description` field to the `/api/ops` POST operation; no request/response shape changed).

- [ ] **Step 4: Confirm the sync test passes**

Run: `cd server && uv run pytest tests/test_openapi_sync.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "chore(pkm-gwwu): regenerate openapi.json/types.d.ts for the post_ops docstring"
```

## Task 6: Docs — D1 correction and a troubleshooting row

**Files:**
- Modify: `docs/architecture/backend.md` (§ The write path, the mermaid flowchart around lines 222-230)
- Modify: `docs/architecture/sync-and-offline.md` (line 52, the sequence-diagram step `S->>S: one transaction: plan ops...`)
- Modify: `docs/troubleshooting.md` (§ Backend (server and HTTP API) table)

- [ ] **Step 1: Invoke the `architecture-docs` skill**

- [ ] **Step 2: Fix `backend.md`'s write-path flowchart**

The flowchart's `R["routes_ops.py (Shell)<br/>idempotency check"]` and `CTX["ops_apply._context_for (Shell)<br/>read SQLite → OpContext"]` boxes currently read as happening before the `X["...one transaction"]` box's transaction starts. Make the diagram and/or its surrounding prose say the dedupe check and the context read are inside the same transaction as `_execute`, not a separate step ahead of it — this is now true and was the exact bug.

- [ ] **Step 3: Fix `sync-and-offline.md` line 52**

`S->>S: one transaction: plan ops (pure core),<br/>execute, re-derive refs + FTS<br/>(triggers append journal rows)` omits the dedupe check from "one transaction". Make it explicit that the batch_id dedupe read is inside that same transaction.

- [ ] **Step 4: Add a troubleshooting row**

In `docs/troubleshooting.md`'s "Backend (server and HTTP API)" table, add a row: Symptom — a concurrent page delete or rename racing an in-flight `POST /api/ops` batch could swallow a clean text update behind a stored `ok` ack, or resurrect a just-renamed-away page's old title. Cause — `post_ops` read the dedupe check and the batch's context in autocommit, before its first write opened an implicit transaction, so `delete_page`/`rename_page`/`cleanup_journal` (their own connections) could commit inside that window. Where — `backend.md § The write path`. Ref — `pkm-gwwu`.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/backend.md docs/architecture/sync-and-offline.md docs/troubleshooting.md
git commit -m "docs(pkm-gwwu): the ops route's one transaction now covers the dedupe check too"
```

## Task 7: Final verification

- [ ] **Step 1: Full server test suite**

Run: `cd server && uv run pytest -q`
Expected: PASS, coverage gate (`--cov-fail-under=95`) satisfied.

- [ ] **Step 2: Type check**

Run: `cd server && uv run pyrefly check`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `cd server && uv run ruff check`
Expected: PASS.

- [ ] **Step 4: Confirm the regen checklist is fully applied**

`web/src/api/openapi.json` and `web/src/api/types.d.ts` are committed (Task 5); `cd web && pnpm typecheck` passes.

- [ ] **Step 5: Performance check**

Run: `perf/check.sh backend`
Expected: no regression. If one appears: read the diff along the regressed path, fix, re-run. Unstable → file a bean against the perf harness and continue. Stale baseline → `perf/check.sh backend --rebaseline`. Lost/reclassified → `--bootstrap`. Only bring a surviving regression to Arthur, with the table and findings.

- [ ] **Step 6: Update the bean**

Mark each `beans show pkm-gwwu` checklist item done, add a `## Summary of Changes` section describing what changed (BEGIN IMMEDIATE placement, the two new race tests, the removed IntegrityError branch, the docstring/regen, the doc corrections), and mark the bean completed.

- [ ] **Step 7: Commit the bean update with the code**

```bash
git add .beans/
git commit -m "chore(pkm-gwwu): mark complete"
```

---

## Self-Review Notes

- **Spec coverage:** Problem/Mechanism (BEGIN IMMEDIATE, every-exit rollback, 503+Retry-After, IntegrityError removal) → Task 4. Tests (rewritten insert-race, delete-race, rename-race) → Tasks 1–3. Docs (D1: docstring, backend.md, sync-and-offline.md) → Tasks 4 & 6. Shared rule "regenerates openapi.json and the web types before review" → Task 5. `Verification per branch` → Task 7.
- **Type consistency:** `_context_for(db, op, now_ms) -> OpContext`, `_hint_page_exists(db, page_title) -> bool`, `delete_page_rows(db, page_id, title) -> None`, `rename_page_rows(db, page_id, old_title, new_title, now_ms) -> None` are used with matching signatures in both Task 1 tests and match the real signatures read from `ops_apply.py`/`store.py`.
- **Proportion:** code blocks are limited to the exact test bodies (which pin non-obvious concurrency setup an implementer would otherwise have to reconstruct) and a short control-flow skeleton for the fix; no full reproduction of the unchanged parts of `post_ops`.
