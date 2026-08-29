---
# pkm-5o11
title: 'Files viewer: open PDFs in in-app PdfViewer overlay on all surfaces'
status: completed
type: bug
priority: normal
created_at: 2026-08-29T13:26:29Z
updated_at: 2026-08-29T13:36:31Z
---

In /files, PDF cards are plain target=_blank anchors (web/src/views/Files.tsx:87-90). On desktop that opens a new tab; in the iOS standalone PWA the same-origin navigation takes over the whole app with no way back (the Safari external-link interceptor deliberately ignores same-origin URLs). Fix: unify all surfaces — clicking a PDF opens the existing PdfViewer fullscreen overlay (Close + Download + page indicator), lazy-loaded via PdfEmbed, same pattern as image cards' ImageOverlay.

## Design (approved)

1. PdfViewer.tsx: add modal-only mode — optional defaultExpanded + onClose props so it mounts directly expanded; Close unmounts via onClose instead of collapsing to inline frame.
2. Files.tsx: branch on mimeCategory — 'pdf' renders a button (like image thumbs) opening the lazy PdfEmbed overlay. Images unchanged; other categories keep the anchor (served as attachment => download, no PWA hijack).
3. No backend change (PDFs already Content-Disposition: inline; pdfjs worker same-origin + SW-precached).
4. Unit tests for card branching and new viewer mode; update docs/architecture/frontend.md /files browser section.

## Tasks

- [x] Tests for PdfViewer overlay-only (onClose) mode
- [x] Implement PdfViewer modal-only mode
- [x] Tests for Files.tsx pdf-card branching
- [x] Implement Files.tsx pdf card -> overlay
- [x] Update docs/architecture/frontend.md
- [x] pnpm verify green

## Summary of Changes

- PdfViewer.tsx: new overlay-only mode via optional onClose prop — renders the fullscreen dialog from the first frame (chrome before the document loads), Close/Escape call onClose, parent owns unmounting; load failure shows PdfFallbackLink inside the overlay. Modal effect (focus trap, scroll lock, Escape) generalised to both modes via a dismissRef so an unstable onClose can't re-steal focus.
- PdfEmbed.tsx: forwards onClose to the lazy viewer.
- Files.tsx: PDF cards render a button opening PdfEmbed in overlay mode instead of a same-origin target=_blank anchor (which took over the iOS standalone PWA); focus returns to the thumb on close. Images unchanged; document/other keep the anchor (served as attachment).
- styles.css: padding for the overlay's loading note / fallback link.
- Tests: 4 new PdfViewer overlay-mode tests, Files pdf-card test (PdfEmbed stubbed), react-pdf mock now honours the loading prop.
- docs/architecture/frontend.md: /files section documents the three thumb behaviours; symptom rows added for the PWA takeover (pkm-5o11) and moved the stray pkm-0one bean id from prose into the table.
