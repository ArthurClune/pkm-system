---
# pkm-2zbs
title: 'Replica: an unreadable pending_ops wedges every session and strands in-memory edits'
status: in-progress
type: bug
priority: normal
tags:
    - state-machine-review
created_at: 2026-11-07T18:42:45Z
updated_at: 2026-11-08T15:18:25Z
parent: pkm-zk8b
---

Found by the state-machine review of 2026-11-07 (explicit and implicit machines, six area reviewers, then an adversarial verification pass). Verified against main @ a5bb85b3. Review findings replica F1 and F3. Verdict: F1 HOLDS, worse than first
reported; F3 HOLDS-NARROWER.

## Symptom
Page-level damage on the `pending_ops` b-tree or `sqlite_master` (the kind
pkm-h1c6/pkm-87cf saw in production): `init` → `queueDb` →
`readPendingBatches` throws SQLITE_CORRUPT, a plain ReplicaError, so
`doStart` rethrows and the pull loop's corruption rebuild is never reached.
"Reset local data" goes through `prepareRecovery`, whose capture throws the
same error before any lease. At startup poison discovery fails and holds the
delivery barrier; mid-session the drain's failing `nextBatch` blocks it.
Edits pile up in the in-memory lane and never reach the server; an iPad
reload loses them. The file survives reloads, so every session wedges until
site data is cleared by hand.

F3: `replaceFileAfter` and `adoptLeftoverCarry` do
`await deps.discardDbFile(); dbPromise = null;`. If the unlink throws after
`closeDb()`, handlers keep using a closed handle (reset path has no retry).

## Fix
- [ ] Red tests: init and prepareRecovery over a failing pending_ops read; a throwing discard
- [ ] "Queue unreadable" becomes a named outcome of init/prepare: carry what is readable (`probe(readDurablePendingRows)`), replace the file, as adoption already does
- [ ] Lane edits deliver even while the durable queue is unreadable
- [ ] `try { await deps.discardDbFile(); } finally { dbPromise = null; }` in both places

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

Sketch (fast-check over `buildHandlers` with the in-memory sqlite harness
`workerHandlers.test.ts` uses):
- Model: the set of pending rows and which reads are made to fail.
- Alphabet: enqueue, deleteBatch, markPoisoned, nextBatch, init,
  prepareRecovery/commit/abort, poisonedBatches; plus "inject an unreadable
  read" on pending_ops or the schema at any step, "rows partially readable"
  (probe returns a prefix), and "discard throws once".
- Invariants: after any injected unreadable read the next queue handler
  succeeds (no permanent wedge); every row readable at the moment of failure
  is present afterwards with its id and batch_id; no carry is left once a
  handler succeeds; a carry exists whenever the old file is unlinked and the
  import has not committed.
- Teeth: remove the new catch in `queueDb` and confirm the no-wedge invariant fails.
