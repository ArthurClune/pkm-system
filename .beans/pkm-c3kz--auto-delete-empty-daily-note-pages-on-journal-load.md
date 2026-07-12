---
# pkm-c3kz
title: Auto-delete empty daily note pages on Journal load
status: completed
type: feature
priority: normal
created_at: 2026-07-12T17:37:03Z
updated_at: 2026-07-12T18:19:50Z
---

On Journal (daily notes) mount, web fires POST /api/journal/cleanup. Server checks the 7 daily pages before today (today excluded) and deletes any that are completely empty (zero blocks, or all blocks whitespace-only and none ((referenced)) from another page). Stateless check every load. No UI change.

## Summary of Changes

- POST /api/journal/cleanup deletes completely-empty daily pages from the 7 days before today (today spared; blank-but-((referenced)) blocks spare their page). One transaction per call; stateless re-check every load.
- Deletion path shared with DELETE /api/page via new store.delete_page_rows.
- Journal fires the cleanup fire-and-forget on mount; openapi.json/types.d.ts regenerated.
- Spec: docs/superpowers/specs/2026-07-12-empty-daily-cleanup-design.md; plan: docs/superpowers/plans/2026-07-12-empty-daily-cleanup.md
- Residual risk (accepted): open clients aren't notified of deletions; editing a since-deleted blank block desyncs and drops the typed text. Follow-up: pkm-ie73.
