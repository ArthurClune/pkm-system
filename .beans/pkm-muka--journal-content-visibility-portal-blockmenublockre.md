---
# pkm-muka
title: 'Journal content-visibility: portal BlockMenu/BlockRefBacklinksPopover to body first'
status: todo
type: task
priority: low
created_at: 2026-09-02T03:26:28Z
updated_at: 2026-09-02T03:26:28Z
parent: pkm-fgjg
---

Split out of pkm-ey1f item 3 (2026-09-02).

## Why not done in pkm-ey1f
`content-visibility: auto` turns on layout/paint/style containment at all times, not only while a section is skipped, and layout containment makes the element the containing block for `position: fixed` descendants. `.journal-day` contains two: `BlockMenu` and `BlockRefBacklinksPopover`, rendered inline as siblings of the rows inside `EditableBlockTree`'s root div (no rows-only wrapper exists) and positioned from viewport `getBoundingClientRect` coordinates. Measured in headless Chromium: a fixed child asking for `top: 100px` lands at y=100 in a plain section and at y=1756 inside a `content-visibility: auto` section whose top is at y=1656 — every block menu and ref popover on the Journal would be displaced by its day's scroll offset.

## Plan
1. Portal `BlockMenu` and `BlockRefBacklinksPopover` to `document.body`. Mind the React-portal-bubbling gotcha `PdfViewer` already documents (synthetic events still propagate through the React tree into `.block-text`'s onClick) — treat the portals as interactive islands. Add e2e cover for menu/popover placement on Journal and PageView.
2. Then apply `content-visibility: auto` + `contain-intrinsic-size: auto <estimate>px` to `.journal-day` only (never to outline rows). Verify: focused day still renders; find-in-page / anchor navigation into a skipped day works; scroll position stable.
3. Measure with perf scenario I (journal scroll) before/after; record under `web/tooling/perf/baselines/`.
4. Docs: `styling.md` invariant (no `position: fixed` descendants inside a `content-visibility` container), `frontend.md` Journal note.

## Checklist
- [ ] Portal BlockMenu + BlockRefBacklinksPopover to body, e2e placement cover
- [ ] content-visibility on .journal-day with contain-intrinsic-size
- [ ] Scenario I before/after; docs
