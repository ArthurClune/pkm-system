---
# pkm-kexh
title: Run the comment lint sweep inside pytest and pnpm verify so a hook-less clone still fails on a dirty tree
status: completed
type: task
priority: normal
created_at: 2026-10-16T18:35:56Z
updated_at: 2026-10-16T18:36:57Z
---

The pre-commit hook only runs where `core.hooksPath` was set, and merge commits skip it. Make the tree-wide sweep part of the commands everyone already runs.

- [x] `server/tests/test_commentlint_run.py`: a test that runs the sweep over the real tracked tree and fails with the report
- [x] `web/package.json`: a `lint:comments` script in the `verify` chain
- [x] AGENTS.md / backend.md: say the sweep runs inside pytest and pnpm verify

## Summary of Changes

`test_the_tracked_tree_is_clean` runs the sweep over the real checkout under pytest (0.7s; shown to fail naming a planted violation), and `pnpm lint:comments` runs it inside `pnpm verify`. AGENTS.md and backend.md say so.
