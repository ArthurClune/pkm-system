# Page Delete Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A batch built on a device that had not yet seen a page delete can no longer bring the page back: its content for that page is parked in today's daily note and its links to it become plain text; the multi-device sync property suite proves it.

**Architecture:** The server records each user page delete (canonical title + the journal seq after the delete). Each web batch carries the replica's sync cursor from enqueue time (`seen_seq`). `apply_batch` derives the batch's stale titles once, unlinks them from every `create`/`update_text` text up front, drops a stale `create_page`, and classifies a stale top-level `create`/`move` as a new skip kind that parks like the existing ones. Part B teaches the sync property harness and oracle about deletes.

**Tech Stack:** Python 3.12 / FastAPI / SQLite (server), TypeScript / sqlite-wasm replica (web), fast-check property suite (`web/src/props/sync`).

**Spec:** `docs/superpowers/specs/2026-10-14-page-delete-wins-design.md`

Work in the worktree `/Users/arthur/code/llm/pkm/.claude/worktrees/page-delete-wins` (branch `feature/page-delete-wins`). Run every command from there; never touch `/Users/arthur/code/llm/pkm` directly.

## Global Constraints

- Stale for a batch: a `page_deletions` row for the title has `seq > batch.seen_seq`. No `seen_seq` → never stale. `seen_seq` > the journal's `MAX(seq)` → stale for every recorded title.
- Recorded: deletes through `store.delete_page_unlinking` only. Not recorded: daily-note titles (`date_for_title(title) is not None`), `cleanup_journal`, rename merges, the title migration.
- Pruned on the same window as `block_rewrites` (`BLOCK_REWRITE_RETENTION_MS`, 30 days).
- Staleness is by canonical title, regardless of whether the page exists now.
- Every stale-title match uses `title_reader(db)` canonicalisation over `normalize_title(raw)`, as `replay_title_rewrites` does for unlink rows.
- Parking never drops text. A blank stale create lands nothing (as a blank `diverted_create`).
- Non-stale batches behave exactly as today.
- FCIS headers on every new file; no bean ids in code or test comments.
- Any contract change → regenerate `web/src/api/openapi.json` and `types.d.ts`: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types`.

## Review Focus

1. **A device's own delete, then an immediate `[[X]]` on that device before its feed catches up** — the batch is stale for X and the link goes plain. Expected and accepted by the rule; pin it in an endpoint test so a reviewer sees it is deliberate (Task 4).
2. **Hashed `update_text` on a block the delete already unlinked** — the `block_rewrites` replay and the stale unlink both run; the result must be the same plain text, classified `clean`/`identical`, not a conflict (Task 4).
3. **A stale top-level create whose children follow in the same batch** — children are `diverted_create` under the never-created parent and must group under the same daily-note header as their parent's text (`landing_uid` = parent uid) (Task 4).
4. **A replica that has never bootstrapped (no `generation` meta)** — it must send no `seen_seq`, or a brand-new device would park its first page (Task 5).
5. **The first open after deploy** — `CLIENT_DDL` changes `SCHEMA_VERSION`, so each device flushes its queue (rows read through `allBatches`, without `seen_seq`) and rebootstraps once; an `enqueue` that beats `init()` on an older file must still persist (Task 5).

---

## Part A — product change (`pkm-ynze`)

### Task 1: Page-deletion record

**Files:**
- Modify: `server/src/pkm/schema.py` (`SERVER_DDL`)
- Modify: `server/src/pkm/server/store.py` (`delete_page_unlinking`, `_prune_block_rewrites`)
- Test: `server/tests/test_page_deletions.py` (new)

**Interfaces:**
- Produces: table `page_deletions(title TEXT NOT NULL, seq INTEGER NOT NULL, deleted_at INTEGER NOT NULL)` with `CREATE INDEX idx_page_deletions_seq ON page_deletions(seq)`; server-only, no journal trigger. SQL comment in the style of `block_rewrites`'.
- Produces: `store.stale_titles(db: sqlite3.Connection, seen_seq: int | None) -> frozenset[CanonicalTitle]`.

- [ ] **Step 1: Write the failing tests** (`client`/`seeded_config` fixtures as in `test_page_endpoint.py`)

```python
def test_delete_records_title_and_seq(client, seeded_config):
    assert client.delete("/api/page/Machine Learning").status_code == 200
    rows = _rows(seeded_config, "SELECT title, seq FROM page_deletions")
    latest = _rows(seeded_config, "SELECT MAX(seq) FROM changes")[0][0]
    assert rows == [("Machine Learning", latest)]

def test_daily_page_delete_is_not_recorded(client, seeded_config):
    assert client.delete("/api/page/July 7th, 2026").status_code == 200
    assert _rows(seeded_config, "SELECT * FROM page_deletions") == []

def test_cleanup_journal_does_not_record(...):  # an empty unlinked past-week daily, cleaned
    ...  # assert page_deletions stays empty

def test_rows_past_retention_are_pruned(...):  # insert an old row, delete a page, old row gone

def test_stale_titles():
    # in-memory db with DDL; rows (A, 10), (B, 20); MAX(changes.seq) = 25
    assert stale_titles(db, None) == frozenset()
    assert stale_titles(db, 10) == {"B"}
    assert stale_titles(db, 9) == {"A", "B"}
    assert stale_titles(db, 20) == frozenset()
    assert stale_titles(db, 26) == {"A", "B"}   # cursor from a replaced database
```

- [ ] **Step 2: Run, expect FAIL** — `cd server && uv run pytest -q --no-cov tests/test_page_deletions.py`
- [ ] **Step 3: Implement.** In `delete_page_unlinking`, after `delete_page_rows`, insert `(title, MAX(seq) FROM changes, now_ms)` unless `date_for_title(title) is not None`; `_prune_block_rewrites` also deletes `page_deletions` rows older than the window. `stale_titles` is one statement when `seen_seq` is not None (it must not run any query for `None`: the CLI/MCP hot path stays at today's statement count).
- [ ] **Step 4: Run, expect PASS**, plus `tests/test_page_delete_unlinks.py tests/test_page_endpoint.py`.
- [ ] **Step 5: Commit** `feat(pkm-ynze): record user page deletes with their journal seq`

### Task 2: `seen_seq` on the batch contract

**Files:**
- Modify: `server/src/pkm/contracts/ops.py` (`OpBatch`)
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`
- Test: `server/tests/test_ops_idempotency.py`

**Interfaces:**
- Produces: `OpBatch.seen_seq: int | None = Field(default=None, ge=0)`, with a comment: the client's sync cursor when the batch's ops were built; absent = built against current server state.

- [ ] **Step 1: Failing test** — `test_seen_seq_is_not_part_of_the_batch_hashes`: two `OpBatch`es identical but for `seen_seq` (None vs 7) have equal `batch_request_hash` and `batch_replay_hash`; and the same `batch_id` posted twice with different `seen_seq` replays the first ack (no 409).
- [ ] **Step 2: Run, expect FAIL** (field rejected by pydantic).
- [ ] **Step 3: Add the field;** hashes already cover only `ops`, so no hash change. Regenerate openapi + types.
- [ ] **Step 4: Run** `uv run pytest -q --no-cov tests/test_ops_idempotency.py tests/test_openapi_sync.py` → PASS.
- [ ] **Step 5: Commit** `feat(pkm-ynze): OpBatch carries the client's seen sync seq`

### Task 3: Pure core — stale unlink and the `stale_page` skip

**Files:**
- Modify: `server/src/pkm/server/ops_core.py` (`SkipKind`, `classify_skip`, `_skip_context` contract, `_plan_skip_own`, `skip_report`, new `unlink_stale_text`)
- Modify: `server/src/pkm/contracts/responses.py` (`SkipReason`)
- Modify: `server/src/pkm/server/conflict_notes.py` (new note)
- Test: `server/tests/test_ops_core.py`, `server/tests/test_conflict_notes.py`

**Interfaces:**
- Produces: `unlink_stale_text(op: BlockOp, is_stale: TitleMatch) -> BlockOp` — for `CreateOp`/`UpdateTextOp` returns `op.model_copy(update={"text": unlink_title_refs(op.text, is_stale)})` when that changes the text, else `op` unchanged; other ops unchanged. (`TitleMatch`, `unlink_title_refs` from `pkm.unlink`.)
- Produces: `SkipKind` gains `"stale_page"`; `classify_skip(op, block_exists, parent_exists, parent_chain=(), page_stale=False)`. `page_stale` is the shell's answer to "is this op's top-level `page_title` stale" (only meaningful for a `CreateOp`/`MoveOp` with `parent_uid is None` and a `page_title`).
  - `CreateOp`, not `block_exists`, `parent_uid is None`, `page_stale` → `Skip("stale_page", op.uid if op.text.strip() else None)`.
  - `MoveOp`, `block_exists`, `parent_uid is None`, `page_stale` → `Skip("stale_page", op.uid)`.
  - Everything else unchanged (a missing block's move stays `orphan_structural`).
- Produces: `SkipReason` gains `"page_deleted"`; `skip_report` maps `stale_page` to it.
- Produces: `conflict_notes.stale_page_move_note(page_title: str) -> str` = `f"move skipped: page {code_span(page_title)} was deleted"` — use the same code-span helper `conflict_label` uses for a title that no longer exists.
- Planning (`_plan_skip_own`):
  - stale `CreateOp` with a landing: tombstone `JournalBlock(op.uid, True)` (no parent tombstone; no ghost page), entry text `op.text`, header `orphan_header_text(op.page_title, False)`.
  - stale `CreateOp` without a landing (blank): just the tombstone.
  - stale `MoveOp`: a `StuckMoveContext` (block stays put): no tombstones, note `stale_page_move_note(op.page_title)`, header `live_block_header_text(ctx.page_title, op.uid)`, the subtree re-journalled live. Relax the `StuckMoveContext` assertions to admit `stale_page` with `parent_uid is None`.

- [ ] **Step 1: Failing tests**

```python
def test_unlink_stale_text_rewrites_create_and_update_text_only():
    is_x = lambda raw: normalize_title(raw) == "X"
    create = CreateOp(op="create", uid="uid_c0000001", page_title="P",
                      parent_uid=None, order_idx=0, text="see [[X]] and #X")
    assert unlink_stale_text(create, is_x).text == "see X and X"
    upd = UpdateTextOp(op="update_text", uid="uid_u0000001", text="[[Y]]")
    assert unlink_stale_text(upd, is_x) is upd
    # move/delete/set_* returned unchanged

# top_create(title, text) / top_move(title): small local builders for
# top-level CreateOp / MoveOp with fixed uids
def test_classify_skip_stale_page():
    assert classify_skip(top_create("X", "t"), False, False, page_stale=True) \
        == Skip("stale_page", "uid_c0000001")
    assert classify_skip(top_create("X", "  "), False, False, page_stale=True) \
        == Skip("stale_page", None)
    assert classify_skip(top_move("X"), True, False, page_stale=True) \
        == Skip("stale_page", "uid_m0000001")
    assert classify_skip(top_create("X", "t"), False, False) is None

def test_plan_stale_create_parks_text_under_a_code_span_header(): ...
    # effects: JournalBlock(uid, True), then conflict_entry_effects with
    # header orphan_header_text("X", False) and lost text op.text
def test_plan_stale_move_keeps_block_and_notes_it(): ...
def test_skip_report_stale_page_reason(): ...  # reason == "page_deleted"
```

- [ ] **Step 2: Run, expect FAIL** — `uv run pytest -q --no-cov tests/test_ops_core.py tests/test_conflict_notes.py`
- [ ] **Step 3: Implement** per the Interfaces block; regenerate openapi + types (SkipReason is in the ack schema).
- [ ] **Step 4: Run, expect PASS** (also `tests/test_openapi_sync.py`).
- [ ] **Step 5: Commit** `feat(pkm-ynze): pure planning for stale-page ops`

### Task 4: Shell wiring in `apply_batch`, end to end

**Files:**
- Modify: `server/src/pkm/server/ops_apply.py` (`apply_batch`, `_context_for`, `_skip_context`)
- Test: `server/tests/test_ops_endpoint.py` (or a new `server/tests/test_stale_page_ops.py` if that file reads better on its own)

**Interfaces:**
- Consumes: `store.stale_titles` (Task 1), `OpBatch.seen_seq` (Task 2), `unlink_stale_text`, `classify_skip(..., page_stale=)`, `stale_page` (Task 3).
- `apply_batch`: `stale = stale_titles(db, batch.seen_seq)`; when non-empty, `canonical = title_reader(db)` once and `is_stale = lambda raw: canonical(normalize_title(raw)) in stale`; each op passes through `unlink_stale_text` before `_context_for`, and the rewritten op is what is planned and broadcast. A stale `CreatePageOp` is dropped: no effect, no broadcast, no `skipped` entry (the replica's local page goes through `dropStrandedLocalPages`).
- `_context_for(db, op, now_ms, is_stale: TitleMatch | None)`: computes `page_stale` for top-level `create`/`move` with a `page_title` and passes it to `classify_skip`; `_skip_context` routes a `stale_page` `MoveOp` to `StuckMoveContext` (with `_require_page_title(db, block.page_id)`) and a `stale_page` `CreateOp` to `LandedSkipContext(hint_page_exists=False)` / `SkipContext`. `_resolve_page` is never reached for a stale title.

- [ ] **Step 1: Failing endpoint tests.** Set-up helper: note `seen = MAX(seq)` before `DELETE /api/page/Machine Learning`, then post the batch with `seen_seq=seen`. One test per spec table row plus the Review Focus items:
  - `test_stale_top_level_create_is_parked_and_page_stays_deleted` — `GET /api/page/Machine Learning` → 404; today's daily has a `[[conflict]]` header whose label is a code span and the text under it; ack `skipped[0].reason == "page_deleted"`.
  - `test_stale_top_level_create_children_group_under_its_header` — create P (top-level, stale) then child C under P in one batch: one header, both texts under it.
  - `test_stale_top_level_move_leaves_block_and_notes_it`.
  - `test_stale_create_page_is_dropped` — 404 afterwards, nothing in `skipped`, nothing broadcast.
  - `test_stale_link_in_create_under_live_parent_becomes_plain` — the split case: `create` under a live block with text `about [[Machine Learning]]` → stored `about Machine Learning`, page 404.
  - `test_stale_link_in_unhashed_and_hashed_update_text_becomes_plain` — includes a block the delete already unlinked (replay + stale unlink → `clean`, no conflict header).
  - `test_parked_orphan_edit_text_is_unlinked` — `update_text` on a deleted page's block with `[[Machine Learning]]` in it → parked text plain, page 404.
  - `test_same_device_link_right_after_its_own_delete_goes_plain` (Review Focus 1).
  - `test_stale_create_parks_even_when_the_page_was_recreated` — another batch with a current `seen_seq` re-creates the page; the stale batch's top-level create still parks.
  - `test_non_stale_batch_recreates_as_today` — `seen_seq` ≥ the delete's seq: top-level create re-creates the page.
  - `test_batch_without_seen_seq_recreates_as_today`.
  - `test_seen_seq_beyond_latest_is_stale`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** `uv run pytest -q` (full, enforced coverage), `uv run pyrefly check`, `uv run ruff check` → all pass.
- [ ] **Step 5: Commit** `feat(pkm-ynze): stale batches cannot re-create a deleted page`

### Task 5: Web replica records `seen_seq`; the queue posts it

**Files:**
- Modify: `web/src/replica/clientSchema.ts` (`CLIENT_DDL`)
- Modify: `web/src/replica/queue.ts` (`enqueueBatch`, `nextBatch`, `deleteBatch`)
- Modify: `web/src/replica/client.ts` (`PendingBatch`)
- Modify: `web/src/replica/workerHandlers.ts` (enqueue's pre-`init` table guard)
- Modify: `web/src/sync/opQueue.ts` (`postOps` and the durable-batch call site, ~line 563)
- Test: `web/src/replica/queue.test.ts`, `web/src/sync/opQueue.test.ts` (or the file that covers durable posting)

**Interfaces:**
- Produces: `CREATE TABLE IF NOT EXISTS pending_seen(batch_id TEXT PRIMARY KEY, seen_seq INTEGER NOT NULL)` in `CLIENT_DDL`. A separate table, not a `pending_ops` column, so `pending_ops` keeps its migration-stable shape and `allBatches`/`poisonedBatches`/the carry stay untouched (a carried or recovery-flushed batch goes out without `seen_seq`, i.e. never stale).
- Produces: `PendingBatch.seen_seq?: SyncSeq`.
- `enqueueBatch` inserts `(batchId, cursor)` into `pending_seen` inside its transaction when `getMeta(db, "generation") !== null` (cursor = `Number(getMeta(db, "cursor") ?? 0)`); `nextBatch` LEFT JOINs it; `deleteBatch` deletes the row with the batch.
- The worker's enqueue guard runs `CLIENT_DDL` when `pending_seen` is missing (all statements are `IF NOT EXISTS`), so an enqueue on an older file before `init()` still persists.
- `postOps(ops, batchId, seenSeq?: SyncSeq)` adds `seen_seq` to the body only when defined; only the durable-batch call site passes it (the in-memory lane has no cursor).

- [ ] **Step 1: Failing tests**
  - queue: after `setMeta(db,"generation","g")`, `setMeta(db,"cursor","42")`, `enqueueBatch` → `nextBatch(db)?.seen_seq === 42`; with no generation → `seen_seq` undefined; `deleteBatch` removes the `pending_seen` row; `allBatches` still selects only the stable columns.
  - worker guard: an older file without `pending_seen` (create the schema from a `CLIENT_DDL` copy minus that table) accepts an enqueue.
  - opQueue: a durable batch with `seen_seq` posts `{client_id, batch_id, ops, seen_seq}`; one without omits the key.
- [ ] **Step 2: Run, expect FAIL** — `cd web && pnpm exec vitest run src/replica/queue.test.ts src/sync/opQueue.test.ts`
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Run** `cd web && set -o pipefail && E2E_PORT=8986 pnpm verify` → exit 0.
- [ ] **Step 5: Commit** `feat(pkm-ynze): web batches carry the replica cursor from enqueue`

### Task 6: Docs, perf, property gate, bean

**Files:**
- Modify: `docs/architecture/backend.md` (Database: `page_deletions`; ops contract `seen_seq`; the page-delete section: one row/sentence for stale batches; skip kinds list if enumerated), `docs/architecture/sync-and-offline.md` (`seen_seq` at enqueue, `pending_seen`, the `stale_page` skip), `docs/troubleshooting.md` (row: "a deleted page reappears after another device syncs" → cause, `backend.md` section, `pkm-ynze`)
- Modify: `.beans/pkm-ynze--*.md` (tick todos)

- [ ] **Step 1:** Invoke the `architecture-docs` skill; edit; `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/backend.md docs/architecture/sync-and-offline.md docs/troubleshooting.md` → no failures. Grep for counts the change stales (`grep -n "six skip\|SkipKind\|skip kinds" docs/`).
- [ ] **Step 2:** `perf/check.sh` (both sides). A backend count change confined to the page-delete scenario (the record insert, the prune) is expected: bring the table to Arthur before `--bootstrap`. A change on the ops path is a regression to fix (`stale_titles` must not query for a batch without `seen_seq`).
- [ ] **Step 3:** `proptest/check.sh` (server and web) → pass.
- [ ] **Step 4: Commit** `docs(pkm-ynze): stale-batch delete handling` with the bean update.

---

## Part B — sync property suite (`pkm-wvac`)

### Task 7: Harness logs deletes

**Files:**
- Modify: `server/tooling/proptest/sync_server.py`
- Modify: `web/src/props/sync/serverControl.ts`
- Test: the harness's existing pytest coverage for the control routes (find it with `grep -rn "__proptest/renames" server/tests`)

**Interfaces:**
- Produces: a harness log of page deletes, fed by an `AFTER INSERT ON page_deletions` trigger (so only user deletes are logged), holding title, the faulted run's `seq`, `after_batch` (as `proptest_renames` computes it) and `at`. Renames and deletes must be replayable in their mutual commit order: give both logs a shared ordinal (e.g. one counter both triggers read), and expose it in both routes.
- Produces: `GET /__proptest/deletes` → `[{title, seq, after_batch_id, at, ord}]` in commit order; `ServerControl.deletes(): Promise<DeleteRecord[]>` and `ServerControl.postDelete(title): Promise<Response>`; `RenameRecord` gains `ord`.

- [ ] Steps: failing route test → implement → pass → commit `test(pkm-wvac): harness logs page deletes`.

### Task 8: `DeletePage` command

**Files:**
- Modify: `web/src/props/sync/commands.ts`, `web/src/props/sync/commands.test.ts`

**Interfaces:**
- Produces: `class DeletePage extends SyncCommand` (`client`, `title: number`), modelled on `Rename`: `DELETE /api/page/{title}` through the client's transport; outcomes `deleted`, `refused 404`, `refused 409`, `failed offline`, counted with `w.count`.
- `commandsFor` adds `{ weight: 1, arbitrary: fc.tuple(client, fc.nat({ max: PAGE_TITLES.length - 1 })).map(([c, t]) => new DeletePage(c, t)) }`; update the weights comment.

- [ ] Steps: failing command test (drawn, toString, outcome on a 404) → implement → pass → commit `test(pkm-wvac): draw page deletes`.

### Task 9: Oracle replays deletes and checks "delete wins"

**Files:**
- Modify: `web/src/props/sync/oracle.ts`, `web/src/props/sync/teeth.prop.ts`, `server/tooling/proptest/sync_server.py` (teeth switch)
- Modify: `docs/architecture/property-checks.md`

**Interfaces / requirements:**
- `serialReplay` replays renames and deletes merged by `ord`, each after its `after_batch_id`, at its clock (`setClock(at)`, then `postRename`/`postDelete`); a non-OK delete is a finding.
- Recorded bodies carry the faulted run's `seen_seq`. Before posting a body, rewrite its `seen_seq` so the batch is stale for exactly the titles it was stale for in the faulted run: map it to the replay server's seq of the last delete whose faulted `seq` ≤ the body's `seen_seq` (0 when none; leave it absent when absent; a `seen_seq` beyond the faulted run's latest maps beyond the replay's latest).
- New `Invariant` `"delete wins"`, evaluated before the replay resets the server: no block uid that was on a page when it was deleted exists in the server snapshot; and every deleted title that exists at quiescence was named (`page_title`, or a link in `text`) by a committed batch that was not stale for it, or is the target of a later rename. Record the uids per delete in the harness log (Task 7) if the snapshot cannot supply them.
- Teeth: a harness switch that makes `stale_titles` return the empty set (patched in `sync_server.py`, like the echo teeth); a teeth property shows the oracle fails "delete wins" with it on.
- `property-checks.md`: control-route table (`/__proptest/deletes`), the invariant list, the command weights.

- [ ] Steps: failing teeth property → implement oracle → `proptest/check.sh web --file sync` passes and the teeth file fails as intended → commit `test(pkm-wvac): oracle replays deletes and checks delete wins`.
- [ ] Final: full `proptest/check.sh`, `perf/check.sh`, server and web gates; tick and complete both beans.
