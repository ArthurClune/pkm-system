---
# pkm-nny4
title: Cmd-Z for query table cell writes
status: scrapped
type: task
priority: normal
created_at: 2026-11-15T19:35:21Z
updated_at: 2026-11-16T10:50:52Z
parent: pkm-l79g
---

A query table's cell write is undone only by its notice's Undo; Cmd-Z does not reach it.

recordHistory could take a hand-built HistoryEntry without a page tree: an update_text needs no anchors, and a create's forward anchor can be null (redo replays at the recorded key, which still lands in front of the shifted sibling). Two things stop it:

- undoManager.settle navigates to the record's page when no outline for it is mounted, so Cmd-Z after editing a Book row would leave the query page, and the table's patched record would not learn of the undo.
- The notice's Undo sends the inverse outside history, and history has no way to drop an entry, so Undo then Cmd-Z would replay the same inverse twice.

A fix needs a history entry that can be undone in place (no navigation) with a hook back to the table to patch its record, and a way for the notice's Undo to take its entry off the stack (performUndo of that entry, or removal).



Checked 2026-11-16: the gap is worse than a missing shortcut. After a query cell commits, focus leaves the textarea, so UndoRedoKeys' window handler runs performUndo on the outline history: Cmd-Z undoes the reader's previous outline edit, which may be on another page and navigate there, rather than doing nothing.


## Reasons for Scrapping

Arthur, 2026-11-16: leave it. Cmd-Z after a query-cell write leaves the table's value alone and undoes the reader's last outline edit in this tab, navigating to its page if needed; Cmd-Shift-Z redoes it, so nothing is lost and the jump makes it visible. A query write is undone through its notice's Undo. Not worth a history redesign or a Cmd-Z guard.
