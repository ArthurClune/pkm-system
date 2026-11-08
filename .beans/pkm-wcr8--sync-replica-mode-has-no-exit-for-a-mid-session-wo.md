---
# pkm-wcr8
title: 'Sync: replica mode has no exit for a mid-session worker death or a failed first bootstrap'
status: completed
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T15:41:31Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review findings sync F2 and F3. Verdicts: F2 HOLDS-NARROWER, F3 HOLDS.

## Symptom
F2: the replica worker emits `error` mid-session (crash, chunk 404 after a
deploy against a stale index.html). Every RPC rejects with a terminal
`RpcLifecycleError`, but `replicaState.mode` stays "ready" and
`appliedVersion()` keeps its old number. Reconnects never resync views
(`reconnectFlow` sees no movement), offline reads hit a dead shim, and
offline edits sit in the in-memory lane, lost on an iPad reload.
F3: the first bootstrap fails while the socket stays up (PullStarvedError
from typing during a cold-start snapshot after PENDING_CHANGED_CAP restarts,
a 5xx on /api/sync/snapshot, an applySnapshot RPC timeout). Mode stays
"starting" with no banner and nothing retries until the WebSocket itself
reconnects (hours on desktop). The user discovers offline mode never set up
when the network drops.

## Cause
`replicaSync.ts` `noteFailure` latches `usable = false` only for
`availabilityOf(error) === "unusable"` and never reports a mode;
`doStart` has no failure transition (no retry, no onState) because
`noteFailure` runs only on the pull path. "Is there a database" is answered
separately by `replicaSync.usable`, `opQueue.availability` and
`ReplicaState.mode`; only the queue treats worker-error as fatal.

## Fix
- [x] Red tests: RpcLifecycleError from a pull; bootstrap failure with the socket up
- [x] `noteFailure`: any `isSessionFatal` error latches unusable AND reports a mode (no-replica or a new unavailable), so appliedVersion reads null and canEdit/the gateway follow
- [x] `doStart` failure takes the pull's backoff retry (and counts toward stall so it surfaces), or reports recovery-failed
- [x] Distinguish "started once and failed" from "cold start in progress" in what the UI shows

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

Sketch (extend the web `sync/` suite's fault alphabet; oracle invariants in
`props/sync/oracle.ts`):
- Faults: worker death at an arbitrary step (all later RPCs reject with
  worker-error); snapshot fetch 5xx; applySnapshot timeout; pending-set churn
  during bootstrap (typing) up to starvation.
- Invariants: within a bounded number of steps after a fatal worker error,
  mode is not "ready" and canEdit agrees with it; a failed first bootstrap is
  retried while connected and eventually reaches ready once faults stop;
  no edit is accepted into a lane that can never deliver without the UI
  saying so.
- Teeth: restore the old `noteFailure` latch and confirm the mode invariant fails.

## Summary of Changes

- `replicaSync.noteFailure` treats every `isSessionFatal` error (a dead
  worker's terminal RPC client, a latched failed open) as the end of replica
  mode: `usable` false, mode `no-replica` carrying the error, no retry, and
  `pull()` becomes a no-op. `doStart`'s init path does the same.
  `SyncProvider` raises the `replica-unusable` banner (Reload) from a
  `no-replica` report that carries an error.
- A failed `start()` (bootstrap, starved bootstrap, schema recovery) goes
  through `noteFailure`: it retries on the pull's backoff (the timer runs
  `start()` while not started) and counts towards `STALL_AFTER_FAILURES`.
  `start()` still rejects. The schema-recovery failure now rejects too
  instead of resolving. Recovery entrants with `awaitInFlightPull` also
  await a start in flight.
- The UI distinction: a failed first start that keeps failing is reported
  `stalled` ("Local sync is stuck", Reset local data) rather than staying
  `starting`. A start failing only on uncounted errors (offline, an RPC
  timeout) is retried silently, which is a cold start still in progress.
- Property: the sync suite draws `WorkerDies`, a `snapshot5xx` fault and a
  failing first bootstrap per client; `ModeWatch` in `oracle.ts` and
  `settleReplicas` in `sync.prop.ts` check the mode rules; teeth by hand
  (old latch, no start retry) both fail.
- Docs: sync-recovery.md § Replica mode and § A pull that keeps failing;
  two troubleshooting rows.
- Found by the property at the gate: a feed rebase that a poison repair
  had preempted met the dead worker at its lease, and pullLoop left that
  failure to the poison repair, so the mode stayed ready. `leftToPoison`
  now defers only failures that are not session-fatal (unit test beside
  the code). The property's `afterPull` pulls a second time when the first
  joined a pull already under way.
