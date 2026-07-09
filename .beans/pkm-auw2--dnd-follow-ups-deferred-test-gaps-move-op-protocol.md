---
# pkm-auw2
title: 'DnD follow-ups: deferred test gaps + move-op protocol hardening'
status: todo
type: task
created_at: 2026-07-09T22:09:47Z
updated_at: 2026-07-09T22:09:47Z
---

Follow-ups from the pkm-jg1p final review (branch worktree-dnd-blocks, fixes landed in 5601ed1). Bundled deferred items:

- [ ] server: endpoint test exercising rollback of an auto-created page when a later op in the batch fails (currently verified only by inspection of routes_ops.py db.rollback())
- [ ] web: unit tests for insertSubtree edge branches — unknown parentUid returns tree unchanged; insertion under a nested (non-null) parent
- [ ] web: component test for drag cancel paths (dragleave clears indicator; dragend without drop clears context drag) using the jsdom DragEvent polyfill
- [ ] protocol hardening: a parent-based cross-page move WITHOUT page_title (legal server-side, ops_core resolves target from parent) leaves remote clients' views stale — source outline can't remove (parent not in tree), target outline's needsRefetch keys on op.page_title. Either broadcast the resolved target page_title on move ops, or treat 'move whose parent is unknown but uid is present' as removal + refetch. No current producer sends this shape (DndContext always attaches page_title); latent for API/script clients.
