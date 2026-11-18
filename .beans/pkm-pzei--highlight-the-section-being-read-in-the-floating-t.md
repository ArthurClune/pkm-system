---
# pkm-pzei
title: Highlight the section being read in the floating toc
status: draft
type: feature
created_at: 2026-11-18T19:02:42Z
updated_at: 2026-11-18T19:02:42Z
---

Follow-up to the floating {{toc}} beside the main page. The floating list could mark the section the reader is in as the page scrolls (scroll-spy), as anil.recoil.org's notes pages do. Left out of the first version by choice.

Notes for whoever picks it up:
- Headings are ordinary rows with data-uid in the DOM (no virtualisation); a heading under a collapsed ancestor has no element.
- Measure positions on each scroll rather than caching them: PDFs and embeds change height after first paint.
- Only the floating list may re-render on scroll, never the outline's rows; perf/check.sh frontend counts renders.
- The choice of active section from heading positions is pure and belongs in a Functional Core module beside tocFloat.ts.
