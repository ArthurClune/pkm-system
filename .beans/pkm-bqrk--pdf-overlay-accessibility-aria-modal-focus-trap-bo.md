---
# pkm-bqrk
title: 'PDF overlay accessibility: aria-modal, focus trap, body scroll lock'
status: todo
type: task
priority: normal
created_at: 2026-07-16T18:02:14Z
updated_at: 2026-07-16T20:27:24Z
---

Follow-up from pkm-srek final review. The fullscreen PDF overlay (web/src/components/PdfViewer.tsx, .pdf-overlay, role=dialog) lacks aria-modal="true", focus management (focus moves into the dialog on open, returns to Expand on close), a focus trap, and a body scroll lock (wheel/touch chains to the page behind once the frame hits its end).

## Summary of Changes

- `.pdf-overlay` dialog now has `aria-modal="true"`.
- On open, focus moves to the Close button; on close (Escape or Close), focus returns to the Expand button.
- Tab/Shift+Tab are trapped inside the overlay: wrap decision is a pure helper `focusWrapTarget` in pdfViewerCore.ts (FCIS), DOM wiring in PdfViewer.tsx via a window keydown listener (window-level so Tab is caught even when a click on non-focusable overlay content drops focus to body, which then gets pulled back inside).
- Body scroll lock while open: `document.body.style.overflow = "hidden"`, prior value restored on close; `.pdf-overlay .pdf-frame` gets `overscroll-behavior: contain` so wheel/touch don't chain past the frame.
- Unit tests for all four behaviours + pure-helper tests; e2e pdf.spec.ts extended with real-browser focus/scroll-lock/trap assertions.
