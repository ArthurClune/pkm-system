---
# pkm-srek
title: PDF viewer
status: in-progress
type: feature
priority: normal
created_at: 2026-07-15T19:16:29Z
updated_at: 2026-07-16T16:46:55Z
---

PDFs are currently only show as a file reference. We need to choose a pdf viewer and embed it so that pdfs show correctly within the page, complete with scroll bars etc

## Design

Spec: docs/superpowers/specs/2026-07-16-pdf-viewer-design.md

Approach: react-pdf (PDF.js) lazy-loaded custom viewer; fixed-height scrollable card, page indicator, download link, fullscreen-overlay expand; no text layer/zoom/search. Fallback to link UI on any load failure.

Plan: docs/superpowers/plans/2026-07-16-pdf-viewer.md (8 tasks; branch fix/pkm-srek-pdf-viewer)
