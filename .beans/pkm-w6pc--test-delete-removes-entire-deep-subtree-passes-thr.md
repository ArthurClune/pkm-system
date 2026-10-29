---
# pkm-w6pc
title: test_delete_removes_entire_deep_subtree passes through ON DELETE CASCADE
status: in-progress
type: bug
priority: low
created_at: 2026-10-24T14:58:27Z
updated_at: 2026-10-29T11:30:42Z
parent: pkm-mfd0
---

server/tests/test_ops_apply.py test_delete_removes_entire_deep_subtree stays green with a truncated subtree CTE (e.g. the old depth < 100 cap reinstated in ops_apply's subtree walk), because blocks.parent_uid ON DELETE CASCADE removes whatever the walk missed. So the test does not prove the walk reaches full depth.

- [x] Make the test observe the walk itself (journalled tombstones in changes, or the DeleteBlocks effect's uid list) rather than the rows left -- the test records the DeleteBlocks effect's uid list through a wrapped ops_apply._execute and compares it with the whole chain, on both delete paths (hashed and unhashed)
- [x] Show it goes red against the truncation mutant -- both truncation mutants (depth < 100 in either recursive CTE) fail the 102 and 150 deep cases
