---
# pkm-wstt
title: 'Journal infinite scroll breaks: resync collapses scrolled days; empty batches stall the observer'
status: in-progress
type: bug
priority: normal
created_at: 2026-07-22T14:46:01Z
updated_at: 2026-07-22T15:00:17Z
---

Two defects in web/src/views/Journal.tsx: (1) useResync(reset) clears the cursor and reloads only the head batch, so a ws reconnect/resync collapses the view back to today even after scrolling in older days. Fix: reload a window as large as what was on screen (capped at server max 31). (2) A batch of all-empty days adds no DOM height, so the IntersectionObserver never re-fires and auto-load silently stalls; largely obsoleted by the non-empty-days API but the stop condition must be exhaustion-based, not MAX_EMPTY_BATCHES. Reported 2026-07-22 by Arthur: journal only shows today; scroll does not bring in previous entries even after full reload.

## Design

- reset() (resync) currently reloads only the head batch (5), collapsing a scrolled window to ~today. Fix: capture the on-screen day count before clearing the cursor and issue the head reload with days=min(31, max(5, count)) so the whole window refreshes in place.
- The all-empty-batch IntersectionObserver stall disappears with the non-empty API (pkm-03x6): every batch now adds rendered days or signals exhaustion.

## Checklist

- [x] Failing test: resync preserves the scrolled window (window-sized head reload)
- [x] Fix reset()/loadMore window sizing
- [x] Tests green
