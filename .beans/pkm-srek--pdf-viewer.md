---
# pkm-srek
title: PDF viewer
status: in-progress
type: feature
priority: normal
created_at: 2026-07-15T19:16:29Z
updated_at: 2026-07-16T18:01:58Z
---

PDFs are currently only show as a file reference. We need to choose a pdf viewer and embed it so that pdfs show correctly within the page, complete with scroll bars etc

## Design

Spec: docs/superpowers/specs/2026-07-16-pdf-viewer-design.md

Approach: react-pdf (PDF.js) lazy-loaded custom viewer; fixed-height scrollable card, page indicator, download link, fullscreen-overlay expand; no text layer/zoom/search. Fallback to link UI on any load failure.

Plan: docs/superpowers/plans/2026-07-16-pdf-viewer.md (8 tasks; branch fix/pkm-srek-pdf-viewer)

## Summary of Changes

Replaced the native <embed> PDF rendering with a lazy-loaded PDF.js viewer
(react-pdf): multi-page scrolling in a fixed-height card with lazy page
mounting, 'Page x of y' indicator, download link, and a fullscreen overlay
reading mode (Esc/Close). Degrades to the plain download link when the
chunk or document fails. Added a pdfjsOwnedBytes bundle budget mirroring
mermaidOwnedBytes, precached the pdf.js worker (.mjs glob), and rebaselined
the size budgets. E2E covers upload -> render -> scroll -> expand.

Two deviations from the plan, both forced by reality:
- web/pnpm-workspace.yaml gained publicHoistPattern[pdfjs-dist]: the plan's
  bare worker specifier in PdfViewer.tsx is unresolvable from app code under
  pnpm's strict layout (pdfjs-dist is only react-pdf's transitive dep).
- PdfViewer's Expand/Close buttons call stopPropagation(): clicks otherwise
  bubble into the block's click-to-edit handler and unmount the viewer
  (caught by E2E, pinned by a unit regression test).

## Decision: viewer click containment

Clicks anywhere inside the PDF viewer (inline frame, footer, fullscreen
overlay) deliberately do NOT enter block-edit mode: container-level
stopPropagation on the .pdf-embed root and the portalled .pdf-overlay root
(portals propagate through the React tree, so the overlay bubbles into
.block-text's click-to-edit too). This restores parity with the old native
<embed>, which swallowed clicks.
