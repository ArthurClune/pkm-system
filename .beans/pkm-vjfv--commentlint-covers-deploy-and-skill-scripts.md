---
# pkm-vjfv
title: commentlint covers deploy and skill scripts
status: completed
type: task
created_at: 2026-10-19T15:04:32Z
updated_at: 2026-10-19T15:04:32Z
---

commentlint skips code outside its CODE_ROOTS: deploy/ (shell and Python), the .claude/skills scripts (agent-browser templates, architecture-docs/check-docs.mjs, ipad-simulator/scripts/simpad.py), and possibly extensionless scripts such as .githooks/. Arthur (2026-10-19): it should cover them, for consistency.

- [x] Cover deploy/ and .claude/skills code files, plus any other tracked code outside the roots (extensionless scripts by shebang)
- [x] Fix what the widened sweep flags
- [x] Pin the roots in test_commentlint_core.py; update docs

## Summary of Changes

commentlint now scans every tracked code file (rule: a code extension anywhere, plus `.swift`, minus generated files, perf baselines, `web/public`, `web/dist`, `node_modules`, `.venv`) instead of a root list. Extensionless files are read by shebang (`language()`); without one they are skipped. Fixed the comment widths, bean ids and plan pointer the sweep flagged in deploy/ and the skill scripts (comments only). Pinned in test_commentlint_core.py; docs in backend.md and enforced-checks.md updated.
