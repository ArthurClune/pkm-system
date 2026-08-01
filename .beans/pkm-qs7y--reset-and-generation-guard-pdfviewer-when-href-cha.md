---
# pkm-qs7y
title: Reset and generation-guard PdfViewer when href changes
status: todo
type: bug
created_at: 2026-08-01T13:20:53Z
updated_at: 2026-08-01T13:20:53Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 8.

**References:** web/src/components/PdfViewer.tsx:147-215; web/src/components/InlineSegments.tsx:52-54

failed, document metadata, expansion, and current-page state are retained when href changes. A slow getPage(1) from the previous PDF can overwrite metadata for the new document.

**Direction:** Reset viewer state in an effect keyed by href, and generation-guard both document load and page metadata callbacks.

- [ ] Add rerender and old-document completion race tests
- [ ] Reset and guard per-document state
