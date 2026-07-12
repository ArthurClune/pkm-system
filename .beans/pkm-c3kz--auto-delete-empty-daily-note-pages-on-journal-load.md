---
# pkm-c3kz
title: Auto-delete empty daily note pages on Journal load
status: in-progress
type: feature
created_at: 2026-07-12T17:37:03Z
updated_at: 2026-07-12T17:37:03Z
---

On Journal (daily notes) mount, web fires POST /api/journal/cleanup. Server checks the 7 daily pages before today (today excluded) and deletes any that are completely empty (zero blocks, or all blocks whitespace-only and none ((referenced)) from another page). Stateless check every load. No UI change.
