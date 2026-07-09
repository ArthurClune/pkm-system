---
# pkm-jg1p
title: Drag and drop of blocks on desktop
status: completed
type: feature
priority: normal
created_at: 2026-07-09T18:54:26Z
updated_at: 2026-07-09T21:55:34Z
---

Drag and drop reordering of blocks needs to work on desktop (presumably works or is planned on touch; desktop mouse-based DnD currently doesn't work).


## Design

Spec approved 2026-07-09: docs/superpowers/specs/2026-07-09-block-drag-and-drop-design.md — Roam-style depth targeting, native HTML5 DnD, cross-page move op extension (scroll days + sidebar↔main in scope). Related: [[pkm-g356]] editable sidebar panels.


## Summary of Changes
Shipped native HTML5 drag-and-drop for outline blocks on desktop: same-page reorder/indent via the existing optimistic move-op path, cross-page moves (journal-day-to-day, main-pane-to-sidebar-panel and back, drop-onto-nonexistent-day auto-create) via a new server-side cross-page MoveOp (subtree page_id reassignment, auto-create target page, 400 on mismatch) and a client-side DnD layer (pure boundary/depth/allowed-position logic in `web/src/outline/dnd.ts`, a shared `DndContext` coordinating drag state across outlines/panels, `useDropZone` for DOM measurement, and cross-tree subtree remove/insert helpers in `web/src/outline/tree.ts`). Whole-feature verification: server pytest 198 passed, web vitest 183 passed (31 files), web typecheck clean, Playwright e2e 2/2 passed. Real-data smoke against a SQLite-backup scratch copy of the live graph (4314 pages / 52695 blocks, unchanged pre/post) exercised all six brief checks in a real browser via agent-browser (synthetic DragEvents, since native HTML5 DnD can't be driven by mouse-move automation): heavy-page reorder with indicator verification, cross-day move with ((ref)) resolution following the block, sidebar shift-click + drag in/out, drop-onto-nonexistent-day page auto-create, live cross-page-move resync in a second browser window, and read-only bullet gating on server kill/restart. Two non-blocking gaps found and documented: sidebar panels don't gate drag-and-drop on connection status (main pane does), and panel-to-outline moves don't optimistically refresh the destination outline (matches the design's documented panel-refetch-only simplification). Full detail in .superpowers/sdd/task-9-report.md.
