---
# pkm-go73
title: 'Undo history: redo pressed while an undo awaits a slow page read duplicates the entry if the undo is refused'
status: todo
type: bug
priority: deferred
created_at: 2026-10-25T12:48:05Z
updated_at: 2026-10-27T10:29:48Z
---

From the pkm-pgod review (2026-10-25). Pre-existing. If an undo waits on a slow page read and the user presses redo, the redo takes the same entry; if the undo is then refused, the entry ends up twice on the undo stack and the queued redo replays it a second time (mirror: redo pending then undo duplicates on the redo stack). No silent data loss found; history and replays stop matching the page.

- [ ] Red unit test for both orders
- [ ] Serialise or lock the entry while its replay is pending
- [ ] A property that reaches restoreEntry/performUndo interleavings (web/src/props has none today)


## Deferred (2026-10-27)

Arthur's ruling: pre-existing, needs a slow page read plus a redo mid-undo plus a refused undo, and loses no data. Revisit if it is ever seen. Removed from the security epic.
