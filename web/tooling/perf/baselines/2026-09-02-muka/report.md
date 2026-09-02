# Scenario I — `content-visibility: auto` on `.journal-day` (pkm-muka): measured, rejected

**Date:** 2026-09-02 · **before:** `0cdc606` (portals only) · **after:** the same commit plus
`content-visibility: auto; contain-intrinsic-size: auto 700px` on `.journal-day`
(branch `worktree-followup-muka`)

Same machine, same seeded server (`E2E_PORT=8977`), headed Chromium (`HEADLESS=0 node perf.mjs I`),
three runs per arm on the standard seed and two per arm on a 4x-heavier journal. Scenario I is
`seed.mjs`'s 30 daily pages, then 40 x 600px wheel scrolls at ~4 Hz.

`contain-intrinsic-size: auto 700px` was a measured median day on the standard seed (10 blocks +
title + references section = 703px for 26 of the 31 loaded days).

## Result: the CSS was not shipped

| standard seed (4.4k nodes) | before x3 | after x3 |
|---|---|---|
| browser cpu % | 10.2 · 10.2 · 10.6 | 10.9 · 11.7 · 11.0 |
| main-thread task s | 0.257 · 0.242 · 0.252 | 0.277 · 0.300 · 0.282 |
| **layouts** | **8 · 7 · 8** | **44 · 45 · 44** |
| layout s | 0.0113 · 0.0111 · 0.0112 | 0.0307 · 0.0349 · 0.0319 |
| style recalcs | 8 · 7 · 8 | 44 · 45 · 44 |
| style recalc s | 0.0045 x3 | 0.0136 · 0.0151 · 0.0139 |

| heavy journal, 40 blocks/day (9.1k nodes) | before x2 | after x2 |
|---|---|---|
| browser cpu % | 9.9 · 9.9 | 10.7 · 10.6 |
| main-thread task s | 0.294 · 0.294 | 0.294 · 0.287 |
| **layouts** | **6 · 6** | **33 · 31** |
| layout s | 0.0114 · 0.0113 | 0.0302 · 0.0287 |
| style recalc s | 0.0056 · 0.0054 | 0.0172 · 0.0166 |

Every arm separates cleanly rather than overlapping: the layout **count** is the mechanism, and it is
4-6x higher with the property on. Each section crossing the relevance boundary forces its own layout
and style recalc as it is rendered and skipped again, and a journal day is plain text -- cheap enough
to lay out that the bookkeeping costs more than the skipped work saves. Off-screen paint, the other
thing `content-visibility` would save, Chromium already culls.

Quadrupling the content per day did not flip it. That is the useful part: the win would have to come
from days that are individually expensive to lay out (large tables, many images, mermaid), not from
more of the same cheap rows.

## What shipped anyway

The portals (`BlockMenu` and `Popover` -> `document.body`). They were the precondition for trying
this at all -- the measured displacement of a menu opened deep in a scrolled day was
`{dx: 283, dy: -471}` px -- and they stand on their own: `position: fixed` positioned from viewport
coordinates has no business resolving against whatever section happens to contain it.
`e2e/popover-placement.spec.ts` holds the line, and the invariant is in
`docs/architecture/styling.md`.

## Not measured

- **Scroll smoothness / dropped frames.** The harness has no frame-timing scenario; `cpu%` and
  `TaskDuration` are what it can see. A change that traded total CPU for more even frame pacing
  would look like this regression, so a future attempt should measure frames, not just totals.
- **Memory.** RSS is flat (1025-1026 MB before, 1025-1029 MB after) and the node count is unchanged,
  as expected: `content-visibility` skips rendering, it does not drop DOM.
