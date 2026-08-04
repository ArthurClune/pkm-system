---
# pkm-q2jj
title: Replica availability has five representations and no owner
status: todo
type: epic
priority: normal
created_at: 2026-08-04T12:53:17Z
updated_at: 2026-08-04T12:54:50Z
---

"Is the replica usable?" is currently encoded in five places, kept in sync by convention:

1. `init().ok` — the reported value
2. the worker's memoised `dbPromise` resolved/rejected state — the actual truth
3. `replicaSync`'s `disabled` boolean — "permanent for this session"
4. `replicaState.mode === "no-replica"` — what the UI sees
5. `opQueue`'s storage-error whitelist (`isSahPoolContention` / `isPoolExhausted`) — which decides whether the user's writes SURVIVE, by matching error message strings

All four open follow-ups from pkm-bjae are the same bug wearing different clothes -- a consumer re-deriving this fact locally and getting it slightly wrong:

- **pkm-9x6u** — the message whitelist, not the availability state, decides whether writes survive
- **pkm-4ubd** — conflict protection is lost because `base_text_hash` is stamped inside the DB path
- **pkm-tu5k** — the poison intent can only clear via a successful DB write, so an unopenable profile wedges every future session
- the `probe === "unknown"` branch — the gate is retained but no availability state is ever set

pkm-bjae itself was caused by the same gap: `init()`'s failure path cleared the memoised open, so a viability probe re-armed access to a database it had just declared dead, and the barrier lift then drained an unexamined durable queue. Two independent reviewers read that mechanism IDENTICALLY and drew opposite conclusions about whether it was a virtue or a defect -- because nothing in the code recorded which purpose it served, and the cause and effect were three modules apart.

Design: `docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md`.

Approach approved 2026-08-04: the worker owns the fact, a typed error carries it across the RPC boundary (following the existing `quota` flag precedent documented at `rpc.ts:4`), and every other representation is DERIVED or deleted -- including SyncProvider's `init()` probe, `markUnavailable()`, `replicaSync`'s `disabled` boolean, and the message-matching whitelist.

Full refactor in one branch, landed as reviewable commits. Child beans below.


## Children

Sequenced (see the design's Ordering section):
1. **pkm-y35i** — typed error + wire flag (no consumers)
2. **pkm-imw4** — characterise current behaviour FIRST; this is the regression net
3. **pkm-za9j** — the explicit worker latch, replacing pkm-bjae's implicit one
4. **pkm-s7af** — opQueue retains by type; deletes the message whitelist (closes pkm-9x6u)
5. **pkm-61zt** — derive in SyncProvider/replicaSync; delete the probe, `disabled`, `markUnavailable()`, the `"unknown"` branch
6. **pkm-4ubd** — main-thread `base_text_hash` stamping

**pkm-tu5k is adopted as a child but deliberately NOT sequenced into this branch.** Making the fact explicit is what lets the queue know marking is impossible; it does not decide what to do about a rejection that can never be repaired. That policy call stays open (read-only is already ruled out).
