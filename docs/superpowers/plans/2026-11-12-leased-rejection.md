# Leased-POST Rejection Implementation Plan (pkm-3ono)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A terminal 4xx on a recovery's leased POST is handled as the drain
handles it: a durable row is poisoned, a lane entry is discarded with an
outline repair. There is no recovery-failed banner and no discard prompt.

**Architecture:** `opQueue.ts` gains two shared helpers. The drain's
rejection sites and the leased sites both call them, so each rule lives in
one place. The leased durable path starts the poison mark without awaiting
it, because the recovery's own lease holds the worker gate the mark
must pass. `replicaSync.flushLease`'s blocking branch refuses with the
existing "rejected-batch repair in progress" error when a poison claim landed.

**Tech Stack:** TypeScript, vitest, fast-check property suites under
`web/src/props`.

**Spec:** `docs/superpowers/specs/2026-11-12-leased-rejection-design.md`

Work in the worktree `.worktrees/3ono-leased-rejection` (branch
`fix/3ono-leased-rejection`). All paths below are relative to its root.

## Global Constraints

- `isTerminalRejection` (`web/src/sync/rejection.ts`) is unchanged.
- The drain's observable behaviour is unchanged. Its existing tests must stay
  green without edits.
- `deliverLeased` must never await `markRetainedPoison`. That would stall the
  run on its own lease's worker gate.
- A rejected leased row must never reach `heldAcks` (`replicaSync.ts`), so
  `deliverLeased` throws on it.
- Non-terminal failures (5xx, network, 401/403/408/429) keep throwing with
  the lane entry retained, as today.
- Comment rules from AGENTS.md: no bean ids in code comments, wrap comments
  at 80 columns, and only comments the next reader would otherwise spend tool
  calls on.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>` and carry no session URL.

## Review Focus

1. A leased mark that fails (`markPoisoned` throws): must surface through
   `onPoisonMarkFailed`, never as an unhandled rejection. Task 1, test B.
2. The queue disposed while the leased mark waits: the floating
   `markRetainedPoison` throws "op queue disposed". It must be swallowed.
   Task 1, test B covers the catch.
3. Two calls racing the same lane head, both rejected (drain plus leased, or
   two leased): `settleLaneHead` already tolerates a double settle. The
   helper must not throw on the second. Task 2, test B.
4. A leased 503: nothing is claimed, no intent is kept, the ticket stays
   pending. Task 1, test C.
5. A blocking reset whose lease was lost *and* whose row was rejected: the
   lost lease still wins (`keeper.assertHeld()` runs first). Keep that order
   in Task 3. No new test is needed, because the existing lost-lease reset
   tests cover it.

---

### Task 1: Leased durable rejection poisons the row

**Files:**
- Modify: `web/src/sync/opQueue.ts` (`rejectDurableBatch`, `deliverLeased`,
  the `deliverLeased` doc comment on the `OpQueue` interface)
- Test: `web/src/sync/opQueue.replica.test.ts`, new
  `describe("deliverLeased's rejection")` after `describe("deliverLeased's
  lane ahead")`

**Interfaces:**
- Produces (internal to `createOpQueue`):
  `const claimRejectedBatch = (batch: PendingBatch, error: ApiError): void`.
  It is the synchronous half of `rejectDurableBatch`: `dispatch({ type:
  "pause", owner: "poison" })`, `rememberPoisonMark(event)`,
  `finishDelivery(batch.batch_id, { status: "failed", error })`, `outbox =
  forget(outbox, batch.batch_id)`. `rejectDurableBatch` keeps its signature
  and becomes `claimRejectedBatch` + `await markRetainedPoison()` + its
  existing outcomes. Move its existing comments into the helper.

- [ ] **Step 1: Write failing tests** in the new describe. Build the queue as
  the existing `laneThenDurable` does, but with no lane entry: offline, one
  durable `enqueue([op("tuid-bad")])`, `post` throwing `new ApiError(400,
  "/api/ops", "bad op")`. Gate `markPoisoned` with `deferred()` as
  "a durable rejection claims poison before its mark is written" does.
  - **A** `"a leased batch the server rejects claims poison, keeps its mark
    intent, fails its ticket and throws, without awaiting the mark"`:
    `deliverLeased(row, () => undefined)` rejects with
    `toMatchObject({ status: 400 })` while the mark gate is still closed.
    Then `q.holds("poison")` is true. `q.poisonMarkIntents()` names
    `row.batch_id`. The ticket's `delivered` resolves
    `{ status: "failed", ... }`. `markStarted` has resolved. No `onPoison`
    has fired. After `markGate.resolve()`, `onPoison` fires once
    (`vi.waitFor`), and `q.holds("poison")` is still true.
  - **B** `"a leased batch's mark that fails is reported through
    onPoisonMarkFailed, not thrown"`: `markPoisoned` throws
    `new Error("SQLITE_BUSY")`. `deliverLeased` rejects with the 400.
    `onPoisonMarkFailed` fires once (`vi.waitFor`). `holds("poison")` stays
    true. No unhandled rejection: vitest fails the file on one. Then
    `q.dispose()` with a second gated mark still pending, and await a tick.
    Nothing escapes.
  - **C** `"a leased batch's 503 claims nothing and keeps its ticket
    pending"`: `post` throws `new ApiError(503, "/api/ops")`.
    `deliverLeased` rejects. `holds("poison")` is false. `poisonMarkIntents()`
    is `[]`. The ticket is still pending (`Promise.race` against
    `"pending"`, as the neighbouring tests do).

- [ ] **Step 2: Run them and see A and B fail**
  Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts -t "deliverLeased's rejection"`
  Expected: A and B FAIL (`holds("poison")` false, no intent). C passes, and
  it pins today's behaviour.

- [ ] **Step 3: Implement.** Extract `claimRejectedBatch` as above. In
  `deliverLeased`, wrap the final `postOps` in try/catch. On
  `isTerminalRejection(error)`: call `claimRejectedBatch(batch, error)`,
  then `void markRetainedPoison().catch(() => undefined)`, then rethrow
  `error`. Otherwise rethrow. Give the `void` one comment: the recovery's own
  lease holds the worker gate the mark passes, so the mark lands after the
  run aborts, and a mark failure is already reported by `onPoisonMarkFailed`.
  Rewrite the interface doc's last sentences to say: a terminal rejection of
  the batch claims `poison`, keeps the mark intent, fails its ticket, starts
  the mark without awaiting it, and throws. Any other POST failure throws,
  leaving a lane entry retained.

- [ ] **Step 4: Run the file, which should pass in full**
  Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts`
  Expected: all PASS, the drain's poison tests included and unedited.

- [ ] **Step 5: Commit** `web/src/sync/opQueue.ts`,
  `web/src/sync/opQueue.replica.test.ts`, with the message: "A leased batch the
  server rejects claims poison and starts its mark (pkm-3ono)".

### Task 2: Leased lane-ahead rejection discards the entry and goes on

**Files:**
- Modify: `web/src/sync/opQueue.ts` (`deliverLaneAhead`, `deliverLaneHead`)
- Test: `web/src/sync/opQueue.replica.test.ts`, in
  `describe("deliverLeased's lane ahead")`

**Interfaces:**
- Produces (internal):
  `const discardRejectedLaneHead = (head: LaneEntry, error: ApiError): void`.
  It runs `dispatch({ type: "pause", owner: "lane" })`,
  `settleLaneHead(head, { status: "failed", error })` and
  `desync.emit({ error, lane: true })`, and takes `deliverLaneHead`'s
  existing comment. `deliverLaneHead` calls it, then
  `return blocked("recovering", error)` as now.

- [ ] **Step 1: Write failing tests**
  - **A** `"a lane entry ahead that the server rejects is discarded, pauses
    lane and desyncs, and the leased batch still posts"`: use
    `laneThenDurable` with `answer` throwing `ApiError(400)` for the lane
    body only (as "deliverLeased posts while the lane claim holds" does), and
    keep the queue offline. `deliverLeased(leased, () => undefined)`
    resolves `{ seq: 7, skipped: [] }`. The bodies' ops are
    `[[op("tuid-lane")], [op("tuid-leased")]]`. `lane.delivered` resolves
    `{ status: "failed", ... }`. `q.holds("lane")` is true. `onDesync` got
    one event with `lane: true` and `error.status === 400`.
    `onUnsentInMemory`'s last value is 0.
  - **B** `"two leased deliveries racing a lane head the server rejects both
    finish, and the next lane entry still goes out"`: two lane entries, then
    one durable row. The first lane body is answered 400, the rest ok. Start
    two `deliverLeased` calls at once and await both. Neither throws. The
    second lane entry's `delivered` resolves `{ status: "delivered" }`.
    `holds("lane")` is true.
  - Keep "deliverLeased throws and keeps the lane entry when its POST fails"
    as it is: it is the non-terminal case.

- [ ] **Step 2: Run and see A fail**
  Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts -t "lane ahead"`
  Expected: A FAILS, rejecting with the 400.

- [ ] **Step 3: Implement.** Extract `discardRejectedLaneHead`. In
  `deliverLaneAhead`, catch around `postOps`. On a terminal rejection, call
  the helper and `continue` the loop. Rethrow anything else. Update its doc
  comment: a terminal rejection is discarded as the drain discards it, and
  any other error leaves the entry retained.

- [ ] **Step 4: Run the file**
  Run: `cd web && pnpm vitest run src/sync/opQueue.replica.test.ts`
  Expected: all PASS.

- [ ] **Step 5: Commit**, with the message: "A leased flush discards a lane
  entry the server rejects and goes on (pkm-3ono)".

### Task 3: A blocking reset over a rejected row is no discard prompt

**Files:**
- Modify: `web/src/sync/replicaSync.ts` (`flushLease`, `resetLocalData`)
- Test: `web/src/sync/replicaSync.test.ts`

**Interfaces:**
- Consumes: Task 1's contract. `deliverLeased` claims `poison` and throws on
  a terminal rejection.
- Produces: a module constant `POISON_OWNS_RECOVERY = "rejected-batch repair
  in progress"`, used by `resetLocalData`'s up-front refusal and by
  `flushLease`.

- [ ] **Step 1: Write failing tests.** Extend `leasedQueue` to also return
  `holdsPoison: () => real.holds("poison")`, passed to `createReplicaSync`'s
  `holdsPoison`. The existing callers ignore it.
  - **A** `"a blocking reset whose leased batch the server rejects refuses as
    a rejected-batch repair, not ResetBlockedError"`: modelled on "resetLocalData
    without discardPending surfaces a blocked reset when flush fails". There,
    `/api/ops` throws `new ApiError(400, "/api/ops", "bad batch")`. Expect
    the error to match "rejected-batch repair in progress" and not to be a
    `ResetBlockedError`. `abortRecovery` is called, `commitRecovery` is not,
    there are 0 snapshot calls, and `resume.mock.calls` is
    `[["recovery"]]`.
  - **B** `"a preemptible recovery whose leased batch the server rejects
    reports no recovery-failed"`: drive a feed `needs-bootstrap` as "poison
    preempts a normal recovery lease before its stale flush starts" does. The
    lease holds one unpoisoned row, `/api/ops` throws the 400, and the queue
    is `leasedQueue` with its `holdsPoison`. After `sync.idle()`, no
    `onState` call has mode `recovery-failed`, `abortRecovery` is called,
    and `commitRecovery` is not.

- [ ] **Step 2: Run them.** A FAILS (`ResetBlockedError`). B passes once
  Task 1 is in, since `runRecovery` already reads the claim. It pins the
  integration.
  Run: `cd web && pnpm vitest run src/sync/replicaSync.test.ts -t "rejects"`

- [ ] **Step 3: Implement.** In `flushLease`'s blocking catch, after
  `keeper.assertHeld()`: `if (holdsPoison()) throw new
  Error(POISON_OWNS_RECOVERY, { cause });`. Its comment should say that the
  poison repair now owns the row, so asking the user to discard the queue
  would be the wrong question. Use the constant in `resetLocalData`.

- [ ] **Step 4: Run** `cd web && pnpm vitest run src/sync/` and expect all
  PASS.

- [ ] **Step 5: Commit**, with the message: "A blocking reset over a rejected
  leased row defers to the poison repair (pkm-3ono)".

### Task 4: The queue property models a leased rejection as a rejection

**Files:**
- Modify: `web/src/props/sync/queueHarness.ts` (`case "respond"`)
- Modify: `web/src/props/sync/queueModel.ts` (header only, if its wording
  ties `poison` or `lane` to the drain)
- Modify: `web/src/props/sync/queue.prop.ts` (`REACH` floors and comment)
- Modify: `web/src/props/sync/queueTeeth.prop.ts` (new mutant)

- [ ] **Step 1: Change the harness.** Delete the `info.bad && p.leased`
  early return. A leased rejection then takes the existing `info.bad`
  branch: a durable copy adds `model.poison`, and a lane copy deletes it from
  `laneWaiting` and sets `model.lane`. Keep counting
  `` `leased ${p.copy} batch rejected` `` for leased posts, alongside the
  existing labels. Update the harness header if it describes the old
  behaviour.

- [ ] **Step 2: Add the teeth mutant** `leasedNotTerminal`. It is a
  `vi.mock("../../sync/rejection")` whose `isTerminalRejection` returns false
  while `mutants.inLeased && mutants.leasedNotTerminal`, which restores
  today's behaviour exactly. Register `"a leased flush that ignores a
  rejection breaks the claim"`, with `catches` set to whichever rules
  actually fail. Run it and list those rules; expect `claim`. Add a header
  line in the file's list.
  Run: `proptest/check.sh web --file sync` (from the repo root)
  Expected: the property passes, and every teeth mutant, the new one
  included, is caught.

- [ ] **Step 3: Floors.** If the run reports a reach floor missed or a new
  label without one, set floors per `docs/architecture/checks.md` § Property
  gate. Leased lane rejections now continue into the leased batch, so
  "respond ... (leased lane)" may gain enough reach for a floor. Update the
  dated comment.

- [ ] **Step 4: Commit**, with a message that gives the reason: the property
  pinned the bug ("deliverLeased throws: no poison mark"), and the model now
  states the rule from sync-recovery.md that all three delivery sites
  share (pkm-3ono).

### Task 5: Docs, gates, bean

**Files:**
- Modify: `docs/architecture/sync-recovery.md`
- Modify: `.beans/pkm-3ono--*.md`

- [ ] **Step 1: Invoke the `architecture-docs` skill**, then update:
  - § A batch the server rejects: "at both delivery sites in `opQueue.ts`"
    becomes the drain's two sites and the recovery's leased POST
    (`deliverLeased`, the lane ahead included). The guard table's
    `rejectDurableBatch` row also names `deliverLeased`. Add one sentence of
    rule, with its reason: the leased path starts the mark without awaiting
    it, because the run's own lease holds the worker gate the mark passes.
  - § The recovery barrier table: `poison` claimed by also lists
    `deliverLeased`, and `lane` claimed by also lists `deliverLaneAhead`.
  - § runRecovery's `RecoveryOptions` table, the manual-reset cell: a failed
    flush raises `ResetBlockedError` unless the lease was lost or a poison
    claim landed. The latter refuses as "rejected-batch repair in progress".

- [ ] **Step 2: Gates**, run serially from the repo root with
  `set -o pipefail`:
  `cd web && pnpm verify`, then `proptest/check.sh web` (foreground, long
  timeout), then `perf/check.sh frontend`. Record the perf table for the
  review package.

- [ ] **Step 3: Bean.** Tick the checklist and add a `## Summary of Changes`
  that names the symptoms ("recovery-failed" banner; a reset asking to
  discard pending edits), the cause, and the doc section. Mark it
  `completed`. Epic `pkm-4gda` then has no open children, so complete it too.

- [ ] **Step 4: Commit** the docs and beans, with the message: "Docs: all three
  delivery sites handle a terminal rejection (pkm-3ono)".
