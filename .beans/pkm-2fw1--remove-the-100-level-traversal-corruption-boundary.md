---
# pkm-2fw1
title: Remove the 100-level traversal corruption boundary in ops_apply
status: completed
type: bug
priority: high
created_at: 2026-07-31T15:54:33Z
updated_at: 2026-07-31T15:54:33Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 1.

**References:** server/src/pkm/server/ops_apply.py:20-58,70-80

Both ancestry cycle detection and subtree enumeration silently stop at depth 100. A legal deeper hierarchy can be moved under one of its descendants because the root is no longer seen, creating a cycle. A cross-page move updates only the first 101 levels, leaving deeper descendants on the source page with parents on the destination page.

**Direction:** Traverse the complete hierarchy with cycle-safe recursive SQL, or enforce a documented depth limit before mutation. Cross-page moves must update every descendant or fail atomically.

- [x] Add depth-boundary tests at 100, 101, and deeper
- [x] Verify cycle prevention and every descendant's page after a cross-page move
- [x] Replace the silent traversal cap with complete traversal or explicit validation

## Summary of Changes

`_parent_chain` and `_subtree_deepest_first` in `server/src/pkm/server/ops_apply.py`
no longer cap traversal at a fixed depth (`_DEPTH_CAP = 100` removed). Both recursive
CTEs now guard against cycles with a visited-path check (`instr(path, ','||uid||',')
= 0`) instead of a depth counter: a proper tree can never revisit a uid, so the guard
never fires on legitimate data and traversal runs to whatever depth the hierarchy
actually has; it only terminates early if the DB already contains a cycle (pre-existing
corruption), which the existing `op.uid in ctx.parent_chain` -> `OpError(index, "move
would create a cycle")` mechanism in `ops_core.plan_op` already handles -- no new
rejection class was introduced, per the controller's direction.

Empirically verified the old cap's exact failure boundary before writing tests: a
straight-line chain's ancestor walk was captured correctly up to 101 nodes (depths
0..100 inclusive) and silently truncated at 102+, dropping the true root from the
chain. Tests target depths 100, 101 (baseline: old code already correct, guards
against regressing these) and 102, 150 (old code fails: cycle undetected / descendants
stranded on the wrong page).

Delete's subtree enumeration was already effectively protected against the same cap
by the schema's `parent_uid ... REFERENCES blocks(uid) ON DELETE CASCADE`: explicit
deletion of only the first 101 nodes still cascade-deletes every deeper descendant at
the DB level, so `test_delete_removes_entire_deep_subtree` passes even before the fix
at every depth tested (100/101/102/150) -- it's included as a regression guard, not
as RED-phase evidence, since only the cycle-detection and cross-page `SetPageId` paths
(an UPDATE, not backed by cascade) actually corrupted data.

### Files changed
- `server/src/pkm/server/ops_apply.py` -- removed `_DEPTH_CAP`; rewrote `_parent_chain`
  and `_subtree_deepest_first` to use path-guarded, uncapped recursive CTEs.
- `server/tests/test_ops_apply.py` -- added `_linear_chain` helper and three
  parametrized tests (`depth` in 100/101/102/150): cycle detection, cross-page move
  completeness, and deep-subtree delete completeness.

### TDD evidence

RED (before the fix, filtered to the new tests):
```
cd server && uv run pytest -q tests/test_ops_apply.py -k "cycle or descendant or deep_subtree" -v
...
FAILED tests/test_ops_apply.py::test_move_root_under_own_descendant_always_raises_cycle[102]
FAILED tests/test_ops_apply.py::test_move_root_under_own_descendant_always_raises_cycle[150]
FAILED tests/test_ops_apply.py::test_cross_page_move_updates_every_descendant[102]
FAILED tests/test_ops_apply.py::test_cross_page_move_updates_every_descendant[150]
4 failed, 9 passed, 7 deselected
```
(depths 100/101 passed even before the fix -- confirms the boundary sits at 102, not
100; matches the empirical check against the raw SQL run beforehand.)

GREEN (after the fix, same filter):
```
13 passed, 7 deselected
```

Full verification, from the worktree:
- `cd server && uv run pytest -q` -> `966 passed`, coverage 95.97% (gate: 95%)
- `cd server && uv run pyrefly check` -> `0 errors (3 suppressed, 3 warnings not shown)`
- `cd server && uv run ruff check` -> `All checks passed!`

### Self-review

- Checklist: all three boxes covered.
- FCIS: `ops_apply.py` already declared `# pattern: Imperative Shell`; only the SQL
  text inside existing shell functions changed, no pattern change needed.
- No new `OpError` class or rejection path added -- reused the existing cycle-error
  mechanism, per the controller's explicit direction.
- Scope: touched only the two traversal functions and their tests; did not touch
  `plan_op`, effect execution, or unrelated ops.
- Nothing outside task scope was changed.
