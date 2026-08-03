---
# pkm-v5x5
title: 'opQueue: a kick during a blocked drain is dropped (reconnect latency)'
status: completed
type: bug
priority: low
created_at: 2026-07-31T20:18:43Z
updated_at: 2026-08-03T15:46:17Z
---

Pre-existing behavior surfaced during pkm-49eh (affects durable rows and the new fallback lane identically).

missedKick is only recorded for a "drained" outcome, so a kick that arrives while a drain is in flight and about to return blocked (e.g. setOnline(true) racing a drain that is concluding offline) schedules no redrain; delivery waits for the next kick (next mutation, reconnect event, etc.). Observed as the reason several pkm-49eh tests must settle the offline drain before reconnecting.

- [x] Decide the intended semantics (record missedKick for blocked outcomes, or re-kick on connectivity transitions)
- [x] Add a reconnect-during-blocked-drain test

## Summary of Changes

Chose "record missedKick for blocked outcomes", gated on the block having
actually lifted. In `createReplicaQueue`'s drain completion handler
(`web/src/sync/opQueue.ts`):

```
const missedKick = drainAgain && (outcome.status === "drained"
  || (terminalReason(qstate) === null && !qstate.retryScheduled));
```

Rationale for this over re-kicking on connectivity transitions: `setOnline`
already emits a `kick` effect, and `kick()` already records the missed kick as
`drainAgain` — the only thing broken was the completion handler discarding it.
Re-kicking from the transition instead would need new state to know a drain was
in flight, i.e. a second copy of `drainAgain`. This also fixes the symmetric
`resume()`-during-a-recovering-drain case for free.

The two guards keep the original comment's concerns intact: a still-terminally-
blocked queue (offline/recovering/disposed) does not redrain and cannot spin,
and a `retryable` outcome keeps its armed backoff timer rather than being
pre-empted by an immediate retry.

Test: "a reconnect landing on a blocked drain redrains without a further kick"
in `web/src/sync/opQueue.replica.test.ts` parks the offline drain inside
`countPending()`, calls `setOnline(true)`, and asserts the batch is posted with
no further `drain()` call (exactly two drains: blocked, then drained).
