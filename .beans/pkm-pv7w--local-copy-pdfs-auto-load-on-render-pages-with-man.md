---
# pkm-pv7w
title: 'Local-copy PDFs auto-load on render; pages with many Local copy:: links break'
status: completed
type: bug
priority: normal
created_at: 2026-09-21T15:06:28Z
updated_at: 2026-09-21T15:10:09Z
---

Every /api/local/*.pdf link mounts PdfViewer immediately, so a page listing dozens of Local copy:: papers fires dozens of concurrent PDF fetches and pdf.js parses on load (and brctl downloads for evicted files). Fix: PdfEmbed gets a deferred mode that shows the link plus an Open button and imports nothing until clicked; InlineSegments uses it for /api/local/ hrefs only. /assets/ PDFs unchanged.

- [x] PdfEmbed deferred mode (tests first): link + Open, no viewer or chunk import until click, Open click does not bubble
- [x] PdfFallbackLink optional onOpen button (Core)
- [x] InlineSegments passes deferred for /api/local/ PDFs only (tests)
- [x] frontend.md note on isPdfHref/local PDFs
- [x] Verify: vitest for touched files, typecheck, lint, check:fcis

## Summary of Changes

- `PdfEmbed` gains a `deferred` prop: it rests as the plain download link plus an Open button and starts neither the viewer chunk import nor the PDF fetch until Open is clicked; the click stops propagation so the block does not re-enter edit mode. After the click it is the ordinary inline viewer (Expand, Download, 503 note all unchanged).
- `PdfFallbackLink` takes an optional `onOpen` and renders the button (still Functional Core); `.pdf-open` spacing in styles.css.
- `InlineSegments` passes `deferred` for `/api/local/` hrefs only, via `isDeferredPdfHref`; `/assets/` PDFs keep the inline auto-load.
- Tests: PdfEmbed (deferred resting state, click mounts viewer, no bubbling, non-deferred unchanged), InlineSegments (local PDF needs Open), e2e local-docs.spec clicks Open and asserts no frame beforehand and no edit-mode re-entry afterwards.
- Docs: frontend.md `isPdfHref` note explains the deferred form and why.
- Verified: web unit suite 2580 passed at 98.24% coverage, typecheck/lint/check:fcis clean, full Playwright suite 59 passed.
