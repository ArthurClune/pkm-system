# pkm-6phf Web Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five confirmed high-priority web defects of epic pkm-6phf — an op-queue fallback that bypasses queue policy, an assistant `New chat` that races a live turn, an ungated destructive key on read-only block selections, a closed phone nav drawer that stays tabbable, and two mouse-only headings.

**Architecture:** Each task is independent: they touch `web/src/sync/opQueue.ts`, `web/src/assistant/useAssistant.ts`, `web/src/components/EditableBlockTree.tsx`, `web/src/App.tsx` + `web/src/styles.css`, and `web/src/components/{PageTitle,UnlinkedSection}.tsx` respectively. Two carry real design weight: Task 1 replaces a direct `postOps()` escape hatch with an ordered in-memory lane that the existing `queueState` policy governs, and Task 2 introduces a turn-generation counter so a superseded assistant turn can never write to the new chat's state. The other three are localised gates, ARIA/CSS, and semantic-control changes.

**Tech Stack:** TypeScript, React 18.3, Vite, Vitest (jsdom + node environments), @testing-library/react, plain CSS in one `web/src/styles.css`, beans for issue tracking.

## Global Constraints

- **Workspace:** all work happens in the worktree `/Users/arthur/code/llm/pkm/.claude/worktrees/pkm-6phf-web-hardening` on branch `worktree-pkm-6phf-web-hardening`. Never read or write `/Users/arthur/code/llm/pkm` directly — the main checkout is a different branch. Run `git status -sb` before every commit and confirm the branch.
- **FCIS:** pure logic (calculations, validations, transformations) lives in Functional Core files; I/O (fetch, storage, DOM, clock, randomness) lives in thin Imperative Shell files. Every runtime file declares its pattern near the top — web files use `// pattern: Functional Core` or `// pattern: Imperative Shell`. Match each file's *existing* declaration; none of these tasks changes a file's classification.
- **TDD for every behaviour change:** write the failing test, run it and see it fail for the stated reason, write the minimal implementation, run it and see it pass, commit.
- **Per-task test commands:** unit tests `cd web && pnpm test:unit` (add `-t "<name>"` while iterating), typecheck `cd web && pnpm typecheck`. The full gate `cd web && pnpm verify` (typecheck + lint + FCIS check + coverage + build + Playwright) runs **once at branch end (Task 6)**, not per task.
- **Coverage is enforced** (`statements 95 / branches 91 / functions 89 / lines 95`). Every new branch needs a test that walks it.
- **jsdom limits:** `fireEvent.click` moves no focus (an explicit `el.focus()` does work, and `toHaveFocus()` is reliable); jsdom applies no stylesheet, so CSS-visibility and tab-order effects are asserted in `web/src/styles.test.ts` (node environment, reads `styles.css` as text), never by computed style; the op queue posts no `/api/ops` in jsdom component tests — component-level sync assertions use the `makeSync()` fake from `web/src/test-helpers.ts` (the "SyncFake" pattern, see `web/src/components/sections.test.tsx`).
- **`styles.test.ts` helper traps:** `ruleFor` returns only the first matching rule and collides on grouped selectors — use `rulesFor` when a class's declarations are split across rules; rules inside `@media` blocks are invisible to both, use `mediaRulesFor(query, selector)`.
- **Editor invariant:** any shortcut that mutates the focused block's text must ride the draft/key-edit path (`decideEditorKey` → `{ type: "key-edit" }`), never mutate the tree directly. No task here adds such a shortcut.
- **Reuse existing control classes and design tokens** (see `web/src/styles.css` and `docs/architecture/frontend.md` § *Two control families* / § *Focus and interactive affordances*) rather than inventing new looks. The one focus ring is `outline: 2px solid var(--color-link); outline-offset: 1px;`, declared per component next to that component's own rule.
- **Never use `window.confirm`** — the iPad PWA suppresses it; `useConfirm` (`web/src/components/ConfirmDialog.tsx`) is the in-app replacement.
- **E2E specs must not write today's journal.** No task here needs a new E2E spec; prefer unit/component tests.
- **Docs in the same task:** a task that changes a documented invariant updates `docs/architecture/frontend.md` (a11y/focus/editor/assistant) or `docs/architecture/sync-and-offline.md` (Task 1) in that same task and commit. Verify claims against the code, not against the bean.
- **Every task ends with one commit containing code, tests, docs and the bean file**, using the bean id in the subject (`fix(pkm-rckh): …`). In the bean file: check off every `- [ ]` checklist item, set `status: completed`, bump `updated_at` to the commit time (UTC, `YYYY-MM-DDTHH:MM:SSZ`), and append a `## Summary of Changes` section describing what shipped (root cause, the change, and anything deliberately not done).

---

### Task 1: opQueue — ordered in-memory fallback lane (bean pkm-49eh)

**Bean:** `.beans/pkm-49eh--opqueue-preserve-ordering-and-offline-edits-when-l.md`

**The confirmed defect.** `web/src/sync/opQueue.ts:444-469` — when `replica.enqueue(ops)` rejects with a *local-storage* failure (quota `ReplicaError`, OPFS access-handle contention, exhausted SAH pool), `persist()` calls `postOps(ops, newUid())` inline:

```ts
if (quotaExhausted || isSahPoolContention(error) || isPoolExhausted(error)) {
  if (quotaExhausted) quota.emit(error);
  try {
    await postOps(ops, newUid());
    resolveDelivery({ status: "delivered" });
  } catch (deliveryError: unknown) {
    resolveDelivery({ status: "failed", error: deliveryError });
  }
}
```

Four consequences, all real: offline it POSTs into a dead network and the ops are then neither persisted nor retryable (the ticket resolves `failed` and nothing retains them); it ignores `qstate.recovering`, so it can push ops past a poison-repair barrier; it never consults the retry/backoff policy, so one transient 5xx discards the edit; and it jumps the FIFO order, delivering a new op ahead of older durable rows it may depend on. A retry would also mint a *new* `batch_id` per attempt, breaking the server's `batch_id`→sha256(ops) idempotency binding.

**The design.** Keep the classification (a local-storage failure is *not* a server rejection, so `onDesync` must not fire and wipe the outline — pkm-c9hp, pkm-ndcu), but change the destination: the ops join an ordered in-memory **fallback lane** and are delivered only by `runDrain()`, under the same `queueState` policy as durable rows.

Ordering is the subtle part, because the lane and the durable queue interleave. Rows already in `pending_ops` when an entry is retained are *older* than that entry; rows persisted afterwards are *newer*. So each lane entry carries `durableAhead`: how many durable batches must be delivered before it.

- The first entry into an empty lane takes `durableAhead = await countPending()` (the durable backlog ahead of it, including rows from a previous page load).
- Later entries take `durableSinceFallback` — durable batches persisted since the previous entry was appended — which is then reset to 0.
- Each delivered durable batch decrements `fallback[0].durableAhead` (floor 0).
- `runDrain` posts `fallback[0]` before pulling another durable batch whenever its `durableAhead` is 0.
- When `replica.nextBatch()` returns `null`, nothing durable can still be ahead of anything, so every entry's `durableAhead` is clamped to 0. That is both the reconciliation for a `pendingCount` that was stale when read and the liveness guarantee: the loop can never spin waiting on a predecessor that will never arrive.

A lane entry's `batchId` is minted once, at append time, so a retry re-POSTs a byte-identical payload under the same id (mirroring `frozen` in the legacy queue, `opQueue.ts:516`). A 4xx on a lane entry has no durable row to poison, so it follows the legacy queue's terminal-4xx shape instead: discard exactly the rejected entry (the only discard the queue makes on its own — the bean's "explicit discard decision"), raise the recovery barrier so later entries cannot overtake the repair, and call `onDesync` so the authoritative repair runs. `pending` counts and `onPending` emissions include retained entries, so the header's "Offline — N changes pending" stops lying.

**Deliberately out of scope, and to be recorded in the bean's Summary:** the bean's direction also floats "freeze or clearly degrade editing when local durability is unavailable". Today `onQuota` → `SyncProvider`'s `quotaExhausted` → `computeEditability` already freezes the editor *offline* for quota exhaustion only (`web/src/sync/syncState.ts:62-81`). Extending that freeze to SAH contention and pool exhaustion is a user-visible product decision, and it now cuts the other way: with the lane in place those edits are retained and delivered, so freezing would remove function rather than prevent loss. Leave the existing quota freeze exactly as it is, note the trade-off in the bean, and let Arthur decide separately.

**Files:**
- Modify: `web/src/sync/opQueue.ts` (the `createReplicaQueue` function, lines 150-500; the legacy queue below it is untouched)
- Test: `web/src/sync/opQueue.replica.test.ts` (existing file, 27 tests; append the new ones)
- Modify: `docs/architecture/sync-and-offline.md:195-206`
- Modify: `.beans/pkm-49eh--opqueue-preserve-ordering-and-offline-edits-when-l.md`

**Line numbers below refer to `opQueue.ts` as it stands before this task's edits.** They drift as you apply the steps — locate each site by the quoted code, not by the number.

**Interfaces:**
- Consumes: `Replica` (`web/src/replica/client.ts:54-83`) — `enqueue(ops): Promise<{ pending: number; batchId?: string }>`, `nextBatch(): Promise<PendingBatch | null>`, `deleteBatch(id): Promise<{ pending: number }>`, `pendingCount(): Promise<number>`; `transitionQueue` / `terminalReason` / `QueueEvent` from `web/src/sync/queueState.ts`; `isSahPoolContention`, `isPoolExhausted`, `ReplicaError` (`.quota: boolean`).
- Produces: no change to the exported `OpQueue` interface, `WriteTicket`, `WriteOutcome`, `DeliveryOutcome` or `DrainOutcome` — every change is internal to `createReplicaQueue`. `DrainOutcome.pending` and `onPending(n)` now include retained in-memory entries as well as durable rows.
- New file-local type (not exported): `interface FallbackEntry { batchId: string; ops: BlockOp[]; durableAhead: number; resolve(outcome: DeliveryOutcome): void }`.

---

- [ ] **Step 1: Write the first two failing tests — retention while offline, and ordering behind older durable batches**

Append to `web/src/sync/opQueue.replica.test.ts`. `memReplica`, `fetchSeq`, `op` and `jsonResponse` are already defined at the top of that file; reuse them.

```ts
// --- pkm-49eh: an enqueue that cannot persist locally joins an ordered
// in-memory lane instead of being POSTed directly from enqueue(). ---

/** The exhausted-SAH-pool shape (pkm-ndcu): local storage is unavailable, and
 * that is never a server rejection. */
const CANTOPEN =
  "SQLITE_CANTOPEN: sqlite3 result code 14: unable to open database file";

test("an unpersistable enqueue is retained offline and delivered on reconnect",
async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica({
    enqueue: async () => { throw new Error(CANTOPEN); },
  });
  const desyncs: unknown[] = [];
  const q = createOpQueue(replica, (e) => desyncs.push(e));
  q.setOnline(false);

  const ticket = q.enqueue([op("u1")]);
  await expect(ticket.settled).resolves.toMatchObject({ status: "failed" });
  await q.settled();
  // offline: no direct post, and the op is retained rather than dropped
  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "offline", pending: 1,
  });
  expect(bodies).toEqual([]);
  expect(desyncs).toEqual([]);

  q.setOnline(true);
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect((bodies[0].body as { ops: unknown[] }).ops).toEqual([op("u1")]);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("a retained op stays behind the durable batches that preceded it",
async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);

  q.enqueue([op("first")]);          // durable row batch-1
  await q.settled();
  replica.enqueue = async () => { throw new Error(CANTOPEN); };
  const second = q.enqueue([op("second")]); // retained in memory
  await q.settled();

  q.setOnline(true);
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies.map((b) => (b.body as { ops: unknown[] }).ops))
    .toEqual([[op("first")], [op("second")]]);
  await expect(second.delivered).resolves.toEqual({ status: "delivered" });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd web && pnpm test:unit -t "retained"`
Expected: both FAIL. The first fails on `bodies` — the current code POSTs from `enqueue()` even while offline (and `ticket.delivered` rejects to `failed` with the network error rather than resolving `delivered` later). The second fails on POST order: the direct post of `second` lands before the durable `first`.

- [ ] **Step 3: Add the lane state and the pending-count helpers**

In `web/src/sync/opQueue.ts`, above `function createReplicaQueue` (after the `postOps` helper at line 148), add the entry type:

```ts
/** An enqueue whose ops could not be persisted locally (quota, OPFS
 * access-handle contention, exhausted SAH pool). Retained in FIFO order and
 * delivered by drain() under the same connectivity/retry/recovery policy as
 * durable rows — never POSTed from enqueue() (pkm-49eh). */
interface FallbackEntry {
  /** Minted once, at append time: a retry must re-POST a byte-identical
   * payload under the same id, since the server binds batch_id to a
   * sha256 of the ops. */
  batchId: string;
  ops: BlockOp[];
  /** Durable batches persisted BEFORE this entry that must be delivered
   * first; decremented as they drain, and cleared once the durable queue is
   * observed empty. */
  durableAhead: number;
  resolve(outcome: DeliveryOutcome): void;
}
```

Then inside `createReplicaQueue`, immediately after the `unidentifiedDeliveries` declaration (line 168-171), add:

```ts
  const fallback: FallbackEntry[] = [];
  // Durable batches persisted since the last fallback entry was appended:
  // they sit BEHIND that entry and must not overtake it.
  let durableSinceFallback = 0;

  /** Durable rows plus retained in-memory entries: what the UI must show as
   * "changes pending", and what a blocked drain reports. */
  const totalPending = (): number => pendingCount + fallback.length;
  const emitPending = (): void => { pending.emit(totalPending()); };
```

- [ ] **Step 4: Make every pending report include retained entries**

Still in `createReplicaQueue`, replace the three `pending.emit(pendingCount)` call sites with `emitPending()`: in `markRetainedPoison` (line 278), in `runDrain` after `pending emit` on a delivered durable batch (line 351), and in `persist`'s success path (line 441).

Then rewrite `blocked` and `failed` (lines 232-246) so their `pending` field is the total:

```ts
  const blocked = async (
    reason: "offline" | "retryable" | "recovering" | "disposed",
    error?: unknown,
  ): Promise<DrainOutcome> => {
    await countPending();
    return {
      status: "blocked",
      reason,
      pending: totalPending(),
      ...(error === undefined ? {} : { error }),
    };
  };

  const failed = async (error: unknown): Promise<DrainOutcome> => {
    await countPending();
    const transition = dispatch({ type: "delivery-failed" });
    return {
      status: "blocked", reason: transition.blockedReason!,
      pending: totalPending(), error,
    };
  };
```

- [ ] **Step 5: Route an unpersistable enqueue into the lane instead of a direct POST**

In `persist`, in the success branch, right after `pendingCount = result.pending;` (line 428) add the behind-the-lane counter:

```ts
          if (fallback.length > 0) durableSinceFallback += 1;
```

Then replace the whole `if (quotaExhausted || isSahPoolContention(error) || isPoolExhausted(error)) { … }` body (lines 456-464) with:

```ts
          if (quotaExhausted || isSahPoolContention(error)
              || isPoolExhausted(error)) {
            if (quotaExhausted) quota.emit(error);
            if (qstate.disposed) {
              resolveDelivery({
                status: "failed", error: new Error("op queue disposed"),
              });
              return;
            }
            // Retain the ops in an ordered in-memory lane and let drain()
            // deliver them: that keeps offline state, backoff and the
            // recovery barrier in force, and keeps these ops behind the
            // durable batches that preceded them (pkm-49eh). countPending()
            // may read a count that a concurrent drain is about to shrink;
            // an over-count only delays this entry, and runDrain clears the
            // counters once it observes an empty durable queue.
            fallback.push({
              batchId: newUid(),
              ops,
              durableAhead: fallback.length === 0
                ? await countPending() : durableSinceFallback,
              resolve: resolveDelivery,
            });
            durableSinceFallback = 0;
            emitPending();
            kick();
          } else {
```

Update the long comment above that `if` (lines 446-455) so it no longer claims a direct post: keep the classification rationale (local storage is a cache, not the durability boundary; pkm-c9hp and pkm-ndcu are local failures, so `onDesync` — whose authoritative repair would wipe the active outline and detach the editor mid-keystroke — must not fire) and end it with "…so the ops are retained for ordered delivery by drain() rather than posted from here."

- [ ] **Step 6: Deliver the lane from runDrain, in order**

In `runDrain`, at the top of the `for (;;)` loop right after `drainAgain = false;` (line 295), insert the lane branch:

```ts
      const head = fallback[0];
      if (head !== undefined && head.durableAhead === 0) {
        try {
          await postOps(head.ops, head.batchId);
        } catch (error: unknown) {
          if (error instanceof ApiError && error.status >= 400
              && error.status < 500) {
            // No durable row exists to poison, so this mirrors the legacy
            // queue's terminal 4xx: discard exactly the rejected entry — the
            // only discard this queue makes on its own — hold later entries
            // behind the recovery barrier, and let onDesync run the
            // authoritative repair that resumes it.
            dispatch({ type: "pause" });
            fallback.shift();
            head.resolve({ status: "failed", error });
            try { onDesync(error); } catch { /* listener isolation */ }
            return blocked("recovering", error);
          }
          return failed(error);
        }
        fallback.shift();
        head.resolve({ status: "delivered" });
        emitPending();
        dispatch({ type: "batch-succeeded" });
        const laneBlock = terminalReason(qstate);
        if (laneBlock !== null) return blocked(laneBlock);
        continue;
      }
```

In the `batch === null` branch (lines 303-307), clamp the counters before deciding the drain is finished:

```ts
      if (batch === null) {
        pendingCount = 0;
        finishAllDeliveries({ status: "delivered" });
        // Nothing durable is left, so nothing can still be ahead of a
        // retained entry: clear counts a stale read left behind rather than
        // waiting on a predecessor that will never arrive.
        for (const entry of fallback) entry.durableAhead = 0;
        if (fallback.length > 0) continue;
        if (drainAgain) continue;
        return { status: "drained" };
      }
```

And after a durable batch is deleted, right after `finishObservedUnidentified({ status: "delivered" });` (line 345), decrement the head entry:

```ts
      if (fallback.length > 0 && fallback[0].durableAhead > 0) {
        fallback[0].durableAhead -= 1;
      }
```

- [ ] **Step 7: Settle retained entries on dispose, without dropping them from the count**

Replace the `dispose()` method body (lines 485-491) with:

```ts
    dispose() {
      if (qstate.disposed) return;
      dispatch({ type: "dispose" });
      const error = new Error("op queue disposed");
      finishAllDeliveries({ status: "failed", error });
      // Settle every retained entry, but keep the lane populated: exactly like
      // the durable row a disposed queue still reports, these ops belong in the
      // terminal pending diagnostic. Nothing can drain after dispose
      // (terminalReason short-circuits before the loop), so no entry can be
      // delivered or settled twice.
      for (const entry of fallback) entry.resolve({ status: "failed", error });
    },
```

- [ ] **Step 8: Run the two new tests plus the whole queue suite**

Run: `cd web && pnpm test:unit src/sync/opQueue.replica.test.ts src/sync/opQueue.test.ts src/sync/queueState.test.ts`
Expected: PASS, including the three pre-existing degradation tests ("quota-failed enqueue surfaces and degrades to a direct post", "an OPFS access-handle contention…", "an exhausted SAH pool…"). Those stay green because they drain while online, so the lane posts the same body with a defined `batch_id` and resolves `delivered`. If any of them fails, do **not** weaken it — the lane must produce exactly that observable POST.

- [ ] **Step 9: Rename the three pre-existing degradation tests to describe the new mechanism**

Their names still say "degrades to a direct post", which is now wrong. In `web/src/sync/opQueue.replica.test.ts` rename them and correct their comments:

- `"quota-failed enqueue surfaces and degrades to a direct post"` → `"quota-failed enqueue surfaces and is retained for ordered delivery"`; change the inline comment `// best-effort legacy post so the edit still lands while online` to `// retained in memory, then delivered by the drain under queue policy`.
- `"an OPFS access-handle contention enqueue failure degrades to a direct post"` → `"an OPFS access-handle contention enqueue failure is retained, not desynced"`.
- `"an exhausted SAH pool enqueue failure degrades to a direct post"` → `"an exhausted SAH pool enqueue failure is retained, not desynced"`.

In the latter two, the sentence "the edit must still be delivered online" stays true; append "— through the drain, so it cannot overtake older batches or ignore backoff".

Run: `cd web && pnpm test:unit src/sync/opQueue.replica.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing tests for the remaining policy paths**

Append to `web/src/sync/opQueue.replica.test.ts`:

```ts
test("a durable batch persisted after a retained op cannot overtake it",
async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const durableEnqueue = replica.enqueue.bind(replica);
  replica.enqueue = async () => { throw new Error(CANTOPEN); };
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);

  const retained = q.enqueue([op("older")]);
  await q.settled();
  replica.enqueue = durableEnqueue;      // local storage recovers
  q.enqueue([op("newer")]);
  await q.settled();

  q.setOnline(true);
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies.map((b) => (b.body as { ops: unknown[] }).ops))
    .toEqual([[op("older")], [op("newer")]]);
  await expect(retained.delivered).resolves.toEqual({ status: "delivered" });
});

test("a 5xx keeps the retained op under the same batch id and the backoff retry delivers it",
async () => {
  vi.useFakeTimers();
  try {
    const { bodies } = fetchSeq([
      () => jsonResponse({ detail: "busy" }, 503),
      () => jsonResponse({ ok: true }),
    ]);
    const replica = memReplica({
      enqueue: async () => { throw new Error(CANTOPEN); },
    });
    const q = createOpQueue(replica, () => undefined);
    const ticket = q.enqueue([op("u1")]);
    await q.settled();

    await expect(q.drain()).resolves.toMatchObject({
      status: "blocked", reason: "retryable", pending: 1,
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(q.drain()).resolves.toEqual({ status: "drained" });
    await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
    // one id for both attempts: the server binds batch_id to sha256(ops)
    const ids = bodies.map((b) => (b.body as { batch_id: string }).batch_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  } finally {
    vi.useRealTimers();
  }
});

test("a 4xx discards only the rejected retained op and holds the rest behind repair",
async () => {
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const replica = memReplica({
    enqueue: async () => { throw new Error(CANTOPEN); },
  });
  const desyncs: unknown[] = [];
  const q = createOpQueue(replica, (e) => desyncs.push(e));
  const bad = q.enqueue([op("bad")]);
  const good = q.enqueue([op("good")]);
  await q.settled();

  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering", pending: 1,
  });
  await expect(bad.delivered).resolves.toMatchObject({ status: "failed" });
  expect(desyncs).toHaveLength(1);
  expect(bodies).toHaveLength(1); // the good op waits for the repair

  q.resume("recovery");
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  await expect(good.delivered).resolves.toEqual({ status: "delivered" });
});

test("a retained op still delivers when the durable count it queued behind was stale",
async () => {
  // countPending() can read a backlog a concurrent drain is already clearing.
  // An over-count only delays the entry, and the clamp on an observed-empty
  // durable queue is what guarantees it still goes out.
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica({
    enqueue: async () => { throw new Error(CANTOPEN); },
    pendingCount: async () => 3,   // no rows exist, but the count claims three
  });
  const q = createOpQueue(replica, () => undefined);
  const ticket = q.enqueue([op("u1")]);
  await q.settled();
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies).toHaveLength(1);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("an enqueue that fails after dispose settles instead of hanging", async () => {
  fetchSeq([() => jsonResponse({ ok: true })]);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const replica = memReplica({
    enqueue: async () => { await gate; throw new Error(CANTOPEN); },
  });
  const q = createOpQueue(replica, () => undefined);
  const ticket = q.enqueue([op("u1")]);
  q.dispose();          // teardown races a write that is already in flight
  release();
  await expect(ticket.settled).resolves.toMatchObject({ status: "failed" });
  // retaining it would leave `delivered` pending forever: dispose has already
  // run, so nothing else would ever settle this entry
  await expect(ticket.delivered).resolves.toMatchObject({ status: "failed" });
});

test("retained ops count as pending and are failed exactly once by dispose",
async () => {
  fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica({
    enqueue: async () => { throw new Error(CANTOPEN); },
  });
  const q = createOpQueue(replica, () => undefined);
  const counts: number[] = [];
  q.onPending((n) => counts.push(n));
  q.setOnline(false);
  const ticket = q.enqueue([op("u1")]);
  await q.settled();
  expect(counts.at(-1)).toBe(1); // the header must not report 0 pending

  let outcomes = 0;
  void ticket.delivered.then(() => { outcomes += 1; });
  q.dispose();
  await expect(ticket.delivered).resolves.toMatchObject({ status: "failed" });
  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "disposed", pending: 1,
  });
  expect(outcomes).toBe(1);
});
```

- [ ] **Step 11: Run them**

Run: `cd web && pnpm test:unit src/sync/opQueue.replica.test.ts`
Expected: PASS — Steps 3-7 already implement every path these cover. If the 4xx test reports `reason: "retryable"` instead of `"recovering"`, the `dispatch({ type: "pause" })` in the lane's 4xx branch is missing or placed after `blocked()`; if the retry test shows two different `batch_id`s, `batchId` is being minted at post time rather than at append time; if the stale-count test times out, the `durableAhead` clamp in the `batch === null` branch is missing and the drain is spinning.

- [ ] **Step 12: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors. `head` is narrowed by `head !== undefined` so `noUncheckedIndexedAccess`-style complaints about `fallback[0]` do not apply to it; the later `fallback[0].durableAhead` accesses are guarded by `fallback.length > 0`.

- [ ] **Step 13: Update the sync-and-offline architecture doc**

In `docs/architecture/sync-and-offline.md`, replace the paragraph at lines 195-206 (it begins "Both failures can hit an *enqueue*, and there `opQueue` treats them like quota exhaustion") with:

```markdown
Both failures can hit an *enqueue*, and there `opQueue` treats them like quota
exhaustion: "cannot persist locally right now" is not a server rejection, so
firing `onDesync` — whose authoritative repair would wipe the active outline
back to the edit-less server state and detach the editor mid-keystroke — is
the wrong answer. Instead the ops join an **ordered in-memory fallback lane**
(pkm-49eh) and are delivered by the ordinary drain, so they stay under the
same connectivity, backoff and recovery-barrier policy as durable rows. Each
entry records how many durable batches were queued ahead of it and is posted
only once those have drained, so a retained op can neither overtake an older
batch nor be overtaken by a newer one; its `batch_id` is minted once so a
retry re-POSTs a byte-identical payload; it counts towards "N changes
pending"; and it is retained until it is delivered, the server rejects it with
a 4xx (the one discard the queue makes on its own, which raises the repair
barrier and calls `onDesync`), or the queue is disposed. Before pkm-49eh these
ops were POSTed inline from `enqueue()`, which offline meant they were neither
persisted nor retryable. Worth knowing because the pre-fix symptom of the
*classification* half was a **"Server rejected a change"** banner, which reads
like a server-side rejection or a `resyncSeq` bug and cost a misdirected
investigation: when that banner appears, check the storage layer first. The
classifier is a deny-nothing whitelist, so any *new* local-storage error shape
reintroduces the wipe — extend it rather than adding another symptom fix.
```

Leave the "Offline editing and reconnect" mermaid sequence alone: it describes the durable-row pump and stays correct.

- [ ] **Step 14: Run the full unit suite (the queue is load-bearing for sync tests)**

Run: `cd web && pnpm test:unit`
Expected: PASS. `SyncProvider.test.tsx` and `replicaSync.test.ts` exercise the queue heavily; a failure there means a pending-count or drain-outcome shape changed for durable-only flows, which this task must not do.

- [ ] **Step 15: Commit code, docs and bean together**

Update `.beans/pkm-49eh--opqueue-preserve-ordering-and-offline-edits-when-l.md`: tick both checklist items, `status: completed`, bump `updated_at`, and add a `## Summary of Changes` covering the four consequences of the old direct post, the `durableAhead` ordering rule and its empty-queue clamp, the once-minted `batch_id`, the 4xx-discard-plus-barrier decision, and the explicit non-goal (extending the offline editor freeze beyond quota — see the reasoning above).

```bash
cd /Users/arthur/code/llm/pkm/.claude/worktrees/pkm-6phf-web-hardening
git status -sb   # confirm worktree-pkm-6phf-web-hardening
git add web/src/sync/opQueue.ts web/src/sync/opQueue.replica.test.ts \
        docs/architecture/sync-and-offline.md \
        .beans/pkm-49eh--opqueue-preserve-ordering-and-offline-edits-when-l.md
git commit -m "fix(pkm-49eh): deliver unpersistable ops through an ordered fallback lane"
```

---

### Task 2: assistant — supersede the active turn on New chat (bean pkm-6ts2)

**Bean:** `.beans/pkm-6ts2--assistant-prevent-new-chat-from-racing-an-active-t.md`

**The confirmed defect.** `web/src/assistant/useAssistant.ts:212-227` — `newChat()` clears `items`, `error`, `status`, `pendingConfirm`, `modelLocked` and `conversationId.current`, then awaits `deleteConversation(id)`. It never aborts the in-flight turn. The live `streamMessage` keeps calling `applyEvent`, so old `text_delta`/`tool_started` events repopulate the *new* transcript and an old `confirm_request` re-raises a card for a dead conversation; `send`'s `finally` (lines 173-176) later resets a newer turn to idle and clears a newer `pendingConfirm`; `runTurn`'s `finally` (line 151) unconditionally sets `abortController.current = null`, discarding a newer turn's controller so `stop()` becomes a no-op; and if `createConversation` (line 134-137) is still in flight when `newChat` runs, its resolution writes the *old* id back into `conversationId.current`, so the "new" chat silently continues the old conversation.

**The design.** A `turnGen` ref counts turn generations. `send` takes the next generation; `newChat` bumps it, which supersedes everything already running. Every state write that happens after an await is guarded by `gen === turnGen.current`, the per-event callback drops events from superseded turns, and `runTurn`'s controller cleanup is identity-checked (`abortController.current === controller`). `newChat` clears state synchronously first (instant feedback, safe because the generation guard blocks late writes), then aborts and awaits the superseded turn before deleting the conversation server-side, so the server has seen the dropped connection and the old turn's finalizers have all run before `newChat` resolves. A conversation created by a superseded turn is closed rather than leaked.

`AssistantPanel.tsx:100-102` (the `New chat` button, `onClick={() => void assistant.newChat()}`) needs **no change**: the race is fixed in the hook, and disabling the button until Stop completes — the bean's alternative — would be a worse trade (the user's escape hatch stops working exactly when a turn is stuck). Note that it calls `newChat()` fire-and-forget, which is why the state clear must be synchronous rather than deferred until after the abort round-trip; a hook test below pins that ordering. `AssistantPanel.test.tsx` cannot host an integration test for this — it mocks `./useAssistant` wholesale (`vi.mock("./useAssistant", …)` at line 23), and the button→`newChat()` wiring it *can* test is already covered at line 76. All new tests therefore go in `useAssistant.test.tsx`.

**Files:**
- Modify: `web/src/assistant/useAssistant.ts:132-227`
- Test: `web/src/assistant/useAssistant.test.tsx` (existing `Harness` + `mocks` pattern)
- Modify: `docs/architecture/frontend.md` § *The assistant panel*
- Modify: `.beans/pkm-6ts2--assistant-prevent-new-chat-from-racing-an-active-t.md`

**Interfaces:**
- Consumes: `createConversation(model)`, `deleteConversation(id)`, `confirmTool(id, toolUseId, allow)`, `streamMessage(id, text, onEvent, signal)` from `web/src/assistant/client.ts`; `AssistantEvent` from `./sse`.
- Produces: `useAssistant()`'s returned shape is unchanged — `{ items, status, error, model, setModel, modelLocked, pendingConfirm, send, stop, respondConfirm, newChat }`. `runTurn`'s signature becomes `runTurn(text: string, allowRetry: boolean, gen: number): Promise<void>` (file-local).

---

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("useAssistant", …)` block in `web/src/assistant/useAssistant.test.tsx`:

```ts
  test("newChat aborts the live turn; its late events never reach the new chat", async () => {
    // pkm-6ts2
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    let emit!: (ev: AssistantEvent) => void;
    let capturedSignal: AbortSignal | undefined;
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void,
             signal?: AbortSignal) => {
        emit = onEvent;
        capturedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")));
        });
      },
    );
    render(<Harness />);
    await act(async () => {
      void latest.send("hi");
      await Promise.resolve();
    });
    act(() => emit({ type: "text_delta", text: "half a repl" }));
    expect(latest.items).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "half a repl" },
    ]);
    expect(latest.status).toBe("busy");

    await act(() => latest.newChat());
    expect(capturedSignal?.aborted).toBe(true);
    expect(mocks.deleteConversation).toHaveBeenCalledWith("c1");
    expect(latest.items).toEqual([]);
    expect(latest.status).toBe("idle");
    expect(latest.error).toBeNull();
    expect(latest.modelLocked).toBe(false);

    // the superseded turn is still holding onEvent: nothing it emits now may
    // land in the fresh transcript
    act(() => {
      emit({ type: "text_delta", text: "y from the dead turn" });
      emit({ type: "confirm_request", tool_use_id: "t9", ops_preview: "x" });
      emit({ type: "error", message: "stale boom" });
    });
    expect(latest.items).toEqual([]);
    expect(latest.pendingConfirm).toBeNull();
    expect(latest.error).toBeNull();
    expect(latest.status).toBe("idle");
  });

  test("a superseded turn's abort is not reported as an error", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, _onEvent: unknown,
             signal?: AbortSignal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")));
        });
      },
    );
    render(<Harness />);
    await act(async () => {
      void latest.send("hi");
      await Promise.resolve();
    });
    // no latest.stop(): stopRequested stays false, so only the generation
    // guard can keep this abort out of `error`
    await act(() => latest.newChat());
    expect(latest.error).toBeNull();
    expect(latest.status).toBe("idle");
  });

  test("newChat keeps a newer turn's controller and stays stoppable", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    const signals: AbortSignal[] = [];
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, _onEvent: unknown,
             signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")));
        });
      },
    );
    render(<Harness />);
    await act(async () => {
      void latest.send("first");
      await Promise.resolve();
    });
    await act(() => latest.newChat());
    let secondDone!: Promise<void>;
    await act(async () => {
      secondDone = latest.send("second");
      await Promise.resolve();
    });
    expect(latest.status).toBe("busy");
    await act(async () => {
      latest.stop();
      await secondDone;
    });
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(true);   // the newer turn really stopped
    expect(latest.status).toBe("idle");
    expect(latest.error).toBeNull();
  });

  test("a conversation created by a superseded turn is closed, not adopted", async () => {
    const created = deferredValue<{ id: string; model: string }>();
    mocks.createConversation.mockReturnValue(created.promise);
    mocks.deleteConversation.mockResolvedValue(undefined);
    feed([{ type: "turn_done", usage: null }]);
    render(<Harness />);
    await act(async () => {
      void latest.send("hi");
      await Promise.resolve();
    });
    // the turn is still inside createConversation: there is no stream to abort
    // and no id to delete yet, and newChat must not block on it
    await act(() => latest.newChat());
    await act(async () => { created.resolve({ id: "c1", model: "sonnet" }); });
    await vi.waitFor(() =>
      expect(mocks.deleteConversation).toHaveBeenCalledWith("c1"));
    expect(mocks.streamMessage).not.toHaveBeenCalled();

    // the next send must create a fresh conversation, not reuse c1
    mocks.createConversation.mockReset();
    mocks.createConversation.mockResolvedValue({ id: "c2", model: "sonnet" });
    await act(() => latest.send("again"));
    expect(mocks.streamMessage.mock.calls[0][0]).toBe("c2");
  });

  test("newChat clears the transcript synchronously, as the panel's click does", async () => {
    // AssistantPanel calls `void assistant.newChat()` (AssistantPanel.tsx:100),
    // so an empty chat must appear on the click -- not after the abort has
    // unwound and the DELETE has resolved.
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    const deletion = deferredValue<void>();
    mocks.deleteConversation.mockReturnValue(deletion.promise);
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void,
             signal?: AbortSignal) => {
        onEvent({ type: "text_delta", text: "partial" });
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")));
        });
      },
    );
    render(<Harness />);
    await act(async () => {
      void latest.send("hi");
      await Promise.resolve();
    });
    expect(latest.items).toHaveLength(2);

    let reset!: Promise<void>;
    act(() => { reset = latest.newChat(); });
    expect(latest.items).toEqual([]);       // before any await settles
    expect(latest.status).toBe("idle");
    expect(latest.modelLocked).toBe(false);

    await act(async () => {
      deletion.resolve();
      await reset;
    });
    expect(mocks.deleteConversation).toHaveBeenCalledWith("c1");
  });

  test("respondConfirm from a superseded turn cannot clobber the new chat", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void,
             signal?: AbortSignal) => {
        onEvent({ type: "confirm_request", tool_use_id: "t1", ops_preview: "save_note(...)" });
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")));
        });
      },
    );
    const confirmCall = deferredValue<void>();
    mocks.confirmTool.mockReturnValue(confirmCall.promise);
    render(<Harness />);
    await act(async () => {
      void latest.send("please write");
      await Promise.resolve();
    });
    expect(latest.status).toBe("confirm");

    let answering!: Promise<void>;
    act(() => { answering = latest.respondConfirm(true); });
    await act(() => latest.newChat());
    await act(async () => {
      confirmCall.reject(new ApiError(404, "/api/assistant/conversations/c1/confirm"));
      await answering;
    });
    // the 404 branch resets conversationId and sets an explanatory error;
    // neither may touch the chat that replaced it
    expect(latest.error).toBeNull();
    expect(latest.pendingConfirm).toBeNull();
    expect(latest.status).toBe("idle");
  });
```

Add this helper next to the existing `feed` function at the top of the file (it needs a rejectable deferred, which `feed` does not provide):

```ts
function deferredValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd web && pnpm test:unit src/assistant/useAssistant.test.tsx`
Expected: the six new tests FAIL. The first on `capturedSignal?.aborted` being `false` (newChat never aborts) and then on `latest.items` containing the dead turn's delta; the controller test fails because `runTurn`'s `finally` nulled the newer controller so `stop()` aborts nothing; the created-conversation test fails because the superseded turn adopts `c1` and streams; the respondConfirm test fails on `latest.error` holding the expired-chat message. The synchronous-clear test may already pass — today's `newChat` clears before awaiting too — and it stays as the guard that Step 5 does not reorder that.

- [ ] **Step 3: Add the generation refs and thread `gen` through `runTurn`**

In `web/src/assistant/useAssistant.ts`, after `const stopRequested = useRef(false);` (line 76) add:

```ts
  // Turn generations (pkm-6ts2). send() takes the next generation; newChat()
  // bumps it to supersede whatever is running. Every state write that happens
  // after an await is gated on still being the current generation, so a
  // superseded turn's events and finalizers cannot touch the chat that
  // replaced it.
  const turnGen = useRef(0);
  const activeTurn = useRef<Promise<void> | null>(null);
```

Replace `runTurn` (lines 132-155) with:

```ts
  const runTurn = useCallback(
    async (text: string, allowRetry: boolean, gen: number): Promise<void> => {
      if (gen !== turnGen.current) return;
      if (conversationId.current === null) {
        const created = await createConversation(model);
        if (gen !== turnGen.current) {
          // newChat landed while the conversation was being created: adopting
          // the id here would make the "new" chat continue the old one, so
          // close it instead of leaking it until the server reaps it.
          try {
            await deleteConversation(created.id);
          } catch {
            // best effort; idle reaping cleans it up either way
          }
          return;
        }
        conversationId.current = created.id;
      }
      setModelLocked(true);
      const controller = new AbortController();
      abortController.current = controller;
      try {
        await streamWithBusyRetry(conversationId.current, text, (ev) => {
          // a superseded turn keeps streaming until its abort lands; its
          // events must never fold into the new transcript
          if (gen !== turnGen.current) return;
          applyEvent(ev);
        }, controller.signal);
      } catch (err) {
        if (allowRetry && err instanceof ApiError && err.status === 404
            && gen === turnGen.current) {
          conversationId.current = null;
          await runTurn(text, false, gen);
          return;
        }
        throw err;
      } finally {
        // identity check: a newer turn's controller must survive this cleanup,
        // or stop() would silently abort nothing
        if (abortController.current === controller) abortController.current = null;
      }
    },
    [applyEvent, model],
  );
```

- [ ] **Step 4: Gate `send`'s finalizers on the generation and publish the active turn**

Replace `send` (lines 157-179) with:

```ts
  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      turnGen.current += 1;
      const gen = turnGen.current;
      const current = () => gen === turnGen.current;
      setError(null);
      setStatus("busy");
      setItems((prev) => [...prev, { kind: "user", text }]);
      stopRequested.current = false;
      const run = (async () => {
        try {
          await runTurn(text, true, gen);
        } catch (err) {
          // pkm-c98s item 3: a user-requested Stop aborts the fetch, which
          // rejects with an AbortError -- that is success, not a failure to
          // report. A superseded turn's failure (pkm-6ts2) belongs to a chat
          // that no longer exists, so it is not reported either.
          if (current() && !(stopRequested.current && isAbortError(err))) {
            setError(friendlyMessage(err));
          }
        } finally {
          if (current()) {
            setPendingConfirm(null);
            setStatus("idle");
          }
        }
      })();
      activeTurn.current = run;
      try {
        await run;
      } finally {
        if (activeTurn.current === run) activeTurn.current = null;
      }
    },
    [runTurn],
  );
```

- [ ] **Step 5: Make `newChat` supersede, abort and await before deleting**

Replace `newChat` (lines 212-227) with:

```ts
  const newChat = useCallback(async () => {
    // Supersede first: from here on the running turn's events and finalizers
    // are ignored, which is what makes clearing the state below safe to do
    // immediately rather than after the abort round-trip (pkm-6ts2).
    turnGen.current += 1;
    const id = conversationId.current;
    const inflight = activeTurn.current;
    const controller = abortController.current;
    conversationId.current = null;
    abortController.current = null;
    activeTurn.current = null;
    setItems([]);
    setError(null);
    setStatus("idle");
    setPendingConfirm(null);
    setModelLocked(false);
    controller?.abort();
    // Await the aborted turn so the server has observed the dropped connection
    // (and that turn's finalizers have all run) before the DELETE. Only when a
    // stream actually existed: a turn still inside createConversation has no
    // connection to drop and no abort signal to cut it short, so waiting on it
    // could hang for as long as that request does — and it closes the
    // conversation it created itself, via the generation check in runTurn.
    if (controller && inflight) await inflight.catch(() => undefined);
    if (id !== null) {
      try {
        await deleteConversation(id);
      } catch {
        // server may have reaped it already; a fresh chat is the goal
      }
    }
  }, []);
```

- [ ] **Step 6: Gate `respondConfirm`'s post-await writes**

In `respondConfirm` (lines 186-210), capture the generation at entry and guard both branches of the catch:

```ts
  const respondConfirm = useCallback(
    async (allow: boolean) => {
      const gen = turnGen.current;
      const id = conversationId.current;
      const pending = pendingConfirm;
      if (id === null || pending === null) return;
      setPendingConfirm(null);
      setStatus("busy");
      try {
        await confirmTool(id, pending.toolUseId, allow);
      } catch (err) {
        // newChat superseded this decision: the conversation it belonged to is
        // gone, and neither the reset below nor an error banner may land on the
        // chat that replaced it (pkm-6ts2).
        if (gen !== turnGen.current) return;
        if (err instanceof ApiError && err.status === 404) {
          // reaped while waiting on the user's decision: no live turn to
          // resume, so start clean rather than resurrect a dead card
          conversationId.current = null;
          setStatus("idle");
          setError("This chat expired before you responded; send a new message to start a fresh one.");
          return;
        }
        setPendingConfirm(pending);
        setStatus("confirm");
        setError(friendlyMessage(err));
      }
    },
    [pendingConfirm],
  );
```

- [ ] **Step 7: Run the hook suite**

Run: `cd web && pnpm test:unit src/assistant/useAssistant.test.tsx`
Expected: PASS — all 6 new tests plus the 14 pre-existing ones ("newChat deletes and resets", "stop aborts the in-flight turn…", "send retries once after a 404…" and the busy-409 pair are the ones most likely to catch a mistake in the generation threading).

- [ ] **Step 8: Confirm the panel needs no change, and that its suite still passes**

`AssistantPanel.tsx` is unchanged by design (see the design note above). Its test file mocks `./useAssistant`, so it asserts only the wiring — which the existing test at `AssistantPanel.test.tsx:76-82` already covers: clicking `New chat` calls `newChat()`. Do not add an integration test there; it cannot see the real hook.

Run: `cd web && pnpm test:unit src/assistant/AssistantPanel.test.tsx`
Expected: PASS, unchanged.

- [ ] **Step 9: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Document the invariant**

In `docs/architecture/frontend.md` § *The assistant panel*, extend the first bullet (the one that ends "Conversations are ephemeral — a reload loses them.") with:

```markdown
  "New chat" is safe mid-turn: each turn carries a generation counter, and
  `newChat` bumps it before clearing state, so the superseded turn's SSE
  events and finalizers are dropped instead of refilling the fresh transcript,
  resetting its status or re-raising its confirm card (pkm-6ts2). It then
  aborts and awaits that turn before `DELETE`ing the conversation, and a
  conversation whose creation resolved after the bump is closed rather than
  adopted. Abort-controller cleanup is identity-checked, so a newer turn stays
  stoppable.
```

- [ ] **Step 11: Commit**

Update `.beans/pkm-6ts2--assistant-prevent-new-chat-from-racing-an-active-t.md` (tick both items, `status: completed`, bump `updated_at`, `## Summary of Changes`) — record the four distinct races found in the code, the generation scheme, and why `AssistantPanel` was left enabled rather than disabling `New chat` until Stop completes.

```bash
cd /Users/arthur/code/llm/pkm/.claude/worktrees/pkm-6phf-web-hardening
git status -sb
git add web/src/assistant/useAssistant.ts web/src/assistant/useAssistant.test.tsx \
        docs/architecture/frontend.md \
        .beans/pkm-6ts2--assistant-prevent-new-chat-from-racing-an-active-t.md
git commit -m "fix(pkm-6ts2): supersede the active assistant turn on New chat"
```

---

### Task 3: editor — gate multi-block selection deletion on !readOnly (bean pkm-rckh)

**Bean:** `.beans/pkm-rckh--editor-block-deletion-of-read-only-multi-block-sel.md`

**The confirmed defect.** `web/src/components/EditableBlockTree.tsx:149-186` is the tree container's selection keydown chain. Tab (line 152) and Shift+Cmd+Arrow (line 158) check `readOnly`; Backspace/Delete (lines 178-180) does not:

```ts
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      handlers.onDeleteBlockSelection();
    }
```

`useOutline`'s handler does not compensate — `web/src/outline/useOutline.ts:403-414` checks only that a selection exists, and while `useOutline` computes `readOnly: !sync.canEdit` (line 472) for its consumers, the delete handler never reads it. So a selection made while editable can be destroyed after sync flips the outline read-only (socket drop with no replica, quota exhaustion offline, a stalled replica).

**Where the decision belongs.** Not in `keyboardPolicy.ts`. `decideEditorKey` is the policy for *a focused block's textarea* — its `EditorKeyInput` is caret/draft/autocomplete state (`selStart`, `selEnd`, `draft`, `acRowsLength`) and its `KeyDecision` union has no selection-delete member. The selection chain runs on the tree container when there is no focused textarea at all, and it has no policy module today. Introducing one for a single boolean would be a speculative refactor; the right home is the component, next to the two neighbouring gates that already live there. Preserve the project keyboard invariant while doing it: selection *creation* and *copying* stay read-only-safe (Ctrl+Cmd+Arrow, Shift+Arrow, Cmd-C, Escape) — only destructive handling is gated.

**Files:**
- Modify: `web/src/components/EditableBlockTree.tsx:178-180`
- Test: `web/src/components/EditableBlockTree.test.tsx` (has `handlers()`, `BLOCKS`, `mountSelected` at line 925)
- Modify: `docs/architecture/frontend.md` § *The editor* (the "Keyboard policy is a pure function" bullet)
- Modify: `.beans/pkm-rckh--editor-block-deletion-of-read-only-multi-block-sel.md`

**Interfaces:**
- Consumes: `OutlineHandlers.onDeleteBlockSelection(): void` and the `readOnly: boolean` prop of `EditableBlockTree` (`TreeProps`, lines 94-103).
- Produces: no API change. `EditableBlockTree` simply stops calling `onDeleteBlockSelection` (and stops calling `preventDefault`) for Backspace/Delete while `readOnly`.

---

- [ ] **Step 1: Write the failing tests**

Append to `web/src/components/EditableBlockTree.test.tsx`, next to the existing `"Backspace/Delete on a selection deletes the whole group (pkm-q89w)"` test:

```ts
test("read-only Backspace/Delete cannot destroy a selection (pkm-rckh)", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" }, true);
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  // not handled: the event stays uncancelled, exactly like read-only
  // Shift+Cmd+Arrow above
  expect(fireEvent.keyDown(tree, { key: "Backspace" })).toBe(true);
  expect(fireEvent.keyDown(tree, { key: "Delete" })).toBe(true);
  expect(h.onDeleteBlockSelection).not.toHaveBeenCalled();
  // creating and copying a selection stay read-only-safe (pkm-am54)
  expect(fireEvent.keyDown(tree, {
    key: "ArrowDown", ctrlKey: true, metaKey: true,
  })).toBe(false);
  expect(h.onExtendBlockSelection).toHaveBeenCalledWith("down");
});

test("a selection made while editable is safe once sync turns the outline read-only (pkm-rckh)", () => {
  const h = handlers();
  const selection = { anchor: "u1", head: "u2" };
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={null} selection={selection}
                         handlers={h} readOnly={false} />
    </MemoryRouter>);
  const tree = view.container.querySelector(".block-tree") as HTMLDivElement;

  // the socket drops / storage fills: the same live selection is now read-only
  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={null} selection={selection}
                         handlers={h} readOnly />
    </MemoryRouter>);
  fireEvent.keyDown(tree, { key: "Backspace" });
  expect(h.onDeleteBlockSelection).not.toHaveBeenCalled();
  fireEvent.keyDown(tree, { key: "Escape" });
  expect(h.onClearBlockSelection).toHaveBeenCalledTimes(1); // still dismissible
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd web && pnpm test:unit src/components/EditableBlockTree.test.tsx -t "pkm-rckh"`
Expected: both FAIL with `onDeleteBlockSelection` having been called once (and `fireEvent.keyDown(...)` returning `false`, because the handler still calls `preventDefault`).

- [ ] **Step 3: Gate the destructive branch**

In `web/src/components/EditableBlockTree.tsx`, replace lines 178-180:

```ts
    } else if (e.key === "Backspace" || e.key === "Delete") {
      // Selection CREATION and copying are deliberately read-only-safe
      // (pkm-am54); destroying one is a mutation, so it is gated like the
      // Tab and Shift+Cmd+Arrow branches above. A selection made while
      // editable outlives the switch to read-only (pkm-rckh).
      if (!readOnly) {
        e.preventDefault();
        handlers.onDeleteBlockSelection();
      }
    } else if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
```

- [ ] **Step 4: Run the tests**

Run: `cd web && pnpm test:unit src/components/EditableBlockTree.test.tsx`
Expected: PASS — the two new tests plus the pre-existing `pkm-q89w` delete test (which mounts editable, so it still deletes).

- [ ] **Step 5: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Document the invariant**

In `docs/architecture/frontend.md` § *The editor*, append to the "Keyboard policy is a pure function" bullet:

```markdown
  A multi-block *selection* is keyed elsewhere: with no focused textarea the
  tree container itself takes focus and `EditableBlockTree.onKeyDown` owns the
  chain (extend / move / indent / copy / clear / delete). The split invariant
  there is that **creating, extending and copying a selection are
  read-only-safe, while every mutating branch is gated on `!readOnly`** — Tab,
  Shift+Cmd+Arrow and Backspace/Delete (pkm-rckh; the delete gate was missing,
  so a selection made while editable could still be destroyed after sync
  turned the outline read-only). `useOutline`'s handlers do not re-check
  editability, so the gate has to be here.
```

- [ ] **Step 7: Commit**

Update `.beans/pkm-rckh--editor-block-deletion-of-read-only-multi-block-sel.md` (tick both items, `status: completed`, bump `updated_at`, `## Summary of Changes`) — record that `useOutline.onDeleteBlockSelection` has no editability check either, so the component gate is the whole fix, and that `keyboardPolicy.ts` was considered and rejected as the home (it is the focused-textarea policy; the selection chain has no policy module).

```bash
cd /Users/arthur/code/llm/pkm/.claude/worktrees/pkm-6phf-web-hardening
git status -sb
git add web/src/components/EditableBlockTree.tsx \
        web/src/components/EditableBlockTree.test.tsx \
        docs/architecture/frontend.md \
        .beans/pkm-rckh--editor-block-deletion-of-read-only-multi-block-sel.md
git commit -m "fix(pkm-rckh): gate multi-block selection deletion on !readOnly"
```

---

### Task 4: mobile nav — closed drawer out of the focus order, with ARIA state (bean pkm-rwwp)

**Bean:** `.beans/pkm-rwwp--mobile-nav-remove-closed-drawer-from-focus-order-a.md`

**The confirmed defect.** `web/src/styles.css:698-703`, inside `@media (max-width: 600px)`:

```css
  .left-nav { position: fixed; left: 0; top: var(--app-banner-height);
    height: calc(100vh - var(--app-banner-height)); z-index: 25;
    transform: translateX(-100%); transition: transform 0.15s; }
  .left-nav.open { transform: translateX(0); }
```

A translated element is still visible to the focus order, so on a phone the closed drawer's eight-plus controls (Daily Notes, Current Work, TODO, the theme toggle, `SidebarNav`'s links and Edit button, Assistant, Files, Settings) are all tab stops off-screen — they are the *first* tab stops on the page. And `web/src/App.tsx:128-131`'s hamburger exposes no state:

```tsx
<button className="hamburger" aria-label="menu"
        onClick={() => setNavOpen((o) => !o)}>
```

**The design.** `visibility: hidden` while closed, restored by `.left-nav.open`, both scoped to the phone media query — the drawer must stay fully interactive at every wider breakpoint, where `navOpen` is meaningless. `visibility` is included in the transition so the slide-out stays visible: a visibility transition holds `visible` for the duration when moving to `hidden`, and applies immediately when moving to `visible`. React 18.3 is in use (`web/package.json:24`), which does not support the `inert` prop, so CSS is the mechanism — and the bean sanctions it. On the hamburger: `aria-expanded={navOpen}` and `aria-controls` pointing at a new `id="left-nav"` on the `<nav>`. Closing the drawer returns focus to the hamburger, guarded on the previous state so that a `NavLink`'s unconditional `setNavOpen(false)` on desktop (where `navOpen` is already `false` and the effect does not even re-run) can never steal focus.

**Files:**
- Modify: `web/src/App.tsx` (imports, a ref + effect after line 53, the hamburger at 128-131, the `<nav>` at 132)
- Modify: `web/src/styles.css:698-703`
- Test: `web/src/App.test.tsx`
- Test: `web/src/styles.test.ts`
- Modify: `docs/architecture/frontend.md` § *Focus and interactive affordances*
- Modify: `.beans/pkm-rwwp--mobile-nav-remove-closed-drawer-from-focus-order-a.md`

**Interfaces:**
- Consumes: the existing `navOpen` state (`App.tsx:43`) and `MenuIcon` from `./components/icons`.
- Produces: DOM contract other code and tests may rely on — `nav#left-nav.left-nav[.open]` and `button.hamburger[aria-label="menu"][aria-expanded][aria-controls="left-nav"]`.

---

- [ ] **Step 1: Write the failing stylesheet test**

Append to `web/src/styles.test.ts` (node environment; `mediaRulesFor` is defined at the top of the file):

```ts
describe("phone nav drawer is unreachable while closed (pkm-rwwp)", () => {
  test("the closed drawer is visibility:hidden; .open restores it", () => {
    // translateX alone leaves every nav link tabbable off-screen, and they are
    // the page's first tab stops. visibility:hidden takes the whole subtree
    // out of the focus order.
    const closed = mediaRulesFor("(max-width: 600px)", ".left-nav");
    expect(closed).toContain("visibility: hidden;");
    // transitioned, so the slide-out is still seen: a visibility transition
    // holds "visible" until the end when moving to hidden
    expect(closed).toContain("transition: transform 0.15s, visibility 0.15s;");
    expect(mediaRulesFor("(max-width: 600px)", ".left-nav.open"))
      .toContain("visibility: visible;");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && pnpm test:unit src/styles.test.ts -t "pkm-rwwp"`
Expected: FAIL — `visibility: hidden;` is not in the closed rule.

- [ ] **Step 3: Make the closed drawer invisible (phone breakpoint only)**

In `web/src/styles.css`, replace lines 698-703 (inside `@media (max-width: 600px)`):

```css
  /* Closed, the drawer is only translated off-screen, which leaves every link
   * and button in it tabbable -- and they are the page's first tab stops
   * (pkm-rwwp). visibility:hidden removes the whole subtree from the focus
   * order; it is transitioned so the slide-out stays visible (a visibility
   * transition holds "visible" for the duration when moving to hidden, and
   * applies immediately when moving to visible). Scoped to this breakpoint on
   * purpose: at every wider width the nav is permanent and `navOpen` is
   * meaningless. */
  .left-nav { position: fixed; left: 0; top: var(--app-banner-height);
    height: calc(100vh - var(--app-banner-height)); z-index: 25;
    transform: translateX(-100%); visibility: hidden;
    transition: transform 0.15s, visibility 0.15s; }
  .left-nav.open { transform: translateX(0); visibility: visible; }
```

- [ ] **Step 4: Run the stylesheet test**

Run: `cd web && pnpm test:unit src/styles.test.ts`
Expected: PASS (the whole file — it also asserts `.left-nav`'s background at line 376 via `ruleFor`, which still resolves to the non-media rule because that one appears first in the file).

- [ ] **Step 5: Write the failing ARIA / focus tests**

Append to `web/src/App.test.tsx`:

```ts
it("the hamburger exposes the drawer's expanded state and what it controls (pkm-rwwp)", () => {
  stubFetch([["/api/journal", { days: [] }]]);
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>,
  );
  const hamburger = screen.getByRole("button", { name: "menu" });
  const nav = container.querySelector(".left-nav") as HTMLElement;
  expect(nav.id).toBe("left-nav");
  expect(hamburger).toHaveAttribute("aria-controls", "left-nav");
  expect(hamburger).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(hamburger);
  expect(hamburger).toHaveAttribute("aria-expanded", "true");
  expect(nav).toHaveClass("open");

  fireEvent.click(hamburger);
  expect(hamburger).toHaveAttribute("aria-expanded", "false");
  expect(nav).not.toHaveClass("open");
});

it("closing the nav drawer returns focus to the hamburger (pkm-rwwp)", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  const hamburger = screen.getByRole("button", { name: "menu" });

  // closed by the hamburger itself
  fireEvent.click(hamburger);
  fireEvent.click(hamburger);
  expect(hamburger).toHaveFocus();

  // and closed by picking a destination: focus must not be left on a link
  // that visibility:hidden is about to take away
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.click(hamburger);
  fireEvent.click(screen.getByRole("link", { name: "Settings" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Settings" }))
    .toBeInTheDocument();
  expect(hamburger).toHaveFocus();
});

it("a never-opened drawer does not steal focus on mount or navigation (pkm-rwwp)", async () => {
  stubFetch([["/api/journal", { days: [] }]]);
  render(<MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/"]}><App /></MemoryRouter>);
  const hamburger = screen.getByRole("button", { name: "menu" });
  expect(hamburger).not.toHaveFocus();
  // every NavLink calls setNavOpen(false) unconditionally; on desktop, where
  // the drawer is permanent, that must not pull focus to a display:none button
  fireEvent.click(screen.getByRole("link", { name: "Settings" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Settings" }))
    .toBeInTheDocument();
  expect(hamburger).not.toHaveFocus();
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd web && pnpm test:unit src/App.test.tsx -t "pkm-rwwp"`
Expected: the first two FAIL — `nav.id` is `""`, there is no `aria-controls`/`aria-expanded`, and focus never returns to the hamburger. The third PASSES already; keep it, it is the regression guard for the effect added next.

- [ ] **Step 7: Add the ARIA attributes and focus restoration**

In `web/src/App.tsx`, add a ref beside the existing refs (after line 53, `const bannerStackRef = …`):

```tsx
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const navWasOpenRef = useRef(false);
```

Add this effect after the `useLayoutEffect` banner-height block (after line 91) — `useEffect` is already imported:

```tsx
  // Closing the phone drawer must not leave focus inside it: below 600px the
  // closed nav is visibility:hidden, so a focused link there would strand the
  // keyboard on an invisible element. Hand focus back to the control that
  // opened it (pkm-rwwp). Guarded on the previous state, because every NavLink
  // calls setNavOpen(false) unconditionally -- on desktop navOpen is already
  // false and the hamburger is display:none.
  useEffect(() => {
    if (navWasOpenRef.current && !navOpen) hamburgerRef.current?.focus();
    navWasOpenRef.current = navOpen;
  }, [navOpen]);
```

Replace the hamburger button (lines 128-131):

```tsx
              <button className="hamburger" aria-label="menu"
                      ref={hamburgerRef}
                      aria-expanded={navOpen} aria-controls="left-nav"
                      onClick={() => setNavOpen((o) => !o)}>
                <MenuIcon />
              </button>
```

And give the nav its id (line 132):

```tsx
              <nav id="left-nav"
                   className={"left-nav" + (navOpen ? " open" : "") + (sidebarCollapsed ? " collapsed" : "")}>
```

- [ ] **Step 8: Run the App suite**

Run: `cd web && pnpm test:unit src/App.test.tsx`
Expected: PASS — all three new tests plus the existing nav tests ("Settings nav link sits below the user-editable favourites…", "Assistant link opens a new section…", the collapse-class test).

- [ ] **Step 9: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors (`useRef<HTMLButtonElement>(null)` matches `ref` on a `<button>`).

- [ ] **Step 10: Document it**

In `docs/architecture/frontend.md` § *Focus and interactive affordances*, add a bullet to the "Two traps when working on this" list:

```markdown
- **An off-screen drawer is still in the tab order.** The phone nav
  (`@media (max-width: 600px)`) used `transform: translateX(-100%)` alone, so
  the closed drawer's links and buttons stayed tabbable — as the *first* tab
  stops on the page (pkm-rwwp). It now also sets `visibility: hidden`, with
  `.left-nav.open` restoring `visible` and `visibility` in the transition so
  the slide-out is still seen. Both declarations are scoped to that media
  query: at wider widths the nav is permanent and `navOpen` means nothing.
  The hamburger carries `aria-expanded` / `aria-controls="left-nav"`, and
  closing the drawer moves focus back to it — guarded on the drawer's previous
  state, since every `NavLink` calls `setNavOpen(false)` on every click and
  the hamburger is `display: none` above the breakpoint.
```

- [ ] **Step 11: Commit**

Update `.beans/pkm-rwwp--mobile-nav-remove-closed-drawer-from-focus-order-a.md` (tick both items, `status: completed`, bump `updated_at`, `## Summary of Changes`) — record why `visibility` rather than `inert` (React 18.3 has no `inert` prop), why both declarations are media-scoped, and the previous-state guard on focus restoration.

```bash
cd /Users/arthur/code/llm/pkm/.claude/worktrees/pkm-6phf-web-hardening
git status -sb
git add web/src/App.tsx web/src/App.test.tsx web/src/styles.css web/src/styles.test.ts \
        docs/architecture/frontend.md \
        .beans/pkm-rwwp--mobile-nav-remove-closed-drawer-from-focus-order-a.md
git commit -m "fix(pkm-rwwp): take the closed phone nav out of the focus order and expose its state"
```

---

### Task 5: keyboard-accessible headings — page title and Unlinked references (bean pkm-l4z8)

**Bean:** `.beans/pkm-l4z8--make-clickable-headings-keyboard-accessible-page-t.md`

**The confirmed defect.** Two headings carry `onClick` with no focusable control:

- `web/src/components/PageTitle.tsx:62-67` — `<h1 className="page-title page-title-editable" onClick={editable ? … : undefined}>{title}</h1>`. Renaming a page is keyboard-unreachable.
- `web/src/components/UnlinkedSection.tsx:127-130` — `<h2 className="section-header collapsible" onClick={toggle}>`. Expanding Unlinked references is keyboard-unreachable and announces no state.

**The design.** Put a real `<button>` *inside* each heading, so the document outline is unchanged and the control is native (Enter/Space activation, focusable, announced as a button). The collapsible one gets `aria-expanded`. The existing in-heading control pattern to follow is `BacklinksSection.tsx:163` (`<button className="filter-toggle btn-secondary" aria-expanded={panelOpen}>` inside `<h2 className="section-header">`) — but these two must not look like buttons, so they need chrome-free classes that inherit the heading's type, exactly as `.chevron` does for the collapse arrows: `font: inherit`, no background/border/padding, plus the standard ring (`outline: 2px solid var(--color-link); outline-offset: 1px;`) declared next to each rule and added to the audited-classes list in `styles.test.ts`. `letter-spacing` and `text-transform` need explicit `inherit` — `font: inherit` does not carry them, and `.page-title` sets `letter-spacing: -0.01em` while `.section-header` sets `text-transform: uppercase; letter-spacing: 0.5px`.

Existing tests: `sections.test.tsx` clicks `screen.getByText(/unlinked references/i)`, which keeps resolving to the innermost element whose *direct* text children match — the new button — so those tests need no change. `PageTitle.test.tsx`'s `startEditing` helper clicks the heading itself and must be pointed at the button (a click on `<h1>` does not reach the nested button).

**Files:**
- Modify: `web/src/components/PageTitle.tsx:59-74`
- Modify: `web/src/components/UnlinkedSection.tsx:127-130`
- Modify: `web/src/styles.css` (a rule next to `.page-title-editable` at line 357, and one next to `.section-header.collapsible` at line 604)
- Test: `web/src/components/PageTitle.test.tsx`, `web/src/components/sections.test.tsx`, `web/src/styles.test.ts`
- Modify: `docs/architecture/frontend.md` § *Focus and interactive affordances*
- Modify: `.beans/pkm-l4z8--make-clickable-headings-keyboard-accessible-page-t.md`

**Interfaces:**
- Consumes: `PageTitle`'s `editable` flag (`dateForTitle(title) === null`) and `UnlinkedSection`'s `open` state and `toggle()`.
- Produces: DOM contract — `h1.page-title > button.page-title-edit` (only when editable) and `h2.section-header.collapsible > button.section-toggle[aria-expanded]` containing the decorative `span.chevron[aria-hidden]`.

---

- [ ] **Step 1: Write the failing component tests**

In `web/src/components/PageTitle.test.tsx`, point the existing helper at the button:

```ts
function startEditing(title: string) {
  fireEvent.click(screen.getByRole("button", { name: title }));
  return screen.getByRole("textbox") as HTMLInputElement;
}
```

Then append:

```ts
it("the editable title is a focusable button inside the heading (pkm-l4z8)", () => {
  mount("My Page");
  const heading = screen.getByRole("heading", { name: "My Page" });
  const trigger = screen.getByRole("button", { name: "My Page" });
  // the heading keeps its place in the document outline; the control inside it
  // is a native <button>, so Enter/Space activate it (jsdom does not
  // synthesise that activation click, which is why this asserts the element
  // type and focusability rather than firing a keydown)
  expect(heading).toContainElement(trigger);
  expect(trigger.tagName).toBe("BUTTON");
  trigger.focus();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  expect(screen.getByRole("textbox")).toHaveValue("My Page");
});
```

And replace the last existing test so it asserts the absence of the control:

```ts
it("daily-note titles are not editable", () => {
  mount("July 17th, 2026");
  expect(screen.queryByRole("button", { name: "July 17th, 2026" })).toBeNull();
  fireEvent.click(screen.getByRole("heading", { name: "July 17th, 2026" }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
```

In `web/src/components/sections.test.tsx`, append:

```ts
it("the unlinked header is a focusable button reporting its expanded state (pkm-l4z8)", async () => {
  stubFetch([["/api/unlinked?title=ACME", unlinkedPayload()]]);
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <UnlinkedSection title="ACME" />
    </MemoryRouter>,
  );
  const toggle = screen.getByRole("button", { name: /unlinked references/i });
  expect(screen.getByRole("heading", { level: 2 })).toContainElement(toggle);
  expect(toggle.tagName).toBe("BUTTON");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  toggle.focus();
  expect(toggle).toHaveFocus();

  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await screen.findAllByRole("button", { name: "Link" })).toHaveLength(2);

  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});
```

- [ ] **Step 2: Write the failing stylesheet tests**

In `web/src/styles.test.ts`, add the two new classes to the existing audited-bare-button list in the `"other bare-button classes audited for the same gap all get the ring"` test (around line 170), keeping the array's order and formatting:

```ts
      ".chevron",
      ".panel-close",
      ".hamburger",
      ".block-menu-item",
      ".empty-page",
      ".assistant-close",
      ".assistant-preview-toggle",
      ".page-title-edit",
      ".section-toggle",
```

Then append a new describe block:

```ts
describe("in-heading trigger buttons inherit their heading (pkm-l4z8)", () => {
  test("the page-title edit button carries no button chrome", () => {
    const rule = rulesFor(".page-title-edit");
    expect(rule).toContain("font: inherit;");
    // font: inherit does not carry letter-spacing, and .page-title sets it
    expect(rule).toContain("letter-spacing: inherit;");
    expect(rule).toContain("border: none;");
    expect(rule).toContain("background: none;");
    expect(rule).toContain("cursor: text;");
  });

  test("the collapsible section toggle keeps the header's uppercase type", () => {
    const rule = rulesFor(".section-toggle");
    expect(rule).toContain("font: inherit;");
    expect(rule).toContain("text-transform: inherit;");
    expect(rule).toContain("letter-spacing: inherit;");
    expect(rule).toContain("border: none;");
    expect(rule).toContain("background: none;");
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd web && pnpm test:unit src/components/PageTitle.test.tsx src/components/sections.test.tsx src/styles.test.ts`
Expected: FAIL. `PageTitle`: `getByRole("button", { name: "My Page" })` finds nothing, so every test using `startEditing` fails too. `sections`: no button named /unlinked references/. `styles`: `Missing CSS rule for .page-title-edit`.

- [ ] **Step 4: Make the page title's affordance a button**

In `web/src/components/PageTitle.tsx`, replace the `if (!editing)` block (lines 59-74):

```tsx
  if (!editing) {
    const startEditing = () => {
      cancelledRef.current = false;
      setError(null);
      setEditing(true);
    };
    return (
      <>
        {/* The affordance is a real button inside the heading (pkm-l4z8):
          * an onClick on the <h1> itself was unreachable from the keyboard.
          * The heading keeps its place in the document outline and the button
          * inherits its type, so nothing moves visually. */}
        <h1 className={`page-title${editable ? " page-title-editable" : ""}`}>
          {editable
            ? (
              <button type="button" className="page-title-edit"
                      onClick={startEditing}>
                {title}
              </button>
            )
            : title}
        </h1>
        {error !== null && <p className="error">{error}</p>}
        {dialog}
      </>
    );
  }
```

- [ ] **Step 5: Make the unlinked header a toggle button**

In `web/src/components/UnlinkedSection.tsx`, replace lines 127-130:

```tsx
      {/* The toggle is a real button inside the heading (pkm-l4z8): an onClick
        * on the <h2> was unreachable from the keyboard and announced no state. */}
      <h2 className="section-header collapsible">
        <button type="button" className="section-toggle" aria-expanded={open}
                onClick={toggle}>
          <span className={"chevron" + (open ? "" : " closed")}
                aria-hidden="true">▸</span>
          {" "}Unlinked references{visibleTotal !== null ? ` (${visibleTotal})` : ""}
        </button>
      </h2>
```

- [ ] **Step 6: Add the two chrome-free control rules**

In `web/src/styles.css`, after `.page-title-editable { cursor: text; }` (line 357) add:

```css
/* The title's edit affordance is a real button (pkm-l4z8); it inherits the
 * heading's type so the page looks unchanged, and spans the line so the click
 * target is the same one the <h1> used to offer. */
.page-title-edit { font: inherit; color: inherit; letter-spacing: inherit;
  background: none; border: none; padding: 0; margin: 0; display: block;
  width: 100%; text-align: left; cursor: text; }
.page-title-edit:focus-visible { outline: 2px solid var(--color-link); outline-offset: 1px; }
```

And after `.section-header.collapsible { cursor: pointer; user-select: none; }` (line 604) add:

```css
/* Collapsible section headers toggle through a real button (pkm-l4z8), which
 * must keep the header's uppercase letter-spaced type: font: inherit carries
 * neither text-transform nor letter-spacing. */
.section-toggle { font: inherit; color: inherit; letter-spacing: inherit;
  text-transform: inherit; background: none; border: none; padding: 0;
  text-align: left; cursor: pointer; }
.section-toggle:focus-visible { outline: 2px solid var(--color-link); outline-offset: 1px; }
```

- [ ] **Step 7: Run the three suites**

Run: `cd web && pnpm test:unit src/components/PageTitle.test.tsx src/components/sections.test.tsx src/styles.test.ts`
Expected: PASS, including the pre-existing `sections.test.tsx` tests that click `getByText(/unlinked references/i)` — that query resolves by *direct* text children, so it now finds the button rather than the `<h2>`. If it instead reports multiple matches, text was left as a direct child of the `<h2>`.

- [ ] **Step 8: Run the full unit suite (other views render both components)**

Run: `cd web && pnpm test:unit`
Expected: PASS. `PageView`, `EditablePage` and `App` tests render `PageTitle`; any that click the title need the same button-instead-of-heading update. Fix those call sites the same way rather than reintroducing the heading handler.

- [ ] **Step 9: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Document it**

In `docs/architecture/frontend.md` § *Focus and interactive affordances*, add a bullet to the "Two traps when working on this" list:

```markdown
- **A heading with an `onClick` is a mouse-only control.** Page-title renaming
  and the Unlinked references collapse were both `onClick` on a non-focusable
  `<h1>`/`<h2>` (pkm-l4z8). Both now wrap their label in a real `<button>`
  *inside* the heading — `.page-title-edit` and `.section-toggle`, chrome-free
  classes that inherit the heading's type (`font: inherit` plus explicit
  `letter-spacing: inherit` / `text-transform: inherit`, which `font` does not
  carry) and take the standard ring. The collapsible one owns `aria-expanded`
  and marks its chevron `aria-hidden`. `BacklinksSection`'s `.filter-toggle`
  is the same in-heading pattern where a visible button *is* wanted.
```

- [ ] **Step 11: Commit**

Update `.beans/pkm-l4z8--make-clickable-headings-keyboard-accessible-page-t.md` (tick both items, `status: completed`, bump `updated_at`, `## Summary of Changes`) — note the two new control classes, why `font: inherit` alone was not enough, and that existing `getByText` selectors kept working while `PageTitle`'s heading-click helper had to move to the button.

```bash
cd /Users/arthur/code/llm/pkm/.claude/worktrees/pkm-6phf-web-hardening
git status -sb
git add web/src/components/PageTitle.tsx web/src/components/PageTitle.test.tsx \
        web/src/components/UnlinkedSection.tsx web/src/components/sections.test.tsx \
        web/src/styles.css web/src/styles.test.ts docs/architecture/frontend.md \
        .beans/pkm-l4z8--make-clickable-headings-keyboard-accessible-page-t.md
git commit -m "fix(pkm-l4z8): make the page title and unlinked-refs headings keyboard-operable"
```

---

### Task 6: branch-end verification

No bean — this is the gate, not a change.

**Files:** none created or modified unless verification finds a defect.

**Interfaces:**
- Consumes: everything Tasks 1-5 shipped.
- Produces: a green `pnpm verify` and, if anything needed fixing, follow-up commits on the same branch naming the bean whose work regressed.

- [ ] **Step 1: Run the full web gate**

Run: `cd web && pnpm verify`
Expected: PASS. This is `pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && vite build && node tooling/runPlaywright.mjs`.

- [ ] **Step 2: If coverage fails, add the missing test rather than lowering the threshold**

Thresholds are `statements 95 / branches 91 / functions 89 / lines 95`. Task 1's new branches are the ones to check first — the lane's 4xx path, the `qstate.disposed` return inside the enqueue-failure handler, the `durableAhead` clamp and its `continue` — and each has a named test in Task 1 Step 10. If coverage still complains, read the v8 report and add the specific case rather than adjusting the threshold.

- [ ] **Step 3: If Playwright fails, distinguish a regression from the known flake**

`web/e2e/edit.spec.ts` (seen at `:124`, `:220`, `:308`) and `web/e2e/paste.spec.ts:53` are load-sensitive on a busy machine (bean pkm-ndcu). Re-run the failing spec alone before believing it: `cd web && npx playwright test e2e/edit.spec.ts`. A failure that reproduces with the branch's `web/src` reverted is pre-existing; a failure that only appears here is a regression to fix.

- [ ] **Step 4: Check the architecture docs against what actually shipped**

Re-read the three doc edits (`docs/architecture/sync-and-offline.md` from Task 1, the two `docs/architecture/frontend.md` sections from Tasks 2-5) against the final code, not against this plan. Confirm there are no stale counts nearby (the audited-bare-button list in `styles.test.ts` grew by two, and the Focus section's "Three deliberate exceptions" / "Two traps" counts are prose the new bullets change — update those numbers if the bullet lists no longer match).

- [ ] **Step 5: Commit any verification fixes**

```bash
cd /Users/arthur/code/llm/pkm/.claude/worktrees/pkm-6phf-web-hardening
git status -sb
git add -A
git commit -m "fix(pkm-6phf): <what verification turned up>"
```

- [ ] **Step 6: Report the branch as ready**

Confirm `git log --oneline main..HEAD` shows one commit per bean (plus any verification fixes), that all five bean files read `status: completed` with a `## Summary of Changes`, and hand off to `superpowers:finishing-a-development-branch` for the merge decision.
