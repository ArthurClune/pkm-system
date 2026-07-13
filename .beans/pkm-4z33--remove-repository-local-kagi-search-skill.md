---
# pkm-4z33
title: Remove repository-local Kagi search skill
status: completed
type: task
priority: normal
created_at: 2026-07-13T18:43:33Z
updated_at: 2026-07-13T18:44:17Z
---

Remove the tracked Kagi search skill that contains a machine-specific absolute path.

- [x] Delete `.claude/skills/kagi-search/SKILL.md`
- [x] Verify no current tracked Kagi skill references remain
- [x] Verify repository diff and secret scan

## Summary of Changes

Removed the repository-local Kagi search skill and its machine-specific script path. Verified that no Kagi references remain outside this task record, the current absolute-path count dropped from six to five, and staged Gitleaks reported zero findings.
