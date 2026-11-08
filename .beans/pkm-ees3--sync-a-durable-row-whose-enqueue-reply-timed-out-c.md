---
# pkm-ees3
title: 'Sync: a durable row whose enqueue reply timed out can be posted ahead of an earlier lane entry'
status: completed
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T14:52:33Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review findings sync F6 = replica F2 (found independently by both
reviewers). Verdict: HOLDS, reproduced in vitest. Same symptom class as the
fixed pkm-5ekv, reached by a lost reply.

## Symptom
1. Edit A's enqueue fails without persisting (SQLITE_IOERR/FULL): lane L(A).
2. A recovery lease (or any >30 s worker op) holds the gate; edit B (builds
   on A, e.g. edits A's new block) times out on the main thread after 30 s:
   lane L(B), no follows mark.
3. The gate frees; the worker runs B's enqueue anyway: durable D(B), unmarked.
4. Drain: `outbox.ts` `headPrecedes` treats a missing mark as "ahead of the
   lane", so D(B) is posted before L(A). The server skips or misplaces B's op;
   L(B) later replays as already applied. The edit is lost behind a resync.

## Cause
`opQueue.ts` `enqueue` `persist` calls `markFollows` only after
`replica.enqueue` resolves; `rpc.ts` timeouts don't cancel worker work
(`serveRpc` has no deadline).

## Fix
- [x] Red test (the verifier's repro: lane-only A, timed-out B persisted late, drain order)
- [x] Mark the batch as follows-the-lane before the RPC; clear the mark when the copy turns out not to be durable (trial run: the existing 108 opQueue tests stay green)

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

This changes the outbox ordering machine. Extend the web `sync/` suite:
- Faults: enqueue RPC timeout with the worker persisting late (the row lands
  after a later gate release); genuine enqueue failure (lane-only); gate held
  past the RPC timeout.
- Invariant: the server receives each client's batches in enqueue order
  (lane and durable copies interleaved), and every edit is present after
  convergence.
- Teeth: move `markFollows` back after the RPC and confirm the order invariant fails.

## Summary of Changes

- `opQueue.ts`: `markFollows` runs before the persist RPC; a `ReplicaError.rejected` refusal forgets the mark, since nothing was stored. `outbox.ts` docs say a mark may name a batch that never became durable.
- Tests: `opQueue.deps.test.ts` (lane-only A, B's reply lost after its row was stored, drain order); `harness.prop.ts` scenario on the real worker and server.
- Property: the queue property's `lostReply` edits (the reply rejects while the worker's write waits behind a held gate) and its order invariant; teeth mutant drops the mark for lost-reply batches. The full-stack sync suite gains a `lostReply` fault, judged by its per-client order invariant.
- Docs: sync-recovery.md § The in-memory fallback lane; a troubleshooting row.
