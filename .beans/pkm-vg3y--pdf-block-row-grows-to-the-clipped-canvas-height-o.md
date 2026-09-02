---
# pkm-vg3y
title: PDF block row grows to the clipped canvas height on iPadOS WebKit (baseline through scroll frame)
status: completed
type: bug
priority: normal
created_at: 2026-09-02T20:16:03Z
updated_at: 2026-09-02T20:31:16Z
---

In Safari on iPadOS (PWA and browser), a block containing a PDF embed sometimes renders its .block-row hundreds of px taller than the viewer + footer, leaving blank space before the next block/day. Transient: a reload, tab-away, or page-out re-layouts and fixes it. Reproduced in the iPad Air 13-inch simulator on a cache-miss load: .block-row 792px vs .block-text 522px; the (hidden) .chevron sits at the bottom edge of the page-1 canvas (770px down), i.e. WebKit synthesised the flex row's baseline from the canvas inside the overflow:auto .pdf-frame, and later content changes inside the scroller never re-ran the row's flex layout. Forcing a relayout, or align-items:flex-start, collapses the row to 528px. Chromium is unaffected.

## Investigation notes

- First reported as "PDFs too large in the journal": the visible frame is the designed 480px fit-to-width, so the size itself was a red herring. The tell was the hovered `.block-row` highlight running far below the footer.
- Not the timestamps column, not a short journal batch (60 batches from today against a prod copy all return 5 days), not the offline shim (cold start is `connecting`, which reaches the network).
- Deterministic proxy for the mechanism: `.pdf-frame{display:flex;flex-direction:column}` makes WebKit propagate the canvas baseline on every layout (row 777px). Adding `contain: layout` to that frame brings the row back to 528px with the chevron on the footer baseline, so containment removes the frame's baseline as the spec says.
- The natural trigger is timing-dependent (cache-miss loads reproduced 2 of 3 times, later runs 0 of 3), so the fix is verified through the proxy plus Arthur's device, not a flaky cold-load loop.

## Checklist

- [x] Reproduce on real WebKit (iPad Air 13-inch simulator) and identify the stretched element
- [x] Failing CSS-invariant test in `web/src/styles.test.ts` (`.pdf-frame` must declare `contain: layout`)
- [x] Fix: `contain: layout` on `.pdf-frame` with the reason in the stylesheet comment
- [x] Docs: styling.md containment invariant + symptom row; frontend.md PdfViewer note
- [x] `pnpm verify` green (typecheck, lint, fcis, coverage, build, 56 Playwright specs)
- [x] Simulator check on the built bundle: the flex-column proxy that stretched the row to 777px before now leaves it at 528px with the chevron on the footer baseline
- [x] Arthur confirms on the iPad after deploy (2026-09-02: restarts and click in/out of the daily page all render the row at content height)

## Summary of Changes

- `web/src/styles.css`: `contain: layout` on `.pdf-frame`, with the reason in the rule's comment. A layout-contained box offers no baseline, so the baseline-aligned `.block-row` takes its baseline from `.pdf-footer`'s text instead of from the page-1 canvas inside the scroller.
- `web/src/styles.test.ts`: pins the declaration and that nothing `position: fixed` is declared inside the frame.
- `docs/architecture/styling.md`: names `.pdf-frame` as the one layout-contained box under the containment invariant; symptom row added. `docs/architecture/frontend.md`: PdfViewer note pointing at the rule.
- Deployed to prod at 4e4745e on 2026-09-02 and confirmed on the iPad.
