---
# pkm-6lg5
title: 'Style the {{toc}} block: framed card with a Table of Contents header'
status: completed
type: feature
priority: normal
created_at: 2026-09-07T13:07:10Z
updated_at: 2026-09-07T13:12:18Z
---

Follow-up to pkm-mzks. Render the toc as an embedded card matching code blocks (border token, radius-card, bg-subtle), hugging its content with a minimum width, with a small uppercase muted 'Table of Contents' header the list indents under; numbers in the muted colour. No functional change.

## Checklist
- [x] TableOfContents.tsx: header element + test
- [x] styles.css: card frame, header, muted numbers
- [x] styling.md: not enumerated there (only the radius token is listed), no change
- [x] pnpm verify green (typecheck, unit coverage, 57 e2e)

## Summary of Changes

- `TableOfContents.tsx` gains a `.toc-header` ("Table of Contents") above the list and the empty state; test added.
- `styles.css`: `.toc` is now an inline-block card in the `.code-block` idiom (border, radius-card, bg-subtle, min-width 240px), the header is a small uppercase muted label, list markers take the muted colour.
- Checked visually in light and dark mode on a scratch server. No functional change; e2e spec unchanged.
