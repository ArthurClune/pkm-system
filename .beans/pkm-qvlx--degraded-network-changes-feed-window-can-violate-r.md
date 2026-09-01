---
# pkm-qvlx
title: 'Degraded network: changes-feed window can violate replica FK constraints and wedge sync'
status: in-progress
type: bug
created_at: 2026-09-01T09:24:25Z
updated_at: 2026-09-01T09:24:25Z
---

On a degraded network (train wifi) the client shows 'Local sync is stuck: SQLITE foreign key constraint' and Reset local data churns. Suspected root causes: (1) the changes feed hydrates blocks at current state and ships dependency pages but NOT dependency parent blocks, so a window-split (>1000 journal rows behind) can deliver a block whose parent_uid arrives only in a later window; with defer_foreign_keys=ON the window COMMIT fails, the cursor never advances, and every retry refetches the same window — permanently stuck. (2) reapplyPending's savepoint-rollback safety doesn't hold under deferred FKs: a dangling insert (e.g. child of a block created by a poisoned batch) succeeds inside the savepoint and only fails at outer COMMIT, poisoning every window/snapshot apply including reset. Repro tests first, then fix.

## Confirmed findings (repro tests in this branch, currently red)

Both suspected mechanisms are real; each alone produces the exact symptom.

1. **Server window hole** — `tests/test_sync_window_parents.py` (FAILS):
   the feed hydrates blocks at *current* state but ships only dependency
   *pages*, never dependency *parent blocks*. A client > `limit` journal rows
   behind (degraded-network catch-up: drain floods the journal, then pull
   windows) can receive a block whose `parent_uid` was created by a journal
   row beyond the window. Repro: edit b6 (row 1) … create Q + move b6 under Q
   (rows 2,3); `limit=1` window 1 ships b6 with `parent_uid=Q`, no Q.
2. **Client deferred-FK hazard** — `web/src/replica/applyFkHazards.test.ts`
   (3 FAIL): `defer_foreign_keys=ON` postpones FK checks past reapplyPending's
   savepoints to the outer COMMIT. A dangling `parent_uid` insert (window-split
   block; pending create under a block the feed tombstoned; pending child of a
   poisoned batch's block) "succeeds" in its savepoint, then the whole
   window/snapshot COMMIT throws `FOREIGN KEY constraint failed`.

User-visible chain: applyChanges throws → ReplicaError is stall-shaped →
3 consecutive failures → `stalled` → "Local sync is stuck: … FOREIGN KEY
constraint failed". Cursor never advances, so every retry refetches the same
window: wedged permanently. Reset local data / poison repair re-run
reapplyPending over the snapshot → same FK failure in cases 2b/2c → "reset
churns". (Reset can also churn in case 1 when the blocking pending-flush fails
on the flaky network.)

## Fix sketch (needs decision)

Both halves are needed; neither alone covers all three repros:
- Server: ship dependency **parent blocks** (ancestor closure of every block
  in the window), mirroring the existing dependency-page rule. Fixes case 1
  for already-deployed clients too.
- Client: restore reapplyPending's "skipped, not fatal" guarantee under
  deferred FKs — e.g. `PRAGMA foreign_key_check` before each batch savepoint
  RELEASE, rolling the batch back on violations; consider the same check as a
  last-resort repair before window COMMIT so no feed can wedge the cursor.

## Checklist

- [x] Reproduce server window hole (test_sync_window_parents.py)
- [x] Reproduce client FK wedge x3 (applyFkHazards.test.ts)
- [x] Decide fix approach with Arthur (both halves approved 2026-09-01)
- [x] Server fix: dependency parent blocks + own pages in changes windows (04fcece)
- [x] Client fix: reapplyPending FK-safe; FK COMMIT failure degrades to needs-bootstrap (a52f675)
- [x] Flip repro tests green; full suites green per task (server pytest 1610 + pyrefly + ruff; web unit 2367 + typecheck)
- [x] Architecture docs: sync-and-offline.md (dependency rule, reapply FK guard, rebootstrap trigger row, symptom row)
