---
# pkm-3vg3
title: A PDF opened full screen from /files or a table cell cannot be scrolled
status: completed
type: bug
priority: normal
created_at: 2026-11-16T20:25:07Z
updated_at: 2026-11-16T20:29:18Z
---

Opening a PDF full screen from a query table cell (or from the /files browser) shows page 1 but the reader cannot scroll to the rest; wheel and trackpad do nothing.

Cause: in overlay mode (PdfViewer with onClose) react-pdf's Document wrapper div (.react-pdf__Document) sits between .pdf-overlay's flex column and .pdf-frame, so the frame's flex: 1 does not apply. The wrapper grows to the whole document's height, the fixed overlay clips it, and the frame never overflows, so there is nothing to scroll. The inline viewer's Expand overlay is unaffected: it renders PdfPages directly in the overlay.

- [x] Failing e2e: the overlay opened from a cell scrolls
- [x] Fix the overlay-mode layout
- [x] Rule stated in styling.md


## Summary of Changes

Symptom: a PDF opened full screen from a table cell (or /files) showed page 1 and would not scroll.

Fix: `.pdf-overlay > .react-pdf__Document` is a flex column that fills the overlay (flex: 1; min-height: 0), so `.pdf-frame` inside it is height-bounded and scrolls. e2e/cell-media.spec.ts now wheels the open frame and asserts it scrolled. Rule: docs/architecture/styling.md § Layout invariants (.pdf-frame).
