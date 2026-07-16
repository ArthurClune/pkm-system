---
# pkm-cxo1
title: 'PDF viewer: small hardening/test gaps from pkm-srek reviews'
status: todo
type: task
priority: low
created_at: 2026-07-16T18:02:14Z
updated_at: 2026-07-16T20:15:59Z
---

Collected Minor findings from pkm-srek task reviews, all follow-up grade:
- pdfViewerCore.currentPageFromRatios: untested edge — page 1 absent from map while others have ratio 0 (returns 1; add test)
- pdfViewerCore.placeholderHeight: no guard against non-finite/negative width
- PdfFallbackLink: note="" renders an empty .pdf-error-note span (note !== undefined check); no DOM-ordering test for note-above-link
- PdfEmbed: no explicit test of the cache-hit path (second instance mounting after viewerPromise resolved)
- PdfViewer: footer and overlay bar duplicate indicator/download markup (~10 lines); extract if a third copy appears
- PdfViewer: minHeight stays applied to slots after render — mixed-page-size PDFs get trailing whitespace on shorter pages

## Plan

- [x] currentPageFromRatios: test page-1-absent/others-zero edge (test-only)
- [x] placeholderHeight: guard non-finite width (TDD fix)
- [x] PdfFallbackLink: note="" must not render empty note span; DOM-ordering test (TDD fix + test)
- [x] PdfEmbed: test cache-hit path (second instance after resolve) (test-only)
- [x] PdfViewer: drop slot minHeight once page rendered (TDD fix)
- [x] Footer/overlay markup dedup: no action -- bean says extract only if a third copy appears
- [x] Verify: pnpm verify (26 unit tests + 10 e2e, all green)
