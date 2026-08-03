---
# pkm-7ol9
title: 'Title Integrity Task 7 round 1: missing read-path route coverage'
status: completed
type: task
priority: normal
created_at: 2026-08-02T20:15:53Z
updated_at: 2026-08-02T20:21:12Z
---

Fix round 1/5 for task 7 by adding focused real-route tests that pin the missing direct /api/unlinked control-whitespace round-trip and the missing inactive plain-space exact-read behavior for /api/export/page/{title}. Preserve active export behavior and inactive padded-title distinction.\n\n## Checklist\n- [x] Add direct /api/unlinked control-whitespace round-trip coverage\n- [x] Add inactive /api/export/page/{title} plain-space exact-read coverage\n- [x] Run the focused Task 7 suite plus pyrefly and ruff\n- [x] Update the ignored report with red/green evidence and final outputs

\n## Summary of Changes\n\n- Added focused real-route tests for /api/unlinked control-whitespace normalization and /api/export/page/{title} inactive padded exact reads.\n- Proved both tests were sensitive with temporary production mutations, then restored the correct choke points.\n- Verified the affected tests, the Task 7 focused suite, pyrefly, and ruff all pass.
