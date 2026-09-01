---
# pkm-ufjt
title: Deferred follow-ups from the sync FK-wedge fix
status: todo
type: task
created_at: 2026-09-01T12:05:13Z
updated_at: 2026-09-01T12:05:13Z
---

Follow-on from pkm-qvlx (degraded-network FK wedge). Items triaged non-blocking by the reviews; pick up opportunistically or when a trigger fires.

Context lives in pkm-qvlx (root cause, fix shape, review trail). None of
these block anything; each names its trigger.

## Items

- [ ] Test the reapply baseline-tightening edge (`before = after` after a kept
      batch, `web/src/replica/apply.ts`): a faithful repro through the real ops
      path was judged blocked (refs self-heal via `getOrCreateLocalPage`;
      `block_refs` targets carry no FK; `create` doesn't validate `parent_uid`
      but `move` does) — but the re-review noted that argument covers
      ROLLBACK-freed rowids, not DELETE-freed reuse. Revisit whether a
      DELETE-path construction works; if it provably can't, note that in the
      code comment instead.
- [ ] `PRAGMA foreign_key_check` full scan per pending batch inside the window
      transaction. Trigger: replica applies get slow with many pending batches.
      Cheap shape: one check after the loop, per-batch re-run only when dirty.
- [ ] Closure-added parent blocks don't count against the feed `limit`/
      `MAX_LIMIT` clamp — payload formally unbounded. Trigger: next time
      `MAX_LIMIT` is tuned or payload size matters.
- [ ] `isFkFailure`'s COMMIT-only narrowing holds only while
      `PRAGMA defer_foreign_keys = ON` stays the transaction's first statement
      (comment-enforced at the catch site). Consider making it structural if
      that transaction ever grows pre-PRAGMA statements.
- [ ] `foreign_key_check` rowid=NULL identity collapse for WITHOUT ROWID
      children (refs/block_refs) — Set identity is lossy; commented in
      `fkViolations`. Fix (Map of counts) only if item 1's invariants weaken.
- [ ] Pre-existing: `needs-bootstrap` arriving during an active poison repair
      refetches until the repair completes (`replicaSync.ts` poison guard) —
      converges, never wedges. Only worth touching if a user-visible stall is
      reported.
- [ ] No HTTP-level test for a genuinely-deleted ancestor in the parent
      closure — state unreachable while the server runs `foreign_keys=ON` with
      `ON DELETE CASCADE`; add only if that ever changes.
