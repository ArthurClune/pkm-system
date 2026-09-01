---
# pkm-ikk0
title: Throttle DnD dragover; cache row rects during a drag
status: todo
type: task
priority: low
created_at: 2026-09-01T21:28:06Z
updated_at: 2026-09-01T21:28:06Z
parent: pkm-fgjg
---

Tier 2 — only costs while dragging, but it is the most expensive interaction in the app while it happens.

## Finding (confirmed from code)
`web/src/dnd/useDropZone.ts:48-65` — `onDragOver` runs unthrottled at pointer-move frequency; `boundaryAt` (`:15-26`) and `indicatorTop` (`:30-40`) do `querySelector` + `getBoundingClientRect` per candidate row (O(rows) forced layout), then `setIndicator` re-renders the (unmemoised) tree.

## Ideas
rAF-coalesce dragover; cache row rects for the duration of a drag (rows don't move mid-drag); drive the indicator by direct DOM style rather than React state.

## Verify
Profile a drag across the 300-block perf page: handler ms/event and commits/sec. iPad DnD needs the physical-device check (see memory: simulator can't do post-lift drag moves).

## Checklist
- [ ] Baseline drag profile
- [ ] Coalesce + rect cache
- [ ] Re-profile; iPad check
