---
# pkm-zyd3
title: 'Block menu views: numbered list and document'
status: completed
type: feature
priority: normal
created_at: 2026-07-13T18:57:34Z
updated_at: 2026-07-14T15:05:01Z
---

Add persistent subtree display modes to the block right-click menu. A numbered-list view numbers the selected block's descendants; document view restores the normal document/bullet presentation.

## Acceptance Criteria

- [x] The block right-click menu offers `View as numbered list` and `View as document`.
- [x] Choosing numbered-list view makes every descendant in the selected block's subtree display ordered-list markers at its nesting level, rather than standard bullets or indentation alone.
- [x] Choosing document view restores the same subtree to the normal document/bullet rendering.
- [x] Switching views does not alter block text, parent/child relationships, ordering, or collapse state.
- [x] The selected view is persisted, survives reload, and synchronizes to other clients through the normal operation path.
- [x] Imported view metadata, if present, maps to the same rendering behavior.
- [x] The active view is indicated in the context menu.
- [x] Tests cover nested numbering, reverting to document view, persistence, optimistic updates, and remote updates.

## Summary of Changes

Added constrained nullable `view_type` metadata with a guarded server migration, Roam import and export integration, create-time support, and `set_view_type` handling across server operations, snapshots, feeds, generated contracts, offline replica storage, optimistic updates, and remote application. Both tree renderers now apply recursive per-level numbering with explicit document boundaries, and the accessible block menu exposes checked numbered/document choices. Tests cover migration, import values, persistence, nested rendering, document reversion, optimistic updates, remote updates, and keyboard menu access.
