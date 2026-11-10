---
# pkm-3kbm
title: Small server and deploy bugs from the 2026-11-09 review
status: completed
type: bug
priority: normal
created_at: 2026-11-09T21:39:23Z
updated_at: 2026-11-10T07:26:38Z
parent: pkm-4gda
---

Plan: docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md § W5. Child of the 2026-11-09 maintainability review epic.

## Summary

Five fixes: setup.py creates config.json 0600 via O_EXCL + rename; get_page_blocks asks bl_limit=1; smoke.sh encodes login body with json.dumps and sends via stdin; sqlite_backup removes its .tmp on failure; cli-and-mcp.md and docstring state the today exception.
