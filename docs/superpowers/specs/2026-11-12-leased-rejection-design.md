# A recovery's leased POST handles a terminal rejection (pkm-3ono)

Short design. Approved 2026-11-12.

## Intent

A batch the server rejects outright (`isTerminalRejection`) should get the
same handling whichever path posted it. Today the drain handles it and a
recovery's leased flush (`OpQueue.deliverLeased`, with `deliverLaneAhead`
before it) does not: the rejection throws out of `flushBatches`. The user
then sees a recovery-failed banner, or a Reset local data that raises
`ResetBlockedError` and asks them to discard every pending edit because of
one bad row. The state does converge once the drain re-posts the row, but
only after showing the wrong problem.

**Goal:** a rejection on the leased path leads to the poison repair (durable
row) or the outline repair (lane entry), with no recovery-failed banner and no
discard prompt.
**Non-goals:** changing what counts as terminal; changing the drain's paths.
**Anti-goal:** a leased rejection that delays a recovery until its lease
expires, or one whose row the recovery commit deletes before the poison
repair can find it.

## Constraint the fix must respect

The drain's `rejectDurableBatch` awaits `markRetainedPoison`, whose
`markPoisoned` RPC passes the worker's recovery gate. Inside a recovery the
recovery's own lease holds that gate, so awaiting the mark from
`deliverLeased` would stall the run until the lease expired. The mark has to
be started without being awaited, and it lands once the run lets go of the
gate.

## Approaches

1. **Handle the rejection inside `OpQueue` (chosen).** `deliverLeased` and
   `deliverLaneAhead` apply the drain's rules themselves. The queue already
   owns poison intents, the barrier and the lane, so the rule stays in one
   file beside the drain's version of it.
2. **Return a "rejected" outcome and let `replicaSync` decide.** It moves
   queue-internal steps (intent, ticket, outbox mark) behind a new
   interface for no gain. `replicaSync` already reads a poison claim as
   "not a failure", so nothing there needs to choose.
3. **Leave it to the drain's re-post.** This is the current behaviour, and it
   is the reason the bug was filed.

## Design

**Durable leased batch rejected.** `deliverLeased` does the synchronous half
of `rejectDurableBatch`: pause `poison`, remember the mark intent, fail the
batch's delivery ticket, forget its outbox mark. It then starts
`markRetainedPoison` without awaiting it (a failure is already reported by
`onPoisonMarkFailed`) and rethrows the `ApiError`. Share that synchronous half
with `rejectDurableBatch` rather than copying it. Because it throws, no ack
reaches `heldAcks`, so the recovery commit leaves the row for the poison
repair.

- Preemptible recovery: `runRecovery`'s catch sees `holdsPoison()`, reports
  nothing and aborts the lease. The gate frees, the mark lands, `onPoison`
  starts the repair, and the rejected-batch banner follows.
- Blocking reset: `flushLease`'s catch checks `holdsPoison()` after
  `keeper.assertHeld()` and throws the "rejected-batch repair in progress"
  error that `resetLocalData` already throws up front, not
  `ResetBlockedError`. The rejected-batch problem outranks the reset events
  in `syncState`, so whichever folds first, the user ends on that banner and
  can reset again after the repair.

**Lane entry ahead rejected.** `deliverLaneAhead` does what `deliverLaneHead`
does on a terminal rejection: pause `lane`, settle that entry `failed`, emit
`onDesync` with `lane: true`. It then continues with the next entry and the
leased batch, as `sync-recovery.md` § The recovery barrier already allows (a
leased flush posts while `lane` holds).

**Other failures** keep throwing, with the lane entry retained.
`deliverLeased`'s interface doc changes to say so.

## Left to the builder

- Tests, red first: a unit test in `opQueue.replica.test.ts` for a leased 400
  (poison claimed, intent kept, mark issued, throws) and for a lane-ahead 400
  (entry discarded, desync emitted, leased batch still posted); a
  `replicaSync` test that a blocking reset over a poison claim does not raise
  `ResetBlockedError`, and that a preemptible run reports no
  recovery-failed.
- The property harness (`props/sync/queueHarness.ts`, `case "respond"`)
  models today's behaviour ("deliverLeased throws: no poison mark, and a lane
  entry stays") and must change in the same branch, with the reason in the
  commit message. Re-check `props/sync/queueModel.ts`'s header.
- Docs: `sync-recovery.md` § A batch the server rejects (both delivery
  sites becomes all three, plus the guard table), via the
  `architecture-docs` skill.
- Gates: `pnpm verify`, `proptest/check.sh web`, `perf/check.sh frontend`.
