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
- [x] Baseline drag profile
- [x] Coalesce + rect cache
- [ ] Re-profile; iPad check — re-profiled (iPad check pending — for Arthur,
      physical device; the simulator cannot drive post-lift drag moves)

## Outcome

Scenario K (`web/tooling/perf/`, three sweeps) with numbers and reasoning in
`web/tooling/perf/baselines/2026-09-02-ikk0/report.md`. `boundaryAt` stopped
at the first row past the pointer, so the O(rows) walk only bit near the
bottom of a long page: 4.368 ms -> 0.113 ms mean per dragover there, and
0.172 ms -> 0.073 ms at the top. At a 250 Hz event rate React commits per
dragover fall 1.02 -> 0.42.

The drag's peak handler time is now its first event, which walks to row ~300
with a cold cache (~6 ms once, replacing ~4 ms on every event).

The indicator stayed in React state: with `EditableBlock` memoised a commit
is ~32 fibers and ~0.4 ms, one per frame, so direct DOM writes would buy that
back at the cost of a second source of truth for where the line is.

Not done, observed: the commit at `dragstart` re-renders every row (1687
fibers), because `DndProvider`'s value is memoised on `drag` and that reaches
every row through a fresh `handlers` object. Once per drag, not per event —
same shape as pkm-qfee.
