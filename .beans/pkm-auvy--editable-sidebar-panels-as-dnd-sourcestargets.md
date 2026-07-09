---
# pkm-auvy
title: Editable sidebar panels as DnD sources/targets
status: todo
type: feature
created_at: 2026-07-09T21:52:43Z
updated_at: 2026-07-09T21:52:43Z
blocked_by:
    - pkm-jg1p
---

Follow-up to pkm-g356: sidebar panels are now live editable outlines (EditableSidebarPanel + EditablePage), but block drag-and-drop (pkm-jg1p) explicitly deferred wiring drop targets/drag sources into panels. Once pkm-jg1p's DndContext and cross-page move-op support land, wire panels into it: EditableBlockTree instances rendered inside EditableSidebarPanel need the same drop-target/drag-source handlers as the main pane, including cross-page drag between a panel and the main pane / another panel. Also revisit the same-page-active-elsewhere read-only fallback (outline/activeOutlines.ts) once DnD exists — dragging into a read-only fallback panel should probably be disallowed or should prompt the user, not silently no-op.
