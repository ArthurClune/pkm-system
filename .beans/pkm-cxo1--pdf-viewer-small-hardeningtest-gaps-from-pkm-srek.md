---
# pkm-cxo1
title: 'PDF viewer: small hardening/test gaps from pkm-srek reviews'
status: completed
type: task
priority: low
created_at: 2026-07-16T18:02:14Z
updated_at: 2026-07-16T20:17:47Z
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

## Summary of Changes

Branch worktree-fix-pkm-cxo1-pdf-hardening, merged --no-ff to main.

- placeholderHeight now guards non-finite width (NaN/Infinity -> 1); negative width already clamped by the existing floor (test added).
- PdfFallbackLink renders the note span only for a non-empty note (was note !== undefined, so note="" produced an empty .pdf-error-note). DOM-ordering test added (note above link).
- PdfPages tracks rendered pages via Page onRenderSuccess and drops the slot minHeight once the canvas owns the height, so mixed-page-size PDFs no longer get page-1-shaped trailing whitespace under shorter pages. Test mock's Page now fires onRenderSuccess on mount like the real react-pdf.
- New coverage: currentPageFromRatios page-1-absent/all-zero edge; PdfEmbed second-instance mount from the cached viewerPromise.
- Footer/overlay indicator+download markup dedup: intentionally not done, per this bean's own wording (extract only if a third copy appears).

Verified with full pnpm verify (typecheck, unit coverage, lint/fcis/budgets, 10 e2e incl. both pdf specs) on the branch; 1169 unit tests re-run green on merged main.
