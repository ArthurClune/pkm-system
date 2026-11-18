---
# pkm-uwo5
title: Float the {{toc}} on the right of the main page
status: completed
type: feature
priority: normal
created_at: 2026-11-18T18:34:18Z
updated_at: 2026-11-18T19:12:02Z
---

On a page with a {{toc}} block, show the contents in a sticky column on the right of the main pane while the right sidebar is closed and the pane has room; the {{toc}} block then shrinks to a marker. When the sidebar opens (or the pane is too narrow, or the page is in a sidebar panel) the floating contents hides and the block shows the full card again. Spec: docs/superpowers/specs/2026-11-18-floating-toc-design.md

- [x] Spec approved
- [x] Plan: docs/superpowers/plans/2026-11-18-floating-toc.md
- [x] Implementation (TDD)
- [x] Docs (frontend-rendering.md, styling.md as needed)
- [x] pnpm verify, perf/check.sh frontend

- [x] Final whole-branch review

Follow-up: pkm-pzei (highlight the section being read).

## Summary of Changes

On the main page, the first {{toc}} block now floats in a sticky column at the right of the page card while the right sidebar is closed and the pane is wide enough (tocFloatRoom, FLOATING_TOC_MIN_PANE_PX). Its row shows a .toc-marker (the card's title alone), so the list is on screen once. Floating entries are 13px. Opening the sidebar, narrowing the window, sidebar panels and journal days all keep the in-place card.

- Core: firstTocUid (tocEntries.ts), tocFloatRoom (tocFloat.ts).
- App measures the main pane with useTocFloatRoom and publishes TocFloatRoomContext; EditablePage (floatToc, PageView only) publishes FloatingTocContext, read only by TocBlock.
- EditablePage keeps one wrapper element whether or not the toc floats, so a swap never remounts the outline's rows (embeds would reload).
- Docs: frontend-rendering.md § Segment dispatch, styling.md § Layout invariants.
- Tests: unit (core, hook, EditablePage, TocBlock) and e2e/toc-float.spec.ts.

Follow-up: pkm-pzei (highlight the section being read).
