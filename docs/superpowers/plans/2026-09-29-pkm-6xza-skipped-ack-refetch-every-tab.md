# A skipped ack refetches the view in every tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A durable (replica-backed, online) tab must refetch the view when
an `/api/ops` ack names a skipped op, exactly like the fallback-lane path
already does under the no-replica latch — today only the lane path fires,
and only while `unavailable !== null`, so an online tab's replica tombstones
the row while the screen keeps the ghost and every debounced edit into it
lands another `orphan_edit` child under today's daily-note conflict header.

**Architecture:** `web/src/sync/opQueue.ts`'s durable batch loop in
`runDrain` gains the same `ackSkipped(ack)` read the lane's `deliverLaneHead`
already has, and both call the renamed `onSkipped` callback unconditionally
(dropping the `unavailable !== null` guard). `syncState.ts`'s event and
`SyncProvider.tsx`'s wiring are renamed to match (`ops-skipped-no-replica` →
`ops-skipped`); the event still only bumps `resyncSeq`, never raises a
problem. Cost: one harmless extra view refetch per skipped ack in a tab whose
own changes feed would also have converged the replica row.

**Tech Stack:** TypeScript, Vitest, React Testing Library (web/).

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md`
§ F5 ("A skipped ack refetches the view in every tab"), plus § Shared rules
and § Verification per branch. Source finding:
`docs/2026-09-29-sync-subsystem-review-consolidated.md` § F5. Bean: pkm-6xza
(parent epic pkm-a4t2). Prior fix this extends: pkm-c2gs
(`.beans/pkm-c2gs--no-replica-tab-keeps-a-ghost-block-on-screen-and-l.md`).

## Global Constraints

- TDD: every fix's failing test goes red, for the stated reason, before the
  fix.
- Every runtime file declares its FCIS pattern (`// pattern: Functional Core`
  / `// pattern: Imperative Shell`); pure predicates, classifiers and
  transforms live in Functional Core files. `pnpm check:fcis` forbids a Core
  file importing a value from a Shell module. (All files this plan touches
  already carry their pattern comment; no new files are created.)
- Code and test comments state the rule and carry NO bean id. Commit messages
  may carry the id.
- Docs land in the same branch: the doc correction the spec section names,
  plus one row in `docs/troubleshooting.md` (symptom, cause, owning section,
  bean id). Any `docs/architecture/` edit goes through the `architecture-docs`
  skill; run `node .claude/skills/architecture-docs/check-docs.mjs <files>`.
- No route or docstring changes in this bean, so no openapi/web-types regen
  is needed (verify this stays true before the final task).
- The spec's composed test across the boundary (render `SyncProvider`,
  deliver a skipped ack, assert `resyncSeq` moved) is a task of its own.
- Final task: web `pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm
  test:coverage && pnpm build` (server is untouched by this bean, so no
  server commands are needed — confirm that before skipping them). Any
  new/changed e2e spec run alone on the port the executor is given — this
  bean adds no e2e spec, so this does not apply. The orchestrator runs the
  full Playwright suite and `perf/check.sh frontend` after merge; do not run
  them here. Then tick the bean checklist, write `## Summary of Changes`,
  mark the bean complete, commit with the code.
- Never write the two-word phrase that starts "load" and ends "bearing".
- **Reader `ackSkipped` is not touched beyond widening its call sites.** The
  upcoming "Typed ack" bean (pkm-jk1d, ordered directly after this one) adds
  `OpsAck` as the route's `response_model` and replaces the hand-rolled,
  read-by-hand readers `ackSeq`/`ackSkipped` in `opQueue.ts` with one reader
  over the generated type. Do not rename, retype or restructure `ackSkipped`
  here — only add a second call site for the existing function.

## Review Focus

- A durable ack with an absent, empty, or malformed (non-array) `skipped`
  field must not call `onSkipped` — the same three-way negative the lane path
  already has, now needed for the durable path too. Pinned in Task 1.
- `onSkipped` must never fire for a batch the server terminally rejects: the
  new durable-path check must sit only in the ack-success branch, never in
  `rejectDurableBatch`'s catch path. Pinned in Task 1 by asserting a 400 ack
  reaches `rejectDurableBatch` and the skip callback is never called.
- A listener that throws inside `onSkipped` must not abort the drain loop —
  both call sites already wrap the call in `try {} catch { /* listener
  isolation */ }`; Task 1 keeps that shape at the new call site and does not
  need a new test (the existing pattern is exercised by the lane's own
  poison/desync listener-isolation tests elsewhere in the file).
- The composed test (Task 3) must isolate the bump this fix adds from the
  unrelated bump a first connect can already produce (leftover-batch flush,
  `viewsAreStale`): read the `resyncSeq` baseline only after the initial
  connect has settled, then assert it strictly increased after the skipped
  ack, not that it equals a specific number.
- Renaming `ops-skipped-no-replica` → `ops-skipped` (a discriminated union
  member) must not leave a stale reference anywhere: `pnpm typecheck` in the
  final task is the exhaustive check (the `default` branch in
  `transitionSync` throws on an unhandled event, and TypeScript's exhaustiveness
  check on the `never` cast would fail to compile against a stale literal).

---

### Task 1: Both delivery paths consult `ackSkipped`, regardless of `unavailable`

**Files:**
- Modify: `web/src/sync/opQueue.ts` (`createReplicaQueue`, `deliverLaneHead`,
  the durable batch loop in `runDrain`, `createOpQueue`)
- Test: `web/src/sync/opQueue.replica.test.ts`

**Interfaces:**
- Consumes: existing `ackSkipped(ack: unknown): boolean` and
  `ackSeq(ack: unknown): number | undefined` in `opQueue.ts` — unchanged (see
  Global Constraints).
- Produces: `createOpQueue`'s fourth constructor argument is renamed
  `onSkipped: () => void` (was `onSkippedNoReplica`); Task 2's SyncProvider
  wiring and Task 3's composed test call it by its new name. Behaviour: fires
  whenever either delivery path's ack names a non-empty `skipped` list, no
  longer gated on `unavailable !== null`.

- [ ] **Step 1: Invert the pinned "does not refetch" lane test**

In `web/src/sync/opQueue.replica.test.ts`, replace the test at lines
2163–2185 (`"a skipped op delivered by the lane while the replica is
otherwise fine does not refetch (it has a feed to tombstone the ghost)"`)
with one asserting the opposite:

```ts
test("a skipped op delivered by the lane while the replica is otherwise " +
"fine still refetches (both paths consult ackSkipped, not only the " +
"no-replica latch)", async () => {
  // The lane also delivers ordering-only entries ahead of a durable batch
  // while unavailable is still null (pkm-5ekv) -- a working replica, just a
  // transient local persist failure. Its own feed will also tombstone the
  // ghost, so this refetch is a harmless extra, not a correctness gap.
  const { bodies } = fetchSeq([() => jsonResponse({
    ok: true, ts: 1, applied: 1,
    skipped: [{ index: 0, op: "update_text", uid: "u1",
                reason: "missing_target", note_page: "2026-09-29" }],
  })]);
  const replica = memReplica({
    enqueue: async () => { throw new Error("worker crashed"); },
  });
  const skips: void[] = [];
  const q = createOpQueue(replica, () => undefined, () => undefined,
    () => skips.push(undefined));
  q.enqueue([op("u1")]);
  await q.settled();
  await q.drain();
  expect(bodies).toHaveLength(1);
  expect(skips).toHaveLength(1);
});
```

Update the block comment above it (currently lines 2094–2099, starting
"pkm-c2gs: a no-replica tab...") to state the rule with no bean id:

```ts
// --- Any ack naming a skipped op, on either delivery path, refetches the
// active view -- otherwise the ghost block the skipped op targeted never
// leaves the screen, and every debounced flush lands another child under
// its daily-note conflict header. A replica-backed tab's own feed also
// tombstones the ghost row, but nothing else bumps resync for it, so this
// fires regardless of whether the queue has latched `unavailable`.
```

- [ ] **Step 2: Run the test, confirm it fails for the stated reason**

Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts -t "still refetches"`
Expected: FAIL — `skips` is `[]`, because `deliverLaneHead` still gates the
call on `unavailable !== null` and this replica is never latched unavailable.

- [ ] **Step 3: Add the durable-path positive and negative cases**

Append after the (now-passing-once-fixed) inverted test, at the end of the
file:

```ts
test("a durable batch's ack naming a skipped op also refetches (a replica-" +
"backed tab's feed tombstones the row, but nothing else bumps resync for " +
"it)", async () => {
  fetchSeq([() => jsonResponse({
    ok: true, ts: 1, applied: 1, seq: 7,
    skipped: [{ index: 0, op: "update_text", uid: "u1",
                reason: "missing_target", note_page: "2026-09-29" }],
  })]);
  const replica = memReplica();
  const skips: void[] = [];
  const q = createOpQueue(replica, () => undefined, () => undefined,
    () => skips.push(undefined));
  q.enqueue([op("u1")]);
  await q.settled();
  await q.drain();
  expect(skips).toHaveLength(1);
  expect(replica.rows).toEqual([]); // delivered and deleted, same as today
});

test("a durable ack with no skipped ops does not refetch", async () => {
  fetchSeq([() => jsonResponse({ ok: true, ts: 1, applied: 1 })]);
  const replica = memReplica();
  const skips: void[] = [];
  const q = createOpQueue(replica, () => undefined, () => undefined,
    () => skips.push(undefined));
  q.enqueue([op("u1")]);
  await q.settled();
  await q.drain();
  expect(skips).toEqual([]);
});

test("a durable batch the server terminally rejects never calls onSkipped",
async () => {
  fetchSeq([() => jsonResponse({ detail: "bad op" }, 400)]);
  const replica = memReplica();
  const skips: void[] = [];
  const q = createOpQueue(replica, () => undefined, () => undefined,
    () => skips.push(undefined));
  q.enqueue([op("u1")]);
  await q.settled();
  const outcome = await q.drain();
  expect(outcome).toMatchObject({ reason: "recovering" });
  expect(skips).toEqual([]);
});
```

- [ ] **Step 4: Run the three new tests, confirm the first fails, the other two already pass**

Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts -t "durable"`
Expected: the "also refetches" test FAILS (`skips` is `[]` — the durable loop
never reads `ackSkipped` today); the "no skipped ops" and "terminally
rejects" tests already PASS (there is nothing today to make them fail, which
is correct — they pin behaviour the fix must not disturb).

- [ ] **Step 5: Rename the callback and widen both call sites**

In `web/src/sync/opQueue.ts`:

- `createReplicaQueue`'s last parameter (currently `onSkippedNoReplica: () =>
  void`, line 215) becomes `onSkipped: () => void`.
- `deliverLaneHead` (lines 482–491): drop the `unavailable !== null &&` guard
  and call the renamed callback:

  ```ts
  // This batch committed (skipped ops are not a rejection); the ack's
  // skipped list is consulted regardless of `unavailable`: a replica-backed
  // tab's own feed tombstones the replica row, but no resync event follows
  // from that alone, so the view keeps the ghost until something else bumps
  // resync. The extra refetch is harmless when the feed also converges the
  // row.
  if (ackSkipped(ack)) {
    try { onSkipped(); } catch { /* listener isolation */ }
  }
  ```

- In the durable batch loop inside `runDrain` (around lines 613–621, right
  after `ack = await postOps(batch.ops, batch.batch_id);` succeeds and before
  `result = await replica.deleteBatch(...)`), add the mirrored check:

  ```ts
  // A committed durable batch whose ack names a skipped op needs the view
  // told, same as the lane: the replica tombstones the row from its own
  // feed, but no resync event follows from that alone.
  if (ackSkipped(ack)) {
    try { onSkipped(); } catch { /* listener isolation */ }
  }
  ```

  Placement matters: this must be after the `postOps` try/catch's success
  path (so a terminal rejection, which returns early via
  `rejectDurableBatch`, never reaches it) and can run before or after
  `deleteBatch` — putting it before keeps the two delivery paths' ack-handling
  order the same shape (check skip, then finish the row).

- `createOpQueue`'s last parameter and its JSDoc (lines 861–868): rename
  `onSkippedNoReplica` to `onSkipped` and rewrite the comment to no longer
  say "while this session has no replica":

  ```ts
  /** Either delivery path's ack named a skipped op (see deliverLaneHead and
   * the durable batch loop in runDrain) -- the active view is stale and must
   * refetch. Never a desync: the batch committed, so nothing here is
   * retried or discarded. */
  onSkipped: () => void = () => undefined): OpQueue {
    return createReplicaQueue(replica, onDesync, onDrain, onSkipped);
  ```

- [ ] **Step 6: Run the full opQueue test file, confirm green**

Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts`
Expected: PASS, all tests including the four from Steps 1–3.

- [ ] **Step 7: Commit**

```bash
git add web/src/sync/opQueue.ts web/src/sync/opQueue.replica.test.ts
git commit -m "fix(pkm-6xza): both op-queue delivery paths refetch on a skipped ack"
```

---

### Task 2: Rename the sync event and its wiring; no behaviour change

**Files:**
- Modify: `web/src/sync/syncState.ts`, `web/src/sync/syncState.test.ts`,
  `web/src/sync/SyncProvider.tsx`

**Interfaces:**
- Consumes: Task 1's renamed `onSkipped` callback from `createOpQueue`.
- Produces: `SyncEvent`'s member is `{ type: "ops-skipped" }` (was
  `"ops-skipped-no-replica"`); `SyncProvider`'s internal ref is `skippedRef`
  (was `skippedNoReplicaRef`). Nothing outside `web/src/sync/` reads either
  name (confirmed by `grep -rl onSkippedNoReplica\|ops-skipped-no-replica\|
  skippedNoReplicaRef web/src` before this task, which lists only the four
  files this and Task 1 touch).

- [ ] **Step 1: Rename in `syncState.ts`**

Replace the `SyncEvent` member (lines 57–62) and its comment:

```ts
  /** Either delivery path's ack named a skipped op: the active view may be
   * stale (a replica-backed tab's own feed tombstones the row, but nothing
   * else bumps resync for it) and must refetch, same as any other resync
   * bump. Never a "problem" -- the server committed the batch fine. */
  | { type: "ops-skipped" };
```

and the `switch` case (lines 242–243):

```ts
    case "ops-skipped":
      return { state, effects: [{ type: "bump-resync" }] };
```

- [ ] **Step 2: Rename in `syncState.test.ts`**

The `describe("transitionSync ops-skipped-no-replica", ...)` block (line
468) becomes `describe("transitionSync ops-skipped", ...)`; both `it()`
bodies' `{ type: "ops-skipped-no-replica" }` become `{ type: "ops-skipped" }`.
No assertion changes — this is a pure rename, so the block should still pass
unmodified in content once the type-checker accepts the new literal.

- [ ] **Step 3: Rename in `SyncProvider.tsx`**

- Line 262 (`const skippedNoReplicaRef = ...`): rename to `skippedRef`, and
  drop the leading "pkm-c2gs:" from its comment (lines 258–261) so it reads:

  ```ts
  // Read via a ref, not closed over directly, for the same reason
  // repairLegacyRef is -- the queue below is memoised with an empty
  // dependency array (it must stay one stable instance for the provider's
  // whole lifetime), so nothing it closes over may need to change identity.
  const skippedRef = useRef<() => void>(() => undefined);
  ```

- Line 287: `skippedRef.current = () => applySync({ type: "ops-skipped" });`
- Lines 300–307 (the `createOpQueue` call's fourth argument and its
  comment): rename the call site and rewrite the comment to drop "a
  no-replica tab has no changes feed":

  ```ts
    const queue = useMemo(
      () => createOpQueue(replicaRef.current ?? absentReplica(), (error) => {
        void repairLegacyRef.current(error);
      }, (outcome) => drainObserverRef.current(outcome),
      // Either delivery path's ack named a skipped op: a replica-backed
      // tab's own feed tombstones the row, but nothing else bumps resync
      // for it, so this refetches regardless. Never a desync -- the batch
      // committed -- so this bumps resync only.
      () => skippedRef.current()), []);
  ```

- [ ] **Step 4: Run the affected unit tests**

Run: `cd web && pnpm vitest run src/sync/syncState.test.ts src/sync/SyncProvider.test.tsx`
Expected: PASS (a pure rename; no test in either file changes behaviour).

- [ ] **Step 5: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: PASS — confirms no stale `"ops-skipped-no-replica"` /
`onSkippedNoReplica` / `skippedNoReplicaRef` reference survives anywhere
(the `default: { const exhaustive: never = event; ... }` branch in
`transitionSync` would fail to compile against a stale union member).

- [ ] **Step 6: Commit**

```bash
git add web/src/sync/syncState.ts web/src/sync/syncState.test.ts web/src/sync/SyncProvider.tsx
git commit -m "refactor(pkm-6xza): rename the skipped-ack event and callback off no-replica"
```

---

### Task 3: Composed test — `SyncProvider` bumps `resyncSeq` on a durable skipped ack

**Files:**
- Modify: `web/src/sync/SyncProvider.test.tsx`

**Interfaces:**
- Consumes: `fakeReplicaForProvider()`, `stubFetch`, `SNAPSHOT`, `EMPTY_FEED`,
  `useSyncWhole()`, all already defined in this file (see the "leftover
  durable batches flush on first connect" test at lines 741–764 for the same
  pattern of overriding `enqueue`/`nextBatch`/`deleteBatch` on
  `fakeReplicaForProvider()` to get a real durable row).
- Produces: nothing (no other task depends on this test).

- [ ] **Step 1: Write the composed test**

Insert after the "leftover durable batches flush on first connect, then
views resync" test (after line 764, before "poison repair is not a second
writer of the pending count"):

```ts
test("a durable batch's ack naming a skipped op bumps resyncSeq (a " +
"replica-backed tab's own feed tombstones the row, but nothing else " +
"resyncs the view for it)", async () => {
  stubFetch([
    ["/api/sync/snapshot", SNAPSHOT],
    ["/api/sync/changes", EMPTY_FEED],
    ["/api/ops", {
      ok: true, ts: 1, applied: 1,
      skipped: [{ index: 0, op: "update_text", uid: "u1",
                  reason: "missing_target", note_page: "2026-09-29" }],
    }],
  ]);
  const replica = fakeReplicaForProvider();
  const rows: Array<{ id: number; batch_id: string;
                     ops: BlockOp[]; poisoned: boolean }> = [];
  let nextId = 1;
  replica.enqueue = async (ops, batchId) => {
    rows.push({ id: nextId++, batch_id: batchId, ops, poisoned: false });
    return { pending: rows.length, batchId };
  };
  replica.nextBatch = async () => rows.find((r) => !r.poisoned) ?? null;
  replica.deleteBatch = async (id) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i !== -1) rows.splice(i, 1);
    return { pending: rows.length };
  };

  let sync!: Sync;
  function Grab() { sync = useSyncWhole(); return null; }
  render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); }); // first connect settles
  const before = sync.resyncSeq;
  await act(async () => {
    await sync.enqueue([{ op: "delete", uid: "u1" }]).delivered;
  });
  expect(sync.resyncSeq).toBeGreaterThan(before);
  expect(rows).toEqual([]); // delivered normally alongside the resync bump
});
```

`before` is read only after the initial connect has fully settled, so any
bump the first connect itself produces (a leftover-batch flush, not present
here since `rows` starts empty) cannot be mistaken for the one this fix adds.

- [ ] **Step 2: Confirm the test is red against pre-Task-1 code, then green**

Temporarily revert Task 1 and Task 2's production changes (not the test
files) — e.g. `git stash push -- web/src/sync/opQueue.ts
web/src/sync/syncState.ts web/src/sync/SyncProvider.tsx` — then run:

Run: `cd web && pnpm vitest run src/sync/SyncProvider.test.tsx -t "bumps resyncSeq"`
Expected: FAIL — `resyncSeq` does not move (the pre-fix durable loop never
reads `ackSkipped` at all).

Restore the stash (`git stash pop`) and run the same command again.
Expected: PASS.

- [ ] **Step 3: Run the whole SyncProvider test file**

Run: `cd web && pnpm vitest run src/sync/SyncProvider.test.tsx`
Expected: PASS (no other test's resync-count assertions move, since the new
behaviour only fires when an ack actually names a skipped op).

- [ ] **Step 4: Commit**

```bash
git add web/src/sync/SyncProvider.test.tsx
git commit -m "test(pkm-6xza): SyncProvider bumps resyncSeq on a durable skipped ack"
```

---

### Task 4: Docs — sync-recovery.md, sync-and-offline.md, troubleshooting.md, the pkm-c2gs bean

**Files:**
- Modify: `docs/architecture/sync-recovery.md`, `docs/architecture/sync-and-offline.md`,
  `docs/troubleshooting.md`,
  `.beans/pkm-c2gs--no-replica-tab-keeps-a-ghost-block-on-screen-and-l.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Invoke the `architecture-docs` skill**

Before editing either file under `docs/architecture/`, invoke the
`architecture-docs` skill (per AGENTS.md) and follow its guidance for these
edits (both are small prose/table corrections, not new sections).

- [ ] **Step 2: Correct `sync-recovery.md` § "Ops on blocks the server no longer has" (D3)**

Failure-modes table (currently the row starting "The same, but the tab has
no replica (no feed to tombstone the ghost)"): replace it with a row that
states both paths and the true division of labour:

```markdown
| Any op the server skipped | Both delivery paths (`deliverLaneHead` and the durable batch loop in `runDrain`) read the ack's `skipped` list | Bumps resync regardless of `unavailable`; every mounted view's guarded read refetches | A replica-backed tab's own feed tombstones the replica row; the ack refetch is what tells the view, not the feed | [Ops on blocks the server no longer has](#ops-on-blocks-the-server-no-longer-has) |
```

In the "Ops on blocks the server no longer has" section's last paragraph
(currently "A tab with no replica gets no tombstone. ... A replica-backed
lane delivery does not bump, because its feed tombstones the ghost."),
replace it with:

```markdown
A tab with no replica gets no tombstone. It delivers through the
[fallback lane](#the-in-memory-fallback-lane) and drops its own WS echo, so a
ghost block would stay on screen, and each flush into it would land another
daily-note child. A replica-backed tab's feed does tombstone the replica row,
but no resync event follows from that alone, so the view keeps the ghost
until something else bumps resync. Both delivery paths -- `deliverLaneHead`
and the durable batch loop in `runDrain` -- read the ack's `skipped` list,
and a non-empty one bumps resync (`ops-skipped` in `syncState.ts`)
regardless of whether `unavailable` is latched. That is the guarded read
every resync trigger runs, not the outline repair epoch, so pending edits
elsewhere on the page survive. The extra refetch on a replica-backed tab is
harmless: it races a feed that has already converged the row.
```

- [ ] **Step 3: Correct `sync-and-offline.md` § "An online edit, end to end" (D4)**

In the mermaid diagram, the `B->>B:` step reading `apply to replica, advance
cursor,<br/>refetch visible views` becomes:

```
    B->>B: apply to replica, advance cursor,<br/>refetch visible views only<br/>when catch-up moved data or an ack skipped an op
```

The paragraph just below the diagram (currently "`skipped` matters only to a
tab with no replica, which refetches its views when the list is non-empty
(see the `resyncSeq` note below).") becomes:

```markdown
A non-empty `skipped` bumps `resyncSeq` regardless of replica state (see the
`resyncSeq` note below): a replica-backed tab's own feed tombstones the row,
but nothing else refetches the view for it.
```

- [ ] **Step 4: Run the docs check**

Run: `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/sync-recovery.md docs/architecture/sync-and-offline.md`
Expected: PASS (no drift flagged).

- [ ] **Step 5: Add the troubleshooting row**

In `docs/troubleshooting.md` § "Sync and offline" table, add a row (this is
a review-found pre-existing bug now fixed, so it qualifies per the file's own
rule: "only for a failure that happened or that a review reproduced"):

```markdown
| A replica-backed online tab keeps a ghost block after a page delete, journal cleanup, or another device's edit elsewhere, and every debounced flush into it lands another `orphan_edit` child on today's daily note | The durable batch loop in `runDrain` never read the ack's `skipped` list; only the fallback lane did, and only while `unavailable` was latched. The replica tombstones the row from its own feed, but nothing bumped `resyncSeq` for it | [sync-recovery.md § Ops on blocks the server no longer has](architecture/sync-recovery.md#ops-on-blocks-the-server-no-longer-has) | pkm-6xza |
```

- [ ] **Step 6: Append a correction to the pkm-c2gs bean's summary**

Edit `.beans/pkm-c2gs--no-replica-tab-keeps-a-ghost-block-on-screen-and-l.md`,
appending after its existing "## Summary of Changes" content (do not remove
any existing text — this is a dated correction, not a rewrite):

```markdown

**Correction (pkm-6xza, 2026-09-29):** The `unavailable !== null` guard on
`deliverLaneHead`'s callback, described above as narrowing the refetch to a
genuinely no-replica session, was wrong: it also skipped every durable
(replica-backed, online) delivery. A replica-backed tab's feed tombstones
the replica row but never bumps `resyncSeq` by itself, so the view kept the
ghost. Both delivery paths now consult `ackSkipped` unconditionally; see
pkm-6xza.
```

- [ ] **Step 7: Commit**

```bash
git add docs/architecture/sync-recovery.md docs/architecture/sync-and-offline.md docs/troubleshooting.md .beans/pkm-c2gs--no-replica-tab-keeps-a-ghost-block-on-screen-and-l.md
git commit -m "docs(pkm-6xza): correct the skipped-ack refetch invariant in sync docs"
```

---

### Task 5: Final verification, bean checklist, and summary

**Files:**
- Modify: `.beans/pkm-6xza--*.md` (bean checklist and completion)

**Interfaces:** none.

- [ ] **Step 1: Full web verification**

Run: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`
Expected: PASS. (No server files are touched by this bean; do not run server
commands. If a step of this plan turned out to touch a server file, stop and
re-check the plan against the spec before proceeding — it should not.)

- [ ] **Step 2: Tick the bean checklist**

In the pkm-6xza bean, check off all three "## Todo" items (the test/rename
item, the "both delivery paths" item, and the docs item) — the fourth item
("verify, perf, merge") is the orchestrator's, per the brief, so leave it
unchecked.

- [ ] **Step 3: Write "## Summary of Changes" on the bean**

Cover: the two files changed for behaviour (`opQueue.ts`'s durable loop and
dropped `unavailable` guard; `syncState.ts`/`SyncProvider.tsx` renames), the
test files changed (`opQueue.replica.test.ts`, `syncState.test.ts`,
`SyncProvider.test.tsx`) and what each new test pins, the docs corrected
(`sync-recovery.md`, `sync-and-offline.md`, `troubleshooting.md`, the
pkm-c2gs bean's correction), and the explicit note that `ackSkipped`/`ackSeq`
are left as hand-rolled readers for pkm-jk1d (Typed ack) to replace.

- [ ] **Step 4: Mark the bean complete**

Run: `beans update pkm-6xza --status completed` (or the TUI equivalent).

- [ ] **Step 5: Commit**

```bash
git add .beans/pkm-6xza*.md
git commit -m "chore(pkm-6xza): tick checklist, summarize, complete the bean"
```
