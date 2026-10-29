---
# pkm-tkgs
title: Credential rotation follow-up to pkm-y8hl
status: completed
type: task
priority: deferred
created_at: 2026-10-29T11:28:40Z
updated_at: 2026-10-29T13:55:32Z
---

Split from pkm-y8hl (2026-10-29). Operational follow-up; the steps are in Arthur's local handoff notes (2026-10-29-pkm-tkgs-rotation.md).

Arthur (2026-10-29): leave it for now. Prod change: do not run without his go-ahead.


## Progress (2026-10-29)

- [x] Rotation done (server restarted, old sessions refused)
- [x] Old copies cleaned up
- [x] Arthur: finished the local steps (2026-10-29); the rest clears on its own
- [x] Re-enable the paused backup job when pkm-y8hl is deployed (done 2026-10-29, after a dry run on a clone of the mirror)


## Summary of Changes

Credentials rotated and old copies cleaned up on 2026-10-29; the backup job resumed after pkm-y8hl was deployed and dry-run against a clone of the mirror. Operational detail stays in Arthur's local handoff note.
