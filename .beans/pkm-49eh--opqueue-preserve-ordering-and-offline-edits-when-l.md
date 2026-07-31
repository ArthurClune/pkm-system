---
# pkm-49eh
title: 'opQueue: preserve ordering and offline edits when local op persistence fails'
status: completed
type: bug
priority: high
created_at: 2026-07-31T16:05:27Z
updated_at: 2026-07-31T16:42:00Z
parent: pkm-6phf
---

Finding 1 of epic pkm-6phf (web review).

**References:** web/src/sync/opQueue.ts:437-463

When replica.enqueue() fails (quota, OPFS access-handle contention, SAH pool exhaustion), the queue posts the operation directly with postOps(). This bypasses offline state, retry/backoff, recovery barriers, and older durable batches. Offline failure leaves the operation neither persisted nor retryable; online delivery can overtake dependent operations.

**Direction:** Add an ordered in-memory fallback lane governed by the existing connectivity, retry, and recovery policy. Freeze or clearly degrade editing when local durability is unavailable, and retain operations until delivery or an explicit discard decision.

- [x] Add regression tests for offline persistence failure and ordering behind older durable batches
- [x] Implement ordered fallback delivery without bypassing queue policy

## Summary of Changes

`createReplicaQueue` no longer POSTs from `enqueue()` when `replica.enqueue`
rejects with a local-storage failure (quota `ReplicaError`, OPFS access-handle
contention, exhausted SAH pool). The classification is unchanged — a local
failure is not a server rejection, so `onDesync` and its outline-wiping repair
still must not fire (pkm-c9hp, pkm-ndcu) — but the destination is: the ops join
an ordered in-memory fallback lane and are delivered only by `runDrain()`,
under the same `queueState` policy as durable rows.

That direct post had four defects, all fixed here: offline it POSTed into a
dead network and then retained nothing (the ticket resolved `failed` and the
edit was gone); it ignored `qstate.recovering`, so it could push ops past a
poison-repair barrier; it never consulted the retry/backoff policy, so one
transient 5xx discarded the edit; and it jumped the FIFO order, delivering a
new op ahead of older durable rows it might depend on.

Ordering rule: each lane entry carries `durableAhead`, the number of durable
batches that must reach a terminal state before it. The first entry into an
empty lane takes `await countPending()`; later entries take
`durableSinceFallback` (durable batches persisted since the previous entry was
appended), which then resets. A durable batch decrements the head's counter
when it is *delivered* or when it is *poisoned* — poisoning counts because the
recovery coordinator deletes the poisoned row outside the queue, so no
`deleteBatch` ever arrives for it and a head left waiting on it would be
overtaken by the next batch enqueued after it. `runDrain` posts the head before
pulling another durable batch once its counter reaches 0. When `nextBatch()`
returns `null` every entry's counter — and `durableSinceFallback` — is cleared:
nothing durable can still be ahead of anything, which reconciles both a
`pendingCount` that was stale when read and a queue a rebase flushed away, and
guarantees liveness, since the loop can never spin waiting on a predecessor
that will never arrive.

A lane entry's `batch_id` is minted once, at append time, so a retry re-POSTs a
byte-identical payload under the same id (the server binds `batch_id` to
sha256(ops)); this mirrors `frozen` in the legacy queue. A 4xx has no durable
row to poison, so it follows the legacy queue's terminal-4xx shape instead:
discard exactly the rejected entry — the only discard the queue makes on its
own, this bean's "explicit discard decision" — raise the recovery barrier so
later entries cannot overtake the repair, and call `onDesync` so the
authoritative repair runs. `pending` counts and `onPending` emissions now
include retained entries, so the header's "Offline — N changes pending" stops
lying. `dispose()` settles every retained entry as failed while leaving the lane
populated, so the terminal pending diagnostic still reports those ops.

**Non-goal, deliberately not done:** the direction line above also floats
"freeze or clearly degrade editing when local durability is unavailable".
Today `onQuota` → `SyncProvider`'s `quotaExhausted` → `computeEditability`
already freezes the editor offline for quota exhaustion only. Extending that
freeze to SAH contention and pool exhaustion is a user-visible product
decision, and with the lane in place it now cuts the other way: those edits are
retained and delivered, so freezing would remove function rather than prevent
loss. The existing quota freeze is left exactly as it is; Arthur to decide
separately.

Review round 1 fixed two ordering/leak defects in the above: a poisoned durable
batch left a phantom `durableAhead` (so a batch enqueued after a retained op was
posted ahead of it once the repair resumed), and the dispose guard did not cover
the `await countPending()` it preceded (a dispose landing in that window left
the entry's `delivered` promise unsettled forever, leaking every holder). Both
now have named regression tests.

Tests: `web/src/sync/opQueue.replica.test.ts` grew from 27 to 47 tests —
offline retention and reconnect delivery, ordering behind older durable batches
and ahead of newer ones, the three-way retained/durable/retained interleave,
same-`batch_id` 5xx backoff retry, transport-failure retention, the 4xx
discard-plus-barrier, the stale-`pendingCount` clamp, a poisoned batch no longer
standing ahead of a retained op, a rebase-flushed queue leaving no phantom, the
mid-drain disconnect barrier between entries, all three dispose races, and
pending-count reporting. The three pre-existing degradation tests were renamed (they said
"degrades to a direct post") and kept green unchanged in substance. Full web
unit suite: 1726 tests, 115 files, all passing; `pnpm typecheck` clean.
