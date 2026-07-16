---
# pkm-bqrk
title: 'PDF overlay accessibility: aria-modal, focus trap, body scroll lock'
status: todo
type: task
created_at: 2026-07-16T18:02:14Z
updated_at: 2026-07-16T18:02:14Z
---

Follow-up from pkm-srek final review. The fullscreen PDF overlay (web/src/components/PdfViewer.tsx, .pdf-overlay, role=dialog) lacks aria-modal="true", focus management (focus moves into the dialog on open, returns to Expand on close), a focus trap, and a body scroll lock (wheel/touch chains to the page behind once the frame hits its end).
