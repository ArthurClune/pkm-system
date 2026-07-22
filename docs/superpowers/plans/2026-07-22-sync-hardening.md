# Sync Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three fixes in `docs/superpowers/specs/2026-07-22-sync-hardening-design.md`: (A) surface wedged replica sync with a banner + reset action, (B) require `batch_id` on every `/api/ops` batch, (C) stop GET from resurrecting daily pages.

**Architecture:** Server changes are narrow (pydantic model + one route guard). Web changes follow the existing FCIS split: policy in functional-core files (`syncState.ts`), I/O in shells (`replicaSync.ts`, `opQueue.ts`, `SyncProvider.tsx`). The replica localApi mirrors server routes 1:1 and must change in lockstep.

**Tech Stack:** FastAPI + pydantic + pytest (server); React + TypeScript + vitest (web); sqlite WASM replica in a worker.

## Global Constraints

- Every runtime file keeps/declares its `# pattern:` / `// pattern:` header (Functional Core vs Imperative Shell).
- Server verification: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`.
- Web verification: `cd web && pnpm verify` (typecheck + unit coverage + Playwright E2E; needs `pnpm build` first for E2E).
- Any change to server routes/models: regenerate `web/src/api/openapi.json` via `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json` then `cd web && pnpm gen-types`; commit both with the server change.
- Beans: pkm-ri5b (Task 1–2), pkm-fy52 (Task 3–5), pkm-80ds (Task 6–9). Commit bean file updates with the code.
- Work happens in the dedicated worktree branch `fix/sync-hardening`; run every command from the worktree root. Check `git status -sb` before every commit (parallel sessions may switch branches in the main checkout).
- Do not touch the production server or database (port 8974, `~/.config/pkm/`).

---

### Task 1: Server requires batch_id on POST /api/ops (Fix B, server half)

**Files:**
- Modify: `server/src/pkm/server/ops_core.py:88-93` (OpBatch)
- Modify: `server/src/pkm/server/routes_ops.py` (drop the `batch_id is not None` guards — it is now always present)
- Test: `server/tests/test_ops_idempotency.py`
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`

**Interfaces:**
- Produces: `OpBatch.batch_id: str` (required, 8–64 chars). `/api/ops` returns 422 for a missing batch_id. Task 2's client code relies on the server rejecting id-less batches.

- [ ] **Step 1: Replace the legacy-tolerance test with a rejection test (failing)**

In `server/tests/test_ops_idempotency.py`, replace `test_batch_without_batch_id_behaves_as_today` with:

```python
def test_batch_without_batch_id_is_rejected(client):
    """Id-less batches dedupe nowhere, so replays re-apply; the server now
    rejects them outright (2026-07-22 incident, bean pkm-ri5b)."""
    body = {"client_id": "c1", "ops": [
        {"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]}
    assert client.post("/api/ops", json=body).status_code == 422
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && uv run pytest tests/test_ops_idempotency.py -q`
Expected: the new test FAILS (currently 200).

- [ ] **Step 3: Make batch_id required**

In `server/src/pkm/server/ops_core.py`, change the OpBatch field:

```python
class OpBatch(BaseModel):
    client_id: str = Field(min_length=1, max_length=64)
    # Required since 2026-07-22 (bean pkm-ri5b): id-less batches cannot be
    # deduplicated, so any retry or replay re-applies. Pre-offline clients
    # now fail loudly (422) instead of corrupting silently.
    batch_id: str = Field(min_length=8, max_length=64)
    ops: list[BlockOp] = Field(min_length=1, max_length=500)
```

In `server/src/pkm/server/routes_ops.py`, simplify: `rhash = batch_request_hash(batch)` unconditionally, remove both `if batch.batch_id is not None:` wrappers (keep their bodies), and keep the IntegrityError race handling unchanged.

- [ ] **Step 4: Run the server suite, type check, lint**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: PASS. If other server tests post to `/api/ops` without a batch_id, fix those tests by adding unique batch ids (they are exercising op semantics, not the legacy path).

- [ ] **Step 5: Regenerate API types**

Run: `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types`
Expected: `openapi.json` diff shows batch_id moving into `required`.

- [ ] **Step 6: Commit**

```bash
git add server/src/pkm/server/ops_core.py server/src/pkm/server/routes_ops.py \
  server/tests/test_ops_idempotency.py web/src/api/openapi.json web/src/api/types.d.ts \
  .beans/pkm-ri5b-*.md
git commit -m "fix(pkm-ri5b): require batch_id on POST /api/ops"
```

---

### Task 2: Web fallback paths send real batch ids (Fix B, web half)

**Files:**
- Modify: `web/src/sync/opQueue.ts` (createLegacyQueue ~line 574-604; quota fallback ~line 447)
- Test: `web/src/sync/opQueue.test.ts`

**Interfaces:**
- Consumes: `postOps(ops, batchId?)` already accepts an optional id (opQueue.ts:136) and `newUid()` from `../uid`.
- Produces: every POST from the web client carries `batch_id`; legacy-queue retries resend a byte-identical frozen payload under the same id.

- [ ] **Step 1: Write failing tests**

Add to `web/src/sync/opQueue.test.ts` (match the file's existing fetch-mock style):

```typescript
it("legacy queue sends a batch_id and freezes the slice across retries", async () => {
  // first POST 500s, second succeeds; an op enqueued between attempts must
  // NOT join the retried batch, and both attempts share one batch_id
  const bodies: Array<{ batch_id?: string; ops: unknown[] }> = [];
  mockFetchSequence([500, 200, 200], (body) => bodies.push(body));
  const queue = createOpQueue(null, () => {}, () => {});
  queue.setOnline(true);
  queue.enqueue([collapsedOp("a")]);
  await queue.drain();               // attempt 1: 500, blocked retryable
  queue.enqueue([collapsedOp("b")]); // arrives during backoff
  await advanceRetryTimer();
  await queue.drain();               // attempt 2 (frozen slice) + next slice
  expect(bodies[0].batch_id).toBeDefined();
  expect(bodies[1].batch_id).toBe(bodies[0].batch_id);
  expect(bodies[1].ops).toEqual(bodies[0].ops);       // frozen: op "b" absent
  expect(bodies[2].batch_id).not.toBe(bodies[0].batch_id);
});

it("quota fallback posts with a batch_id", async () => {
  // replica.enqueue throws a quota ReplicaError -> direct POST carries an id
});
```

Implement the helpers with the file's existing mock utilities; if none fit, stub `apiFetch` via `vi.mock("../api/client")` capturing JSON bodies.

- [ ] **Step 2: Run to verify failure**

Run: `cd web && pnpm vitest run src/sync/opQueue.test.ts`
Expected: new tests FAIL (no batch_id today).

- [ ] **Step 3: Implement**

In `createLegacyQueue`, replace the slice logic in `runDrain`:

```typescript
let frozen: { id: string; ops: BlockOp[] } | null = null;
// inside runDrain's while loop:
frozen ??= { id: newUid(), ops: pending.slice(0, MAX_BATCH) };
const batch = frozen.ops;
try {
  await postOps(batch, frozen.id);
} catch (error: unknown) {
  // (existing 4xx/5xx handling; on the 4xx reject path also frozen = null)
}
frozen = null; // success path, before pending.splice
```

In `createReplicaQueue`'s quota fallback (line ~447): `await postOps(ops, newUid());`.

- [ ] **Step 4: Run the web unit suite**

Run: `cd web && pnpm test:unit`
Expected: PASS (existing legacy-queue tests may need batch_id-tolerant body assertions).

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/opQueue.ts web/src/sync/opQueue.test.ts .beans/pkm-ri5b-*.md
git commit -m "fix(pkm-ri5b): legacy queue and quota fallback send dedupable batch ids"
```

Mark pkm-ri5b completed (add `## Summary of Changes`).

---

### Task 3: Server stops auto-creating non-today dailies on GET (Fix C, server)

**Files:**
- Modify: `server/src/pkm/server/routes_pages.py:163-173` (get_page)
- Test: `server/tests/test_pages_api.py` (or the file where get_page is tested — locate with `grep -rln "api/page" server/tests`)

**Interfaces:**
- Produces: `GET /api/page/<past-or-future daily>` → 404, row NOT created. `GET /api/page/<today's title>` → 200, created if missing. Tasks 4–5 mirror this contract.

- [ ] **Step 1: Write failing tests**

```python
from datetime import date, timedelta
from pkm.server.daily import title_for_date


def test_get_past_daily_404s_and_creates_nothing(client):
    yesterday = title_for_date(date.today() - timedelta(days=1))
    assert client.get(f"/api/page/{yesterday}").status_code == 404
    # a second GET still 404s: the first one must not have created a row
    assert client.get(f"/api/page/{yesterday}").status_code == 404


def test_get_today_still_autocreates(client):
    today = title_for_date(date.today())
    r = client.get(f"/api/page/{today}")
    assert r.status_code == 200
    assert r.json()["page"]["title"] == today
```

Note: conftest seeds fixed dates around "July 7th, 2026"; use `date.today()` arithmetic as above, never hardcoded titles.

- [ ] **Step 2: Run to verify the first test fails**

Run: `cd server && uv run pytest tests -q -k "past_daily or autocreates"`
Expected: past-daily test FAILS (200 today), today test PASSES already.

- [ ] **Step 3: Implement**

In `get_page` replace the auto-create branch:

```python
    page = fetch_page(db, title)
    if page is None:
        # Only TODAY auto-creates on read (journal semantics). Auto-creating
        # any daily title resurrected deleted dailies as zombies and let
        # plain reads mint pages (bean pkm-fy52).
        if date_for_title(title) != date.today():
            raise HTTPException(status_code=404, detail="page not found")
        page = get_or_create_page(db, title, int(time.time() * 1000))
        db.commit()
        notify.nudge_threadpool(request, db)
```

(`date` is already imported in the module for get_journal; verify.)

- [ ] **Step 4: Full server verification**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: PASS. Response models unchanged → no openapi regen needed; confirm with `uv run python -m pkm.server.openapi_dump | diff - ../web/src/api/openapi.json` (expect no diff).

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/server/routes_pages.py server/tests/ .beans/pkm-fy52-*.md
git commit -m "fix(pkm-fy52): GET /api/page auto-creates only today's daily"
```

---

### Task 4: Replica localApi mirrors the today-only rule (Fix C, replica)

**Files:**
- Modify: `web/src/replica/localApi/pages.ts:88-99` (pagePayload)
- Modify (if needed): `web/src/replica/localApi/router.ts` (pagePayload caller passes nowMs already; check signature)
- Test: `web/src/replica/localApi/router.test.ts`

**Interfaces:**
- Consumes: `dateForTitle`, `titleForDate` from `web/src/replica/daily.ts`; `nowMs` already threaded into `pagePayload`.
- Produces: local GET parity with Task 3 — `pagePayload` returns `null` (→ local 404) for missing non-today dailies; creates today.

- [ ] **Step 1: Write failing tests**

In `router.test.ts`, following its existing request-helper style:

```typescript
it("GET page: missing past daily 404s locally and creates no row", () => {
  const yesterday = titleForDate(new Date(NOW_MS - 24 * 60 * 60 * 1000));
  expect(get(`/api/page/${encodeURIComponent(yesterday)}`).status).toBe(404);
  expect(get(`/api/page/${encodeURIComponent(yesterday)}`).status).toBe(404);
});

it("GET page: today's daily auto-creates locally", () => {
  const today = titleForDate(new Date(NOW_MS));
  expect(get(`/api/page/${encodeURIComponent(today)}`).status).toBe(200);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && pnpm vitest run src/replica/localApi/router.test.ts`

- [ ] **Step 3: Implement**

In `pagePayload`:

```typescript
  let page = fetchPage(db, title);
  if (page === null) {
    // Mirror of the server rule (bean pkm-fy52): only TODAY auto-creates
    // on read; other daily titles 404 like normal pages.
    if (title !== titleForDate(new Date(nowMs))) return null;
    getOrCreateLocalPage(db, title, nowMs); // local only, no push
    page = fetchPage(db, title);
    if (page === null) return null; // unreachable
  }
```

Drop the now-unused `dateForTitle` import if nothing else uses it.

- [ ] **Step 4: Run web unit suite**

Run: `cd web && pnpm test:unit` — the shim-parity tests (`shim_parity_dump`) may compare server/local behavior; if a parity fixture asserts daily auto-create, update it to the new contract.

- [ ] **Step 5: Commit**

```bash
git add web/src/replica/localApi/ .beans/pkm-fy52-*.md
git commit -m "fix(pkm-fy52): local replica GET page mirrors today-only auto-create"
```

---

### Task 5: Web renders missing dailies as empty editable pages (Fix C, views)

**Files:**
- Modify: `web/src/views/PageView.tsx` (404 branch)
- Modify: `web/src/views/Journal.tsx:46-51,91-96` (authoritative loaders map 404 → [])
- Test: `web/src/views/PageView.test.tsx`, `web/src/views/Journal.test.tsx`

**Interfaces:**
- Consumes: `ApiError` (`web/src/api/client.ts`, has `.status`), `dateForTitle` from `../replica/daily`.
- Produces: navigating to a deleted/never-created daily shows an empty editable page (first edit creates it via CreateOp's get_or_create); journal day loads survive a day deleted underneath them.

- [ ] **Step 1: Write failing tests**

`PageView.test.tsx` (existing render/msw-or-fetch-mock style):

```typescript
it("renders an empty editable page for a missing daily title", async () => {
  mockPageFetch404("July 1st, 2026");
  renderPageViewAt("/page/July%201st%2C%202026");
  expect(await screen.findByText("July 1st, 2026")).toBeInTheDocument();
  expect(screen.queryByText(/Could not load/)).toBeNull();
  // composer/editor present:
  expect(document.querySelector(".page")).not.toBeNull();
});

it("still shows the error for a missing normal page", async () => {
  mockPageFetch404("No Such Page");
  renderPageViewAt("/page/No%20Such%20Page");
  expect(await screen.findByText(/Could not load/)).toBeInTheDocument();
});
```

`Journal.test.tsx`: a day whose authoritative `/api/page` load 404s renders as an empty day, not an error.

- [ ] **Step 2: Run to verify failure**

Run: `cd web && pnpm vitest run src/views/PageView.test.tsx src/views/Journal.test.tsx`

- [ ] **Step 3: Implement**

`PageView.tsx` — add a helper above the component:

```typescript
const emptyDailyPayload = (title: string): PagePayload => ({
  page: { id: -1, title, created_at: 0, updated_at: 0 },
  blocks: [],
  backlinks: { groups: [], total_pages: 0, offset: 0, limit: 20 },
  block_ref_texts: {},
});

const missingDaily = (e: unknown, title: string): boolean =>
  e instanceof ApiError && e.status === 404 && dateForTitle(title) !== null;
```

In `load`'s `apiFetch(...).catch` (and the parent-readiness `.catch`), before setting the error: if `missingDaily(e, title)`, feed the session an empty authoritative read and set the fabricated payload instead of the error. Concretely in the direct-fetch catch:

```typescript
      .catch((e: unknown) => {
        if (missingDaily(e, title)) {
          const p = emptyDailyPayload(title);
          const accepted = handle.receiveParentAuthoritative(token, p);
          if (readRef.current === read && (accepted || source !== "parent")) {
            readRef.current = null;
          }
          if (seq === seqRef.current && accepted && source !== "parent") {
            setPayload({ ...p, blocks: handle.getSnapshot().blocks });
          }
          return;
        }
        // ...existing failure handling...
      });
```

Check `receiveParentAuthoritative`'s exact payload expectations in `outlineSessions.ts` before wiring; if it demands a server page id, route through `session.beginAuthoritativeRead`/`receiveAuthoritative(token, [])` and set the payload directly instead.

Also update PageView's authoritative loader (line 92-97) the same way: 404 + daily title → return `[]` instead of throwing.

`Journal.tsx` — both places that fetch `/api/page/<day title>` (the `sessionFor` loader and the `requestAuthoritative` closure in `loadMore`): wrap with

```typescript
try {
  const page = await apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`);
  return page.blocks;
} catch (e: unknown) {
  if (e instanceof ApiError && e.status === 404) return [];
  throw e;
}
```

- [ ] **Step 4: Run web unit suite + typecheck**

Run: `cd web && pnpm test:unit && pnpm typecheck`

- [ ] **Step 5: Commit; complete pkm-fy52**

```bash
git add web/src/views/ .beans/pkm-fy52-*.md
git commit -m "fix(pkm-fy52): missing dailies render as empty editable pages"
```

Mark pkm-fy52 completed with `## Summary of Changes`.

---

### Task 6: replicaSync stall detection + backoff retries (Fix A, engine)

**Files:**
- Modify: `web/src/sync/replicaSync.ts`
- Test: `web/src/sync/replicaSync.test.ts`

**Interfaces:**
- Produces:
  - `ReplicaState` gains `{ mode: "stalled"; error: string }`.
  - `ReplicaSync` gains `resetLocalData(opts: { discardPending: boolean }): Promise<void>` which throws `ResetBlockedError` (exported class with `pending: number`) when the flush fails and `discardPending` is false.
  - Constants exported for tests: `STALL_AFTER_FAILURES = 3`, `PENDING_CHANGED_CAP = 20`, `RETRY_BASE_MS = 1000`, `RETRY_MAX_MS = 60000`.

- [ ] **Step 1: Write failing tests**

Add to `replicaSync.test.ts` (its existing style builds fake `replica`/`fetchJson` deps):

```typescript
it("reports stalled after 3 consecutive failed pulls and retries with backoff", async () => {
  vi.useFakeTimers();
  const states: ReplicaState[] = [];
  const sync = createReplicaSync({ ...deps, onState: (s) => states.push(s),
    fetchJson: failingChangesFetch() });          // /changes rejects
  await sync.start();                              // pull 1 fails
  await vi.advanceTimersByTimeAsync(1000);         // retry 2 fails
  await vi.advanceTimersByTimeAsync(2000);         // retry 3 fails
  expect(states.at(-1)).toEqual({ mode: "stalled", error: expect.any(String) });
  await vi.advanceTimersByTimeAsync(4000);         // retry 4 also fails, stays stalled
  expect(states.filter((s) => s.mode === "stalled").length).toBeGreaterThan(0);
});

it("a successful pull clears the stall and resets the backoff", async () => { /* flip fetch to succeed, expect mode ready */ });

it("caps pending-changed retries per pull", async () => {
  // replica.applyChanges always returns {status: "pending-changed"};
  // the pull must give up after PENDING_CHANGED_CAP iterations (counts as a failure)
});

it("resetLocalData flushes, resets and bootstraps", async () => {
  // pendingBatches -> one batch; expect POST /api/ops then GET /api/sync/snapshot,
  // commitRecovery called with kind "reset", state ends "ready"
});

it("resetLocalData without discardPending surfaces a blocked reset when flush fails", async () => {
  // POST /api/ops rejects -> expect ResetBlockedError with pending === 1,
  // replica.abortRecovery called, no snapshot fetched
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd web && pnpm vitest run src/sync/replicaSync.test.ts`

- [ ] **Step 3: Implement**

In `createReplicaSync`:

```typescript
let consecutiveFailures = 0;
let retryDelay = RETRY_BASE_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

const noteSuccess = (): void => {
  consecutiveFailures = 0;
  retryDelay = RETRY_BASE_MS;
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  onState({ mode: "ready" });   // clears a previous stalled report
};

const noteFailure = (error: unknown): void => {
  consecutiveFailures += 1;
  if (consecutiveFailures >= STALL_AFTER_FAILURES) {
    onState({ mode: "stalled", error: errText(error) });
  }
  if (retryTimer === null) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void pull();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }
};
```

- `pullLoop`: count `pending-changed` continues; after `PENDING_CHANGED_CAP` iterations throw `new Error("pull starved: pending batches kept changing")`.
- `pull()`: replace `.catch(() => undefined)` with `.then(() => noteSuccess(), (e) => noteFailure(e))`. Only call `noteSuccess` when the loop actually completed (it returns normally). A `needs-bootstrap` recovery failure inside `pullLoop` (recover → false) must also `noteFailure` — have `pullLoop` throw in that branch instead of returning silently (preserve the poison-repair early return, which is owned elsewhere and must stay silent).
- `resetLocalData`: mirror `runRecovery` with a flush-phase marker:

```typescript
export class ResetBlockedError extends Error {
  constructor(readonly pending: number) { super("unsent changes not delivered"); }
}

async resetLocalData({ discardPending }) {
  queue.pause("recovery");
  let token: string | null = null;
  try {
    const lease = await replica.prepareRecovery();
    token = lease.token;
    if (!discardPending) {
      try {
        await flushBatches([...lease.batches], () => undefined);
      } catch {
        throw new ResetBlockedError(
          lease.batches.filter((b) => !b.poisoned).length);
      }
    }
    const snapshot = (await fetchJson("/api/sync/snapshot")) as Snapshot;
    await replica.commitRecovery(token, { kind: "reset", snapshot });
    token = null;
    cursor = snapshot.seq;
    noteSuccess();
  } catch (error: unknown) {
    if (token !== null) {
      try { await replica.abortRecovery(token); } catch { /* released */ }
    }
    throw error;
  } finally {
    queue.resume("recovery");
  }
}
```

Keep the file's Imperative Shell header and existing recovery paths untouched otherwise.

- [ ] **Step 4: Run suite**

Run: `cd web && pnpm vitest run src/sync/replicaSync.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/replicaSync.ts web/src/sync/replicaSync.test.ts .beans/pkm-80ds-*.md
git commit -m "fix(pkm-80ds): detect stalled replica pulls, retry with backoff, add resetLocalData"
```

---

### Task 7: syncState models the replica-stalled problem (Fix A, policy core)

**Files:**
- Modify: `web/src/sync/syncState.ts`
- Test: `web/src/sync/syncState.test.ts`

**Interfaces:**
- Produces:
  - `SyncProblem` union gains `{ kind: "replica-stalled"; error: string; reset: "idle" | "running" | "blocked" | "failed"; pending?: number; resetError?: string }`.
  - `SyncEvent` gains: `{ type: "replica-stalled"; error: string }`, `{ type: "replica-unstalled" }`, `{ type: "reset-started" }`, `{ type: "reset-blocked"; pending: number }`, `{ type: "reset-failed"; error: string }`, `{ type: "reset-succeeded" }`.
  - `computeEditability` gains a stalled read-only reason for the offline case: `"local data is stale — reset local data to recover"` (connected editing stays allowed; server-authoritative).

- [ ] **Step 1: Write failing tests** covering: stalled event sets the problem (reset "idle"); unstalled clears it only when kind is replica-stalled; reset-started → "running"; reset-blocked carries pending; reset-failed carries resetError; reset-succeeded clears the problem and emits `bump-resync`; a rejected-batch problem is never clobbered by replica-stalled (delivery problems win — return the state unchanged if `state.problem` exists with a different kind).

- [ ] **Step 2: Run to verify failure** — `cd web && pnpm vitest run src/sync/syncState.test.ts`

- [ ] **Step 3: Implement** the union/event/transition cases in `transitionSync` (pure, mirrors existing case style) and the `computeEditability` branch:

```typescript
    : replicaMode === "stalled"
      ? "local data is stale — reset local data to recover"
```

- [ ] **Step 4: Run suite** — `pnpm vitest run src/sync/syncState.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/syncState.ts web/src/sync/syncState.test.ts
git commit -m "fix(pkm-80ds): model replica-stalled problem lifecycle in syncState"
```

---

### Task 8: SyncProvider wires stall state to the problem banner and reset action (Fix A, shell)

**Files:**
- Modify: `web/src/sync/SyncProvider.tsx`
- Test: `web/src/sync/SyncProvider.test.tsx`

**Interfaces:**
- Consumes: Task 6's `resetLocalData`/`ResetBlockedError`, Task 7's events.
- Produces: `useSync()` context gains `resetReplica(discardPending?: boolean): Promise<void>`; replica state transitions dispatch `replica-stalled`/`replica-unstalled`; `recovery-failed` while `status === "connected"` also dispatches `replica-stalled` (same banner, error text from the state).

- [ ] **Step 1: Write failing tests** in `SyncProvider.test.tsx` (existing harness fakes replica + socket): stalled onState → context problem kind replica-stalled; `resetReplica()` calls through and dispatches reset-started/succeeded (problem clears, resync bumped); `ResetBlockedError` → problem reset:"blocked" with pending; `resetReplica(true)` after blocked passes `discardPending: true`.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/sync/SyncProvider.test.tsx`

- [ ] **Step 3: Implement.** In the `onState` handler (around line 237) dispatch the new events based on `next.mode` (stalled → `replica-stalled`; ready → `replica-unstalled`; recovery-failed + connected → `replica-stalled`). Add:

```typescript
const resetReplica = useCallback(async (discardPending = false) => {
  dispatchSync({ type: "reset-started" });
  try {
    await replicaSyncRef.current?.resetLocalData({ discardPending });
    dispatchSync({ type: "reset-succeeded" });
  } catch (e: unknown) {
    if (e instanceof ResetBlockedError) {
      dispatchSync({ type: "reset-blocked", pending: e.pending });
    } else {
      dispatchSync({ type: "reset-failed", error: String(e) });
    }
  }
}, []);
```

(Adapt names to the provider's actual dispatch helper — it executes `transitionSync` results and runs `bump-resync` effects; follow the existing pattern used by `repair-started`/`repair-succeeded`.) Expose `resetReplica` through the context value and its type (`SyncApi` or equivalent interface near line 40).

- [ ] **Step 4: Run suite** — `pnpm vitest run src/sync/SyncProvider.test.tsx && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/SyncProvider.tsx web/src/sync/SyncProvider.test.tsx
git commit -m "fix(pkm-80ds): surface replica stall through SyncProvider with reset action"
```

---

### Task 9: Banner UI, full verification, wrap-up (Fix A, UI + ship gate)

**Files:**
- Modify: `web/src/components/OfflineIndicator.tsx`
- Test: `web/src/components/OfflineIndicator.test.tsx` (create if absent — check for an existing test file first)
- Modify: `.beans/pkm-80ds-*.md`, `.beans/pkm-8uld-*.md`

**Interfaces:**
- Consumes: `useSync().problem` (kind "replica-stalled") and `useSync().resetReplica`.

- [ ] **Step 1: Write failing component tests**: stalled problem renders an alert containing "Local sync is stuck" and a "Reset local data" button; clicking calls `resetReplica(false)`; `reset: "blocked"` renders "N unsent change(s) could not be delivered" with "Discard and reset" (calls `resetReplica(true)`) and "Keep waiting" (dismiss); `reset: "running"` disables the button.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/components/OfflineIndicator.test.tsx`

- [ ] **Step 3: Implement** a new branch in the `deliveryProblem` chain (before the rejected-batch fallback), reusing `.ws-banner`:

```tsx
    : problem.kind === "replica-stalled" ? (
      <div className="ws-banner" role="alert">
        {problem.reset === "blocked" ? (
          <>{problem.pending} unsent change{problem.pending === 1 ? "" : "s"} could
            not be delivered.{" "}
            <button type="button" onClick={() => { void resetReplica(true); }}>
              Discard and reset
            </button>
            <button type="button" onClick={dismissProblem}>Keep waiting</button>
          </>
        ) : (
          <>Local sync is stuck: {problem.error}{" "}
            {problem.reset === "failed" && <>Reset failed: {problem.resetError}.{" "}</>}
            <button type="button" disabled={problem.reset === "running"}
                    onClick={() => { void resetReplica(false); }}>
              Reset local data
            </button>
          </>
        )}
      </div>
    )
```

- [ ] **Step 4: Full verification, both stacks**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Run: `cd web && pnpm verify` (build first if E2E needs `web/dist`)
Expected: all green, warning-free.

- [ ] **Step 5: Commit and close beans**

```bash
git add web/src/components/ .beans/
git commit -m "fix(pkm-80ds): replica-stalled banner with reset action"
```

Mark pkm-80ds completed (`## Summary of Changes`); update pkm-8uld's fix checkboxes; leave pkm-8uld open only if the cleanup-guard question (its last checkbox) is still undecided — note it as deferred with pkm-mly7.

---

## Self-review notes

- Spec coverage: Fix A → Tasks 6–9; Fix B → Tasks 1–2; Fix C → Tasks 3–5. Spec's "journal loaders map 404 → empty" is Task 5; "openapi regen" is Task 1 step 5; "failed-flush confirm" is Task 6 (`ResetBlockedError`) + Task 9 (blocked UI).
- Types used across tasks: `ReplicaState "stalled"` (Task 6) consumed in Task 7's `ReplicaMode` (derived type) and Task 8; `resetLocalData`/`ResetBlockedError` (Task 6) consumed in Task 8; `resetReplica` (Task 8) consumed in Task 9; `SyncProblem "replica-stalled"` field name `reset` used consistently in Tasks 7–9.
- Mock helper names in test steps (`mockFetchSequence`, `renderPageViewAt`, etc.) are illustrative; implementers must use each test file's existing harness utilities rather than invent parallel ones.
