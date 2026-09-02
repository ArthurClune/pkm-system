---
# pkm-ikk0
title: Throttle DnD dragover; cache row rects during a drag
status: completed
type: task
priority: low
created_at: 2026-09-01T21:28:06Z
updated_at: 2026-09-02T05:47:46Z
parent: pkm-fgjg
---

Tier 2 — only costs while dragging, but it is the most expensive interaction in the app while it happens.

## Finding (confirmed from code)
`web/src/dnd/useDropZone.ts:48-65` — `onDragOver` runs unthrottled at pointer-move frequency; `boundaryAt` (`:15-26`) and `indicatorTop` (`:30-40`) do `querySelector` + `getBoundingClientRect` per candidate row (O(rows) forced layout), then `setIndicator` re-renders the (unmemoised) tree.

**Correction (measured, not code-read):** two claims above are false. Forced
layouts stayed at ~0.08 per dragover before and after, because nothing between
dragovers dirtied layout — the cost was the `querySelector` + rect-read walk
itself, not O(rows) layout. And the tree was already memoised by pkm-qfee, so
each `setIndicator` commit was ~32 fibers, not the whole outline. Numbers in
`web/tooling/perf/baselines/2026-09-02-ikk0/report.md`.

## Ideas
rAF-coalesce dragover; cache row rects for the duration of a drag (rows don't move mid-drag); drive the indicator by direct DOM style rather than React state.

## Verify
Profile a drag across the 300-block perf page: handler ms/event and commits/sec. iPad DnD needs the physical-device check (see memory: simulator can't do post-lift drag moves).

## Checklist
- [x] Baseline drag profile
- [x] Coalesce + rect cache
- [x] Re-profile; iPad check — re-profiled; iPad check done 2026-09-02 in the
      iPad Air 11" simulator (iPadOS 26 WebKit, safaridriver). UIKit swallows
      post-lift moves, so the drag was driven the way perf scenario K does it:
      synthetic DragEvents in-page. Two sweeps (120 dragovers at 4 ms — rAF
      coalescing engaged; 60 at 20 ms — near frame rate): every dragover
      preventDefault'd synchronously, `.drop-indicator` tracked the pointer
      monotonically, both drops landed exactly where aimed in DOM and on the
      server, no JS errors, handler mean 0.08 ms / p95 1 ms. Not covered:
      UIKit's own dragover pacing on a physical iPad — the events it delivers
      are unchanged by this bean (device-verified under pkm-1hod), only the
      handler's work per event changed.

## Outcome

Scenario K (`web/tooling/perf/`, three sweeps) with numbers and reasoning in
`web/tooling/perf/baselines/2026-09-02-ikk0/report.md`. `boundaryAt` stopped
at the first row past the pointer, so the O(rows) walk only bit near the
bottom of a long page: 4.368 ms -> 0.113 ms mean per dragover there, and
0.172 ms -> 0.073 ms at the top. At a 250 Hz event rate React commits per
dragover fall 1.02 -> 0.42.

The per-event figure brackets the handler only, so it excludes the rAF
callback the handler now defers the work to. Whole-window `ScriptDuration`
is the honest total, and moves the same way: bottom-of-page 60 Hz 0.554 s ->
0.072 s, 250 Hz 0.406 s -> 0.042 s, top-of-page 0.068 s -> 0.065 s.

Row rects are cached per row against the row's uid, not its index. A remote
batch that creates one row and deletes another lands with the row count
unchanged, and every cached rect below the change then describes the wrong
block — an indicator and a drop one row out, with nothing raised.

The drag's peak handler time is now its first event, which walks to row ~300
with a cold cache (~6 ms once, replacing ~4 ms on every event).

The indicator stayed in React state: with `EditableBlock` memoised a commit
is ~32 fibers and ~0.4 ms, one per frame, so direct DOM writes would buy that
back at the cost of a second source of truth for where the line is.

Not done, observed: the commit at `dragstart` re-renders every row (1687
fibers), because `DndProvider`'s value is memoised on `drag` and that reaches
every row through a fresh `handlers` object. Once per drag, not per event —
same shape as pkm-qfee.
