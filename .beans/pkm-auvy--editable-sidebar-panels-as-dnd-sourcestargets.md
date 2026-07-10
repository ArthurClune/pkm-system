---
# pkm-auvy
title: Editable sidebar panels as DnD sources/targets
status: todo
type: feature
priority: normal
created_at: 2026-07-09T21:52:43Z
updated_at: 2026-07-10T06:12:15Z
blocked_by:
    - pkm-jg1p
---

Follow-up to pkm-g356: sidebar panels are now live editable outlines (EditableSidebarPanel + EditablePage), but block drag-and-drop (pkm-jg1p) explicitly deferred wiring drop targets/drag sources into panels. Once pkm-jg1p's DndContext and cross-page move-op support land, wire panels into it: EditableBlockTree instances rendered inside EditableSidebarPanel need the same drop-target/drag-source handlers as the main pane, including cross-page drag between a panel and the main pane / another panel. Also revisit the same-page-active-elsewhere read-only fallback (outline/activeOutlines.ts) once DnD exists — dragging into a read-only fallback panel should probably be disallowed or should prompt the user, not silently no-op.


## Notes from the pkm-jg1p merge (3da86a6)

The base integration landed by composition: EditableSidebarPanel renders EditablePage, which carries the full DnD wiring, so panels are now optimistic two-sided drag sources/targets. Remaining items for this bean, from the merge-resolution review:

- [ ] Fallback instances (same title already active elsewhere) are now fully excluded from DnD — no drag OUT either (pre-merge read-only panels could drag out). Decide the intended UX (disallow silently vs prompt), incl. the drag-out case.
- [ ] activeOutlines guard: registration happens in an effect but isOutlineActive is read during render — two same-title mounts in one commit would both claim the title AND both register in the last-wins DnD registry. Real flows are sequential (panel mounts after async fetch); document or harden when revisiting.
- [ ] `DndContext.registerPanel` + `BlockTree.dndPage` are production-dead after the merge (tested, but no production caller). Decide here: revive for fallback-panel DnD or delete.
- [ ] Cosmetic: .drop-indicator uses hard-coded #4a9eda; swap to the theme accent variable (pkm-pthk moved styling to CSS custom properties).
