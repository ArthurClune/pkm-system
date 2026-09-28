---
# pkm-c2gs
title: No-replica tab keeps a ghost block on screen and lands a note per flush
status: todo
type: bug
created_at: 2026-09-28T22:40:50Z
updated_at: 2026-09-28T22:40:50Z
---

Found in the pkm-foap review (M2). A tab with no usable replica delivers through the in-memory fallback lane and has no changes feed, and it drops its own WS echoes (SyncProvider.tsx). If it shows a block the server no longer has (e.g. a stale Journal view after /api/journal/cleanup), every debounced flush of text into it now lands another child under that block's daily-note conflict header instead of the old 400 + discard + refetch. Text is kept, but the note fills up and the ghost never leaves the screen.

Option: when an ack's `skipped` list (added in pkm-foap) is non-empty, or a skipped op targets a block on a visible view, refetch that view.
