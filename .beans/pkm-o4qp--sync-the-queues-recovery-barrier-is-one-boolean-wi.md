---
# pkm-o4qp
title: 'Sync: the queue''s recovery barrier is one boolean with five owners; a repair can lift a barrier it never took'
status: completed
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T14:52:33Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review finding sync F1 (both paths). Verdict: HOLDS-NARROWER.

## Symptom
Path 1: a durable batch is rejected; the poison repair pauses the queue and
its snapshot fetch fails (Retry banner). An edit then reaches the queue over
the text limit or with a title the replica refuses. `enqueue`'s `persist`
emits desync without pausing; `legacyRepair.run` replaces the poison banner
(Retry vanishes) and its `onStable` calls `queue.resume("recovery")`. The
drain then posts every later durable row while the rejected batch is still
unrepaired. If the retried poison rebase takes its lease while one of those
POSTs is in flight, the snapshot already holds that row and `commitRecovery`
replays it locally a second time. Same with the startup gate holding the
barrier. Path 2: a normal recovery's `finally` resumes over a legacy lane
repair still reading.

## Cause
`queueState.ts` `transitionQueue`: `pause`/`resume` set and clear one
`recovering` boolean; nothing records who paused. Owners: startup gate
(clientRuntime), poison repair (opQueue/clientRuntime), runRecovery,
lane rejection → legacyRepair. `runRecovery` already special-cases the
poison claim; the others don't.

## Fix
- [x] Red tests for both paths (SyncProvider/clientRuntime level)
- [x] `recovering` becomes a set of owners: `pause(owner)`/`resume(owner)`; terminalReason "recovering" while non-empty; drop runRecovery's special case
- [x] A legacy repair started by a local refusal (overLimit, `rejected`) does not resume at all
- [x] Poison Retry banner not replaced by legacy-repair-started (or restored after it)

## Property testing (required)

This bean introduces or changes a state machine, so it gets full property
testing, not only unit tests (Arthur, 2026-11-07). Per
docs/architecture/checks.md § Property gate:

- Write the model from the docs (sync-and-offline.md, backend.md,
  assistant.md, frontend-editor.md as relevant), never from the code under test.
- The generator draws the whole event alphabet below, freely interleaved, and
  must reach the interleaving that found this bug.
- Show it reaches: label each named path with `event()` (server) or the
  suite tally (web) and read the rates from a real run.
- Show it has teeth: reintroduce this bug as a mutant (or a teeth route) and
  confirm the named invariant fails; a clean run passes.
- Run `proptest/check.sh` before merge; a red-first unit test for the
  original sequence goes beside the code as usual.

Sketch (fast-check; a reducer-level property plus an opQueue-level one):
- Model: a set of barrier holders, a durable queue with at most one poisoned
  row, and a lane.
- Alphabet: `pause(o)`/`resume(o)` per owner; `enqueue` (ok / lane-retained /
  overLimit / replica-rejected); `serverRejects(head)` (durable / lane);
  `repairSucceeds`/`repairFails`; `legacyStable`; `recoveryStart`/`recoveryEnd`;
  `drainStep`; `setOnline`. Must reach: poison pause → repairFails → overLimit
  enqueue → legacyStable → drainStep; and lane POST in flight → recoveryStart →
  lane 400 → recoveryEnd → drainStep.
- Invariants: drainStep posts nothing while the holder set is non-empty;
  `resume(o)` removes only o; no durable row after a poisoned row is posted
  while "poison" is held; the lane delivers in append order.
- Teeth: a `resume` that clears every holder must fail.

## Summary of Changes

- `queueState.ts`: the barrier is `holders: ReadonlySet<BarrierOwner>` over a closed union (`startup`, `poison`, `recovery`, `lane`); `resume(owner)` removes only that owner and kicks only when none is left.
- `opQueue.ts`: `pause(owner)`/`resume(owner)`; a durable 4xx and retained mark intents claim `poison`, a lane 4xx claims `lane`; `onDesync` reports `{ error, lane }`. The drain re-checks the barrier after each `nextBatch()` read (found by the new property: a pause landing while the read waited on the worker's gate did not stop the POST).
- `clientRuntime.ts`: `startup` from mount until discovery answers; `repair()` claims `poison` before `startup` lets go and resumes `poison` on success; discard releases `poison` unless a repair is running.
- `replicaSync.ts`: `runRecovery` always resumes its own `recovery` claim; the `resume` option and the poison special case are gone; an unmatched mark resumes `poison`.
- `legacyRepair.ts`: resumes `lane` only when a lane rejection is owed (across a failed run); a rejection after a run's `onStable` gets a fresh run.
- `syncState.ts`/`SyncProvider.tsx`: an unresolved poison problem keeps its Retry banner; the legacy problem waits in `legacyBehind` and shows once the poison problem ends.
- Tests: `barrier.test.ts` (both review paths), queueState/legacyRepair/syncState/opQueue.deps unit tests; property `props/sync/queue.prop.ts` with model `queueModel.ts` and teeth `queueTeeth.prop.ts`.
- Docs: sync-recovery.md § The recovery barrier, runRecovery; troubleshooting rows.
