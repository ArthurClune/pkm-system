---
# pkm-ufjt
title: Deferred follow-ups from the sync FK-wedge fix
status: completed
type: task
created_at: 2026-09-01T12:05:13Z
updated_at: 2026-09-26T18:30:00Z
---

Follow-on from pkm-qvlx (degraded-network FK wedge). Items triaged non-blocking by the reviews; pick up opportunistically or when a trigger fires.

Context lives in pkm-qvlx (root cause, fix shape, review trail). None of
these block anything; each names its trigger.

## Items

- [x] Test the reapply baseline-tightening edge (`before = after` after a kept
      batch, `web/src/replica/apply.ts`): a faithful repro through the real ops
      path was judged blocked (refs self-heal via `getOrCreateLocalPage`;
      `block_refs` targets carry no FK; `create` doesn't validate `parent_uid`
      but `move` does) — but the re-review noted that argument covers
      ROLLBACK-freed rowids, not DELETE-freed reuse. Revisit whether a
      DELETE-path construction works; if it provably can't, note that in the
      code comment instead.
- [x] `PRAGMA foreign_key_check` full scan per pending batch inside the window
      transaction. Trigger: replica applies get slow with many pending batches.
      Cheap shape: one check after the loop, per-batch re-run only when dirty.
      **Closed 2026-09-26:** trigger not fired (see Triage).
- [x] Closure-added parent blocks don't count against the feed `limit`/
      `MAX_LIMIT` clamp — payload formally unbounded. Trigger: next time
      `MAX_LIMIT` is tuned or payload size matters.
      **Closed 2026-09-26:** trigger not fired (see Triage).
- [x] `isFkFailure`'s COMMIT-only narrowing holds only while
      `PRAGMA defer_foreign_keys = ON` stays the transaction's first statement
      (comment-enforced at the catch site). Consider making it structural if
      that transaction ever grows pre-PRAGMA statements.
      **Closed 2026-09-26:** still the first statement (see Triage).
- [x] `foreign_key_check` rowid=NULL identity collapse for WITHOUT ROWID
      children (refs/block_refs) — Set identity is lossy; commented in
      `fkViolations`. Fix (Map of counts) only if item 1's invariants weaken.
      **Closed 2026-09-26:** invariants hold (see Triage).
- [x] Pre-existing: `needs-bootstrap` arriving during an active poison repair
      refetches until the repair completes (`replicaSync.ts` poison guard) —
      converges, never wedges. Only worth touching if a user-visible stall is
      reported.
      **Closed 2026-09-26:** no stall reported (see Triage).
- [x] No HTTP-level test for a genuinely-deleted ancestor in the parent
      closure — state unreachable while the server runs `foreign_keys=ON` with
      `ON DELETE CASCADE`; add only if that ever changes.
      **Closed 2026-09-26:** still unreachable (see Triage).

## Triage (2026-09-26)

Every item was checked against the current code. Item 1 still applied; the other six are closed because their triggers have not fired or the state they describe cannot be reached.

| # | Verdict | Grounds |
|---|---|---|
| 1 | Fixed (test + comment) | DELETE-freed rowid reuse *can* be built through the real ops path. `blocks` is a rowid table without AUTOINCREMENT, so a later batch's dangling insert can reuse the rowid an earlier batch's delete freed, giving an identical `foreign_key_check` key. The baseline tightening after a kept batch is what catches it. |
| 2 | Closed | No reported slowness. No perf scenario applies with many pending batches (F/typing has at most one in flight). The per-check cost is already recorded in the `fkViolations` comment (pkm-ey1f). |
| 3 | Closed | `MAX_LIMIT` (routes_sync.py) has not changed since before pkm-qvlx. The closure adds only ancestors that are not already in the window. |
| 4 | Closed | `PRAGMA defer_foreign_keys = ON` is still the first statement in `applyWindow`, and the comment that enforces it is in place. |
| 5 | Closed | Item 1's invariants hold: server FKs are on and the dependency rule ships ref-target pages. |
| 6 | Closed | Code unchanged since a52f675. It converges and no stall has been reported. |
| 7 | Closed | Unreachable while the server runs `foreign_keys=ON` with `ON DELETE CASCADE`. |

## Summary of Changes

- Item 1: regression test in `web/src/replica/applyFkHazards.test.ts` (DELETE-freed rowid reused by a later batch's dangling insert; red with the tightening removed → needs-bootstrap) and a comment at the tightening site in `apply.ts`.
- Items 2–7 closed per the Triage table.
