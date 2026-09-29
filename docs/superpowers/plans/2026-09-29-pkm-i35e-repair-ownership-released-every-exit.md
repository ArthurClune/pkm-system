# Repair ownership is released on every exit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two exits of the poison-repair path that can leave
`replicaSync`'s recovery-barrier claim (`authoritativeRepair = "poison"`) held
forever: a marking round that matches no row, and `discardProblem`'s resume.

**Architecture:** `opQueue.ts`'s `markRetainedPoison` gains a round-level
signal for "intents were present, none matched." `replicaSync.ts` subscribes
to it the same way it already subscribes to `onPoisonPending`, and releases +
resumes when it fires. `SyncProvider.tsx`'s `discardProblem` action calls
`completeAuthoritativeRepair("poison")` before it resumes, unconditionally (a
no-op when no claim is held, per `completeAuthoritativeRepair`'s own reason
guard), so both its startup and mid-session branches release correctly.

**Tech Stack:** TypeScript, Vitest, React Testing Library (web/src/sync).

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md`
§ F8 (and § Shared rules); source finding:
`docs/2026-09-29-sync-subsystem-review-consolidated.md` § "F8 (P2,
pre-existing, narrow) Poison-repair ownership is claimed on a signal and
released only on success" (line ~146) and its "Tests" bullet (line ~220).

## Global Constraints

- TDD: every fix's failing test goes red, for the stated reason, before the fix.
- Every runtime file declares its FCIS pattern (`// pattern: Functional Core` /
  `// pattern: Imperative Shell`); pure predicates, classifiers and transforms
  live in Functional Core files. `pnpm check:fcis` forbids a Core file
  importing a value from a Shell module. (`opQueue.ts`, `replicaSync.ts` and
  `SyncProvider.tsx` are all already `// pattern: Imperative Shell` — this fix
  adds no new file and does not change that.)
- Code and test comments state the rule and carry NO bean id. Commit messages
  may carry the id.
- Docs land in the same branch: `docs/architecture/sync-recovery.md` § "A
  batch the server rejects" gets the ownership-lifecycle table, plus one row
  in `docs/troubleshooting.md` (symptom, cause, owning section, bean id). Any
  `docs/architecture/` edit goes through the `architecture-docs` skill; run
  `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/sync-recovery.md docs/troubleshooting.md`.
- No route or contract changes here — no openapi/web-types regen needed.
- The spec's composed test across the boundary is a task of its own (Task 4).
- Final task: web `pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`.
  The orchestrator runs the full Playwright suite and `perf/check.sh
  frontend` after merge — do not run them here. Then tick the bean checklist,
  write `## Summary of Changes`, complete the bean, commit with the code.
- Never write the two-word phrase that starts "load" and ends "bearing".
- **File overlap with sibling wave-2 beans:** `web/src/sync/SyncProvider.tsx`,
  `web/src/sync/opQueue.ts` and `web/src/sync/replicaSync.ts` are exactly the
  three files F4 (pkm-jyx1, already merged), F6 (pkm-yvka) and the Typed ack
  bean (pkm-jk1d) also touch. F6 rewrites the rebase commit path in
  `replicaSync.ts` and opQueue's ack reading; the Typed ack bean changes
  `opQueue.ts`'s ack parsing. This plan only adds one new listener pair
  (`onPoisonMarkUnmatched`) and one new subscription + one new call site — it
  does not touch `flushBatches`, `runRecovery`'s commit path, or ack parsing,
  so the collision surface is a shared file, not shared lines, but the
  executor should re-diff against `main` immediately before merging in case a
  sibling branch landed first.

## Exit inventory (poison-repair ownership: claim → release)

The claim is the module-level `authoritativeRepair` flag in
`web/src/sync/replicaSync.ts` (currently 269, set at 335, 772, cleared at 779).
Every place code can leave the poison-repair path, and what happens to the
claim there today:

| # | Exit | Where | Current behaviour | Pinned by |
|---|---|---|---|---|
| 1 | Success | `SyncProvider.tsx` `repairEventsRef`, the `try` block ending at `completeAuthoritativeRepair("poison")` + `queue.resume("recovery")` (~403-422) | Released, queue resumed | `SyncProvider.test.tsx:825` "rejected batch repair finishes before resync and later delivery" |
| 2 | Failure (repair throws: `rebaseAuthoritative`/`runRecovery`/`deleteBatch` reject) | `repairEventsRef`'s `catch` (~423-428); `runRecovery`'s own catch aborts a held lease token (`replicaSync.ts` ~444-466) | **Not released** — deliberate: the barrier must hold for the Retry banner until a repair actually succeeds | `SyncProvider.test.tsx:1565` "failed poison repair stays visible and Retry succeeds without reapplying it"; `replicaSync.test.ts:425` "poison preempts a normal recovery lease before its stale flush starts" (abort path) |
| 3 | Deferral: `markPoisoned` RPC itself throws (network/DB error, not a match failure) | `opQueue.ts` `markRetainedPoison`'s `catch` (~440-447), rethrown through `rejectDurableBatch`'s catch (~527-529) as `blocked("recovering")` | **Not released** — correct: the row is still unmarked, so the barrier must hold until a Retry re-marks it | `opQueue.replica.test.ts:643` "markPoisoned RPC failure preserves the barrier without re-POSTing"; `SyncProvider.test.tsx:1467` "a KNOWN-rejected batch still holds the gate when it cannot be repaired" |
| 4 | **Unmatched marking round** (`markPoisoned` resolves `matched: false`, e.g. Path A: row vanished between POST and mark) | `opQueue.ts` `markRetainedPoison` (~427-457): `matchedIntents` stays empty, `poison.emit` never fires | **Bug (this fix):** nothing reports the round, so `replicaSync`'s claim (set by the earlier `onPoisonPending`) is never released and the queue never resumes | Today: `opQueue.replica.test.ts:852` "a retained intent cannot poison a reused row id from another batch" (asserts the empty result, not the release). **After fix:** Task 1 + Task 2 + Task 4 |
| 5 | **`discardProblem`** (user gives up on a mark-failed intent) | `SyncProvider.tsx` `actions.discardProblem` (~663-681) | **Bug (this fix):** `queue.discardPoisonIntents()` then `queue.resume("recovery")`, but never `completeAuthoritativeRepair("poison")` | Today: `SyncProvider.test.tsx:1509` "discarding an unmarkable intent releases the wedge into online-only" (a *startup*-time discard, where no claim was ever set, so it passes either way). **After fix:** Task 3 |
| 6 | Unmount/close | N/A — `authoritativeRepair` lives in the `replicaSync` closure `useMemo` creates fresh per mount (`SyncProvider.tsx` ~355-358); the whole closure, claim included, is discarded with the component. There is no separate release step to test: nothing outlives the unmount to read a stale claim. | Not a release path | (none needed) |
| 7 | Thrown error reaching the caller of `rejectDurableBatch`/`runRecovery` | Folds into #2 (repair failure) and #3 (mark RPC failure) above — every throw on this path is one of those two, both already deliberately non-releasing | — | see #2, #3 |

Rows 4 and 5 are the bean's Path A and Path B. Rows 1, 2, 3 and 6 are existing,
correct, and already pinned — no new task changes their behaviour; they are
listed so a reviewer can see the fix does not touch them.

## Review Focus

- An unmatched round with **more than one** retained intent (not just the
  single-intent case the existing reused-id test uses) must still fire the
  new signal exactly once per round, not once per intent — Task 1's test
  uses two retained intents, both unmatched.
- The new `replicaSync` listener must be a no-op when no claim is held (the
  startup path calls `retryPoisonMarks` before `onPoisonPending` has ever
  fired) — Task 2's test asserts `queue.resume` is *not* called a second time
  when `authoritativeRepair` was already `null`.
- `discardProblem`'s release must not disturb the *other* discard branch
  (startup-time, `startupDiscoveringPoisonRef.current` true) where
  `completeAuthoritativeRepair` is a harmless no-op — Task 3 keeps
  `SyncProvider.test.tsx:1509` green unchanged as a regression guard.
- The composed test (Task 4) must prove the release happens *before* the
  queue would otherwise have healed itself via a second rejection — assert
  it against a recovery path that would stay wedged if the release were
  missing (`resetLocalData`'s `authoritativeRepair === "poison"` guard,
  `replicaSync.ts` ~786-788), not just against the eventual redelivery, which
  Path B "partly" self-heals even with the bug present.
- `markRetainedPoison`'s existing return value (`readonly PoisonEvent[]`,
  the matched intents) must not change shape — `continueStartupRef` and the
  `retry-poison-marks` plan branch in `SyncProvider.tsx` both consume it
  directly; the new signal is an additional listener, not a replacement.

---

## Task 1: `opQueue` reports an unmatched marking round

**Files:**
- Modify: `web/src/sync/opQueue.ts:91-137` (the `OpQueue` interface),
  `web/src/sync/opQueue.ts:427-457` (`markRetainedPoison`)
- Test: `web/src/sync/opQueue.replica.test.ts`

**Interfaces:**
- Produces: `OpQueue.onPoisonMarkUnmatched(fn: () => void): () => void` —
  fires once per `markRetainedPoison` call when that call's `intents` was
  non-empty and its `matchedIntents` came back empty. Never fires for a round
  with zero retained intents (the existing early return at line 430).

- [ ] **Step 1: Write the failing test in `opQueue.replica.test.ts`**

Add a test near the existing "a retained intent cannot poison a reused row id
from another batch" (line 852), reusing its `memReplica()` / stale-intent
setup but with **two** retained intents that both fail to match:

```ts
test("an unmatched marking round reports itself once, not per intent",
async () => {
  // ... two PoisonEvent intents seeded into localStorage, both for rows/
  // batch ids memReplica() has no matching row for (mark returns matched:false)
  const q = createOpQueue(replica, () => undefined);
  const unmatchedRounds: number[] = [];
  q.onPoisonMarkUnmatched(() => { unmatchedRounds.push(1); });

  await expect(q.retryPoisonMarks()).resolves.toEqual([]);

  expect(unmatchedRounds).toHaveLength(1);
});
```

Also extend the "corrupt retained mark metadata is ignored safely" test (or
add a one-line adjacent assertion) to confirm a round with **zero** retained
intents never fires it: `q.onPoisonMarkUnmatched(...)` + assert the tracker
stays empty after a `retryPoisonMarks()` call with nothing retained.

- [ ] **Step 2: Run and verify both fail**

Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts -t "unmatched marking round"`
Expected: FAIL — `q.onPoisonMarkUnmatched is not a function`.

- [ ] **Step 3: Add the listener and interface member**

In the `OpQueue` interface (after `onPoison`, ~line 117):

```ts
/** Fires once per markRetainedPoison call in which intents existed and NONE
 * matched a durable row — the ownership claim this signals has nothing left
 * to repair, unlike onPoison's per-matched-intent report. Never fires for a
 * round with no retained intents. */
onPoisonMarkUnmatched(fn: () => void): () => void;
```

In `markRetainedPoison`, add `const poisonMarkUnmatched = listeners<void>();`
alongside the other `listeners<...>()` declarations (~line 227-229), and after
the existing `matchedIntents.forEach((event) => poison.emit(event));` line
(~455):

```ts
if (intents.length > 0 && matchedIntents.length === 0) {
  poisonMarkUnmatched.emit(undefined);
}
```

Export it in the returned object next to `onPoison: poison.add,` (~837):
`onPoisonMarkUnmatched: poisonMarkUnmatched.add,`.

- [ ] **Step 4: Run and verify both pass**

Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts`
Expected: PASS, full file green (no regressions in the other ~40 tests in
this file).

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/opQueue.ts web/src/sync/opQueue.replica.test.ts
git commit -m "feat(pkm-i35e): opQueue reports an unmatched poison-mark round"
```

---

## Task 2: `replicaSync` releases and resumes on an unmatched round

**Files:**
- Modify: `web/src/sync/replicaSync.ts:129-130` (`ReplicaSyncDeps.queue` Pick
  type), `web/src/sync/replicaSync.ts:335` (subscription site)
- Test: `web/src/sync/replicaSync.test.ts`

**Interfaces:**
- Consumes: Task 1's `OpQueue.onPoisonMarkUnmatched`.
- Produces: `replicaSync` now releases `authoritativeRepair` and calls
  `queue.resume("recovery")` on an unmatched round, symmetric to how it
  claims on `onPoisonPending`.

- [ ] **Step 1: Write the failing test in `replicaSync.test.ts`**

Model on "a needs-bootstrap feed answer re-bootstraps when the queue is
empty" (line 487) for the recovery shape, and on the `queue` mock pattern
at lines 461-469 (`onPoisonPending` captured via a local `signalPoisonPending`
closure) for wiring the claim:

Give `applyChanges` a call counter so `start()`'s own first pull is
uneventful (`"applied"`) and the SECOND call — triggered by `onSeq` after the
claim is taken and released — is the one that needs a rebase, exactly as
"poison preempts a normal recovery lease before its stale flush starts"
(line 425) sequences its own two `applyChanges` calls:

```ts
test("an unmatched poison round releases ownership so a later needs-bootstrap pull can rebootstrap",
async () => {
  let applyCall = 0;
  const replica = fakeReplica({
    applyChanges: vi.fn(async (window: Changes) => {
      applyCall += 1;
      return applyCall === 1
        ? { status: "applied" as const, cursor: window.next_since }
        : { status: "needs-bootstrap" as const };
    }),
  });
  const fetchJson = vi.fn(async (path: string) =>
    path === "/api/sync/snapshot" ? SNAP : feed());
  let signalPoisonPending: () => void = () => undefined;
  let signalUnmatched: () => void = () => undefined;
  const queue = {
    pause: vi.fn(), resume: vi.fn(),
    onPoisonPending: (l: () => void) => { signalPoisonPending = l; return () => undefined; },
    onPoisonMarkUnmatched: (l: () => void) => { signalUnmatched = l; return () => undefined; },
  };
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState, queue });
  await sync.start(); // consumes applyCall #1 ("applied"), nothing poison-related yet

  signalPoisonPending();   // claims ownership, as rejectDurableBatch would
  signalUnmatched();       // the marking round matched nothing
  expect(queue.resume).toHaveBeenCalledTimes(1);

  sync.onSeq(9);
  await sync.idle(); // drives applyCall #2 ("needs-bootstrap")

  expect(replica.calls).toContain("prepareRecovery"); // rebase actually ran
  expect(replica.calls).toContain("commitRecovery");
});
```

Add a second, short assertion (same test or adjacent) that calling
`signalUnmatched()` alone, with no prior `signalPoisonPending()`, does not
call `queue.resume` a second/extra time — it must be a no-op when no claim is
held.

- [ ] **Step 2: Run and verify it fails**

Run: `cd web && pnpm vitest run src/sync/replicaSync.test.ts -t "unmatched poison round releases"`
Expected: FAIL — `needs-bootstrap` is silently deferred (`authoritativeRepair`
stuck at `"poison"`), so `prepareRecovery`/`commitRecovery` are never called
and the pull resolves with no rebase.

- [ ] **Step 3: Add the subscription**

Extend the Pick type (~line 129-130):

```ts
queue?: Pick<OpQueue, "pause" | "resume"> &
  Partial<Pick<OpQueue, "onPoisonPending" | "onPoisonMarkUnmatched" | "deliverLaneAhead">>;
```

After the existing `queue.onPoisonPending?.(...)` subscription (~line 335):

```ts
// A marking round that matched no row leaves nothing for onPoison to
// trigger a repair from; this is the other half of the claim onPoisonPending
// took above, and it must release what that claim owns and nothing more.
queue.onPoisonMarkUnmatched?.(() => {
  if (authoritativeRepair === "poison") {
    authoritativeRepair = null;
    queue.resume("recovery");
  }
});
```

- [ ] **Step 4: Run and verify it passes**

Run: `cd web && pnpm vitest run src/sync/replicaSync.test.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/replicaSync.ts web/src/sync/replicaSync.test.ts
git commit -m "feat(pkm-i35e): replicaSync releases ownership on an unmatched poison round"
```

---

## Task 3: `discardProblem` releases ownership before it resumes

**Files:**
- Modify: `web/src/sync/SyncProvider.tsx:663-681` (`actions.discardProblem`)
- Test: `web/src/sync/SyncProvider.test.tsx`

**Interfaces:**
- Consumes: `ReplicaSync.completeAuthoritativeRepair("poison")` (already
  public, used at `SyncProvider.tsx:418`).

- [ ] **Step 1: Write the failing test in `SyncProvider.test.tsx`**

Model on "rejected batch repair finishes before resync and later delivery"
(line 825) for the mid-session `fakeReplicaForProvider()` wiring, but make
`replica.markPoisoned` throw on its first call (mark RPC failure, reaching
`problem.repair === "mark-failed"` mid-session rather than at startup) and
succeed on its second (the designed re-POST heals):

```ts
test("discardProblem releases ownership before resuming, not only after the re-POST heals",
async () => {
  // ... fakeReplicaForProvider(), bad-batch rejected with 400, as in the
  // rejected-batch-repair test above.
  let markCalls = 0;
  replica.markPoisoned = async (id) => {
    markCalls += 1;
    if (markCalls === 1) throw new Error("Access Handles cannot be created");
    rows.find((row) => row.id === id)!.poisoned = true;
    return { pending: rows.filter((row) => !row.poisoned).length, matched: true };
  };
  // ... render, open ws, enqueue the bad op, await the mark-failed problem.
  expect(sync.problem).toMatchObject({ kind: "rejected-batch", repair: "mark-failed" });

  await act(async () => { await sync.discardProblem(); });

  // Ownership was actually released, not merely "will heal once redelivered":
  // resetLocalData's own barrier guard must no longer see a repair in progress.
  await act(async () => {
    await sync.resetReplica(true);
  });
  // syncState's "reset-failed" case stores the message in `resetError`, not
  // `error` (that field is the stalled-base default and stays ""); discarding
  // cleared `problem` to undefined first, so this is the only source of a
  // "reset-failed" problem here.
  expect(sync.problem).not.toMatchObject({
    reset: "failed", resetError: expect.stringContaining("in progress"),
  });
});
```

Confirm this fails against a `{ kind: "replica-stalled", reset: "failed",
resetError: "Error: rejected-batch repair in progress" }` problem before the
fix — that message comes from `resetReplica`'s generic-catch branch
(`SyncProvider.tsx:700-711`), sourced from `replicaSync.resetLocalData`'s
guard at `replicaSync.ts:786-788`. (If the fixture's replica needs more mocked
methods for the reset itself to fully succeed once the guard is passed, add
them — the assertion only depends on that guard not firing, not on the reset
completing.)

- [ ] **Step 2: Run and verify it fails**

Run: `cd web && pnpm vitest run src/sync/SyncProvider.test.tsx -t "discardProblem releases ownership before resuming"`
Expected: FAIL — `sync.problem` carries "rejected-batch repair in progress".

- [ ] **Step 3: Release before resuming**

In `actions.discardProblem` (~line 663-681), add one call right after
`applySync({ type: "poison-intents-discarded" });` and before the
`if (startupDiscoveringPoisonRef.current)` branch:

```ts
// Releases a claim this session may be holding from a rejection that has
// not yet re-entered rejectDurableBatch; harmless when no claim is held
// (completeAuthoritativeRepair only clears its own matching reason).
replicaSync!.completeAuthoritativeRepair("poison");
```

- [ ] **Step 4: Run and verify it passes**

Run: `cd web && pnpm vitest run src/sync/SyncProvider.test.tsx`
Expected: PASS, full file green — including the unchanged
`SyncProvider.test.tsx:1509` "discarding an unmarkable intent releases the
wedge into online-only" (startup branch, still a no-op release).

- [ ] **Step 5: Commit**

```bash
git add web/src/sync/SyncProvider.tsx web/src/sync/SyncProvider.test.tsx
git commit -m "feat(pkm-i35e): discardProblem releases repair ownership before resuming"
```

---

## Task 4: Composed test — the unmatched round, end to end

Task 2's test drives `replicaSync` with a mocked `queue`; nothing yet proves
the real `opQueue` + `replicaSync` + `SyncProvider` stack carries the signal
across all three. This is the spec's "composed test across the boundary" for
this fix.

**Files:**
- Test: `web/src/sync/SyncProvider.test.tsx`

**Interfaces:**
- Consumes: Tasks 1-2's `onPoisonMarkUnmatched` wiring, exercised through the
  real `createOpQueue`/`createReplicaSync` `SyncProvider` already
  instantiates (no mocks below the provider level, matching the style of
  `SyncProvider.test.tsx:825`).

- [ ] **Step 1: Write the test**

Model on "rejected batch repair finishes before resync and later delivery"
(line 825), but make `replica.markPoisoned` return `{ ..., matched: false }`
for the rejected row — the row vanished between POST and mark (Path A: e.g. a
concurrent manual reset raced the drain, simulated here simply as the mark
call reporting no match):

```ts
test("an unmatched poison mark releases ownership so delivery resumes and a later rebootstrap can run",
async () => {
  // ... fakeReplicaForProvider(), bad-batch rejected 400 as in the
  // rejected-batch-repair test.
  replica.markPoisoned = async () => ({
    pending: rows.filter((row) => !row.poisoned).length, matched: false,
  });
  // ... render, open ws, enqueue the bad op then a later good op.
  await vi.waitFor(() => { expect(posts).toEqual(["bad-batch", "good-batch"]); });

  // No repair ever ran (nothing matched), yet delivery still resumed and a
  // later bootstrap-needed pull is not silently deferred.
  expect(trace).not.toContain("prepare repair");
  await act(async () => { await sync.resetReplica(true); });
  expect(sync.problem).not.toMatchObject({
    reset: "failed", resetError: expect.stringContaining("in progress"),
  });
});
```

- [ ] **Step 2: Run and verify it fails before Tasks 1-2, passes after**

This task runs *after* Tasks 1-3 are merged into the branch, so run it simply
to confirm it passes; if you are executing tasks out of order, verify first
that reverting Task 2's subscription reproduces a "good-batch" that never
posts (queue stuck in `"recovering"`).

Run: `cd web && pnpm vitest run src/sync/SyncProvider.test.tsx -t "unmatched poison mark releases ownership"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/sync/SyncProvider.test.tsx
git commit -m "test(pkm-i35e): compose the unmatched poison round across queue, replicaSync and provider"
```

---

## Task 5: Docs

**Files:**
- Modify: `docs/architecture/sync-recovery.md:234-264` (§ "A batch the server
  rejects")
- Modify: `docs/troubleshooting.md` § "Sync and offline" (after line 126)

- [ ] **Step 1: Add the ownership-lifecycle table**

In `sync-recovery.md` § "A batch the server rejects", after the existing
paragraph ending "...resumes delivery" (~line 250) or wherever the
`architecture-docs` skill's read of the current prose suggests it reads best,
add a small table:

```markdown
| Ownership | When |
|---|---|
| Claimed | `rejectDurableBatch` emits `poisonPending`, before the durable mark |
| Released — repaired | `onPoison`'s matched intent runs the repair to success |
| Released — unmatched round | `markRetainedPoison` matches no row; `replicaSync` releases and resumes on its own |
| Released — discarded | `Sync.discardProblem()` drops the retained intents and releases before it resumes |
```

Update the existing "Discard rejected change" sentence (~line 261-264) if it
now reads as though discard were only a startup-time action — it already
isn't, per the code, so confirm the prose says so or fix it if the skill's
read flags it as one of the "docs vs code" gaps.

- [ ] **Step 2: Add the troubleshooting row**

Append one row to the "Sync and offline" table (after the pkm-jyx1 row, line
126), following the existing column order (`Symptom | Cause | Where | Ref`):

```
| A durable batch stays paused for the rest of the session after the row it was rejecting is gone (or after "Discard rejected change") | The repair-ownership claim released only inside a matched-intent repair; an unmatched marking round and a plain discard both resumed the queue without releasing it | [sync-recovery.md § A batch the server rejects](architecture/sync-recovery.md#a-batch-the-server-rejects) | pkm-i35e |
```

- [ ] **Step 3: Run the docs checker**

Run: `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/sync-recovery.md docs/troubleshooting.md`
Expected: no broken links/anchors, no new 40+-word sentences, no dropped
inline-code identifiers flagged as unintentional.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/sync-recovery.md docs/troubleshooting.md
git commit -m "docs(pkm-i35e): repair-ownership lifecycle table and troubleshooting row"
```

---

## Task 6: Final verification and bean completion

- [ ] **Step 1: Full web verification**

Run: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`
Expected: all pass; coverage gate holds (no new untested branches — the two
new listener bodies and the one new `discardProblem` line are exercised by
Tasks 1-4's tests).

- [ ] **Step 2: Tick the bean checklist and write the summary**

`beans show pkm-i35e`'s three `[ ]` Todo items become `[x]`; add a
`## Summary of Changes` section to the bean (or its final comment, per the
beans workflow) naming the two exits closed and the files touched.

- [ ] **Step 3: Complete the bean**

Run: `beans complete pkm-i35e` (or the project's equivalent close command).

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore(pkm-i35e): tick bean checklist and summarize F8 fix"
```

## Self-review notes

- **Spec coverage:** the spec's "Mechanism" names exactly two branches
  (unmatched round, discard) and one composed test; Tasks 1-3 are the two
  branches, Task 4 is the composed test, Task 5 is the named doc correction
  plus the shared-rule troubleshooting row.
- **Exit enumeration:** all seven exits the bean brief asked for are in the
  table above, each with an existing or new test citation; unmount/close is
  explained as not applicable rather than silently dropped.
- **Type consistency:** `onPoisonMarkUnmatched` is named and typed once (Task
  1) and consumed with the same name in Task 2 and the `ReplicaSyncDeps`
  Pick type; no renaming across tasks.
- **Proportion:** six small tasks against a ~25-line spec section; no task
  transcribes a function body the signature/test doesn't already determine.
