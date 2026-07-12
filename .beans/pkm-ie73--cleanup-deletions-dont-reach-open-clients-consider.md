---
# pkm-ie73
title: 'Cleanup deletions don''t reach open clients: consider ws broadcast/resync'
status: todo
type: task
created_at: 2026-07-12T18:17:04Z
updated_at: 2026-07-12T18:17:04Z
---

Follow-up from pkm-c3kz final review (2026-07-12): POST /api/journal/cleanup deletes empty daily pages but nothing notifies already-open clients. A stale view can hold a since-deleted blank block; editing it sends a non-create op -> OpError 'block not found' -> 400 -> desync refetch that discards the typed text. Narrow window (past-week daily, blank block, mount race or long-open view). Options: broadcast a resync/delete over the ws hub after cleanup deletes pages, or sequence the Journal's first GET after cleanup. Coordinate with the offline-editing epic pkm-y8p0, which is redesigning sync semantics.
