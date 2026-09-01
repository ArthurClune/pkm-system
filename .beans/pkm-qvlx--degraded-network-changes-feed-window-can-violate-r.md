---
# pkm-qvlx
title: 'Degraded network: changes-feed window can violate replica FK constraints and wedge sync'
status: completed
type: bug
priority: normal
created_at: 2026-09-01T09:24:25Z
updated_at: 2026-09-01T11:53:59Z
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

## Summary of Changes

Four commits on `worktree-sync-fk-degraded-network` (final review: ready to merge):

- `04fcece` server: `GET /api/sync/changes` windows are dependency-complete
  for blocks — transitive `parent_uid` closure (`_with_parent_closure`,
  cycle-safe, chunked) and each hydrated block's own `page_id` join the
  existing ref-target dependency pages. Snapshot path provably unaffected.
- `a52f675` client: `reapplyPending` skips (savepoint-rolls-back) any pending
  batch that adds an FK violation, via baseline-diffed
  `PRAGMA foreign_key_check` — enforcement-pragma-independent, so the
  `foreign_keys=OFF` reset rebuild is covered; `applyChanges` degrades a
  deferred-FK COMMIT failure to `needs-bootstrap` (rebase recovery advances
  the cursor past the bad window) instead of wedging. Repro tests
  (`applyFkHazards.test.ts`) green.
- `dd8b1a8` docs: sync-and-offline.md dependency rule, reapply FK guard,
  fourth rebootstrap trigger, symptom row.
- `6392407` polish: baseline tightening after kept batches, WITHOUT-ROWID
  lossiness + ordering comments, `console.warn` on the FK fallback,
  closure docstring, doc rewrap.

Deploy ordering is safe both directions; the client fallback also self-heals
replicas already corrupted by the old code. Both full suites green
(server 1610 + pyrefly + ruff; web unit 2367 + typecheck + 54 e2e).

## Deferred / skipped (review triage — all judged non-blocking)

From the task reviews and the final whole-branch review; kept here because
the SDD ledger is gitignored and dies with the worktree.

1. No test for the reapply baseline-tightening edge (`before = after` after a
   kept batch, `apply.ts`): a faithful repro through the real ops path is
   blocked (refs self-heal via `getOrCreateLocalPage`; `block_refs` targets
   carry no FK; `create` doesn't validate `parent_uid` but `move` does).
   Caveat from re-review: that argument covers ROLLBACK-freed rowids, not
   DELETE-freed reuse — documentation risk, not code risk (the feed path's
   COMMIT still catches the state).
2. `PRAGMA foreign_key_check` is a full scan per pending batch inside the
   window transaction. Left: the no-pending early return keeps the common
   case free. If it ever bites: one check after the loop, per-batch re-run
   only when dirty.
3. Closure-added parent blocks don't count against the feed `limit`/
   `MAX_LIMIT` clamp — payload formally unbounded, practically shallow.
   Revisit if `MAX_LIMIT` is tuned.
4. `isFkFailure`'s COMMIT-only narrowing holds because
   `PRAGMA defer_foreign_keys = ON` is the transaction's first statement —
   enforced by comment at the catch site, not by construction.
5. `foreign_key_check` reports rowid=NULL for WITHOUT ROWID children
   (refs/block_refs), so distinct violations can collapse to one Set key —
   commented in `fkViolations`; unreachable given (1)'s invariants.
6. `test_sync_window_parents.py` duplicates seed literals (`seen_pages`) —
   repo convention; nothing imports conftest constants.
7. Pre-existing: `needs-bootstrap` arriving during an active poison repair
   refetches until the repair completes — converges, never wedges
   (`replicaSync.ts` poison guard).
8. No HTTP-level test for a genuinely-deleted ancestor in the closure —
   state unreachable while the server runs `foreign_keys=ON` with
   `ON DELETE CASCADE`; the defensive code stands.
