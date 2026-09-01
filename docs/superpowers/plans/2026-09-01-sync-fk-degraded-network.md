# Plan: degraded-network FK wedge in sync (pkm-qvlx)

Bean: `.beans/pkm-qvlx--degraded-network-changes-feed-window-can-violate-r.md`
(the bean's "Confirmed findings" section is the spec: it names the three
reproduced failure modes and the user-visible chain).

Repro tests already on this branch (currently red):
- `server/tests/test_sync_window_parents.py` — a limit-split changes window
  ships a block whose `parent_uid` no earlier-or-same window delivered.
- `web/src/replica/applyFkHazards.test.ts` — three ways the replica wedges at
  COMMIT with `FOREIGN KEY constraint failed` (`defer_foreign_keys=ON` defers
  FK checks past reapplyPending's savepoints).

## Global constraints

- Work ONLY in the worktree root
  `/Users/arthur/code/llm/pkm/.claude/worktrees/sync-fk-degraded-network`.
  Never touch `/Users/arthur/code/llm/pkm` itself. Run `git status -sb`
  before every commit and abort if the branch is not
  `worktree-sync-fk-degraded-network`.
- FCIS: every runtime file keeps/declares its `# pattern:` header; pure logic
  in Functional Core files, I/O in Imperative Shell files.
- TDD: the red repro tests drive the work. Flip them green; add the new tests
  the task names; never weaken an existing assertion.
- Commit messages: `fix(pkm-qvlx): <what>`, `Co-Authored-By: Claude ...`
  allowed, NEVER a `Claude-Session:` trailer or claude.ai URL.
- Server verification: `cd server && uv run pytest -q` (full, enforced
  coverage) plus `uv run pyrefly check` and `uv run ruff check`.
- Web verification: `cd web && pnpm test:unit` and `pnpm typecheck`.
- Do not update docs/architecture (the controller owns that).
- Do not dispatch subagents.

## Task 1: server — changes windows must be dependency-complete for blocks

`GET /api/sync/changes` hydrates blocks at current state
(`server/src/pkm/server/routes_sync.py`). It already ships "dependency
pages" for refs. Extend the same rule to the two other FKs a shipped block
carries:

1. **Parent blocks**: for every hydrated block whose `parent_uid` is not
   null, ship the parent block too unless it is already in the window —
   transitively (the parent's parent as well), cycle-safe. Added dependency
   blocks are full `SyncBlock` payloads: hydrate them through the existing
   `_block_payloads` machinery so their refs (and therefore THEIR dependency
   pages) ship as usual.
2. **Own pages**: every hydrated block's `page_id` must be in the shipped
   pages set (a block moved to a brand-new page has the same hazard).
   Today `dep_pages` only collects ref targets.

Mechanics: keep queries in `routes_sync.py` (Imperative Shell); any new pure
helper (e.g. closure/ordering logic) belongs in `sync_core.py` (Functional
Core) with unit tests. Chunk every id list via `chunk_ids`. The snapshot
endpoint is already complete — do not touch it. Tombstone semantics must not
change: a dependency block that no longer exists simply isn't a dependency
(its uid never enters the payload; it must NOT produce a tombstone, since its
own journal row will do that in its own window).

Tests:
- `tests/test_sync_window_parents.py` goes green as written.
- Add to it: a `limit=1` walk where a block is moved to a brand-new page
  (asserts every shipped block's `page_id` is in shipped pages, cumulative);
  and a grandparent case (create A, create B under A, move existing block
  under B → transitive closure ships both A and B with the block).
- Full server suite + pyrefly + ruff clean.

## Task 2: client — the replica must never wedge on an FK constraint

Two changes in `web/src/replica/apply.ts` (Imperative Shell), driven by
`applyFkHazards.test.ts`:

1. **FK-safe reapplyPending** (fixes the tombstoned-parent and
   poisoned-parent repros, and makes snapshot/repair/reset immune): a batch
   that introduces an FK violation must roll back to its savepoint like any
   other no-longer-applicable batch, instead of poisoning the outer COMMIT.
   `PRAGMA foreign_key_check` works regardless of enforcement pragmas and
   inside transactions: capture the violation set before the batch loop
   (normally empty; non-empty only against a dependency-incomplete feed),
   then after each batch's `applyLocalOps` re-run the check and roll the
   batch back if it added violations. Keep the existing catch-and-rollback
   for thrown errors.
2. **A dependency-incomplete window must not wedge the cursor** (defense
   against un-upgraded/older servers; Task 1 makes it rare): if the window
   transaction still fails its deferred FK check at COMMIT, `applyChanges`
   returns `{ status: "needs-bootstrap" }` instead of throwing. The existing
   pullLoop path then runs the rebase recovery (flush pending → fresh
   snapshot → FK-safe reapply) and comes back healthy with the cursor past
   the bad window. Detect the case narrowly: the transaction wrapper's
   COMMIT throwing an error whose message matches SQLite's
   `FOREIGN KEY constraint failed` / result code 787. `applySnapshot` keeps
   throwing (a snapshot ships the whole graph; if IT is dangling something
   is truly wrong).

Test updates in `applyFkHazards.test.ts`:
- Repro 1 (window ships a block whose parent never arrived): assert
  `applyChanges` returns `needs-bootstrap` and the database + cursor are
  unchanged (rolled back), rather than the current expectation that the
  window applies — update the test comments to say the window-split case is
  primarily fixed server-side (Task 1) and this is the client's fallback.
- Repros 2 and 3 stand as written (window applies, cursor advances; snapshot
  survives) — the offending batch is skipped, other batches still apply: add
  an assertion that a second, valid pending batch's effect survives in
  repro 3.
- Also assert pending rows are never deleted by any of this (retention
  invariant: the queue is the user's intent).
- `pnpm test:unit` and `pnpm typecheck` clean.

## Task 3 (controller): architecture docs + bean

`docs/architecture/sync-and-offline.md`: extend the changes-feed bullet
(dependency pages → dependency pages AND parent-block closure AND own-page
rule), note reapplyPending's FK-check rollback where the doc explains
reapply, and add a symptom row ("Local sync is stuck: FOREIGN KEY constraint
failed" → dependency-incomplete window / deferred-FK reapply, pkm-qvlx).
Update bean checklist, then finishing-a-development-branch.
