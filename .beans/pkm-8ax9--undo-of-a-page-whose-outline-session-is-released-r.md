---
# pkm-8ax9
title: Undo of a page whose outline session is released replays recorded keys
status: todo
type: bug
created_at: 2026-10-05T10:42:31Z
updated_at: 2026-10-05T10:42:31Z
---

undoManager.dispatch re-keys history placements (anchors) against the page's mounted session tree. When the page's session has been released (Cmd-Z after navigating away), the recorded order_idx values ship unchanged, which is right only if nothing shifted that page's keys since recording. Candidate fixes: resolve against the replica's tree for that page, or defer the dispatch until the session mounts. Found in review of the undo-anchor fix on feat/pkm-f7zv-outline-props.
