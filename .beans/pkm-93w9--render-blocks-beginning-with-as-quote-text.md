---
# pkm-93w9
title: Render blocks beginning with > as quote text
status: completed
type: feature
priority: normal
created_at: 2026-07-13T18:57:34Z
updated_at: 2026-07-14T15:05:57Z
---

Treat a block whose text begins with `> ` as quoted content in both imported data and newly edited blocks.

## Acceptance Criteria

- [x] Any block whose stored text starts with the exact prefix `> ` renders with quote styling.
- [x] Quote rendering works identically for imported blocks and blocks created or edited in the web UI.
- [x] The display presents the text after the prefix as quote content, while editing preserves and exposes the original `> ` source so it round-trips unchanged.
- [x] Inline formatting, page references, block references, and other supported inline segments continue to render inside quoted content.
- [x] Text containing `>` anywhere other than the start-of-block prefix is unaffected.
- [x] Adding or removing the prefix updates the rendered style immediately after the edit is applied.
- [x] Tests cover imported/new blocks, prefix removal, non-prefix greater-than characters, and inline content inside quotes.

## Summary of Changes

Added a pure exact-prefix presentation helper and quote styling to both read-only and editable tree renderers. Display mode strips only the leading `> ` while editing exposes the raw stored source; inline formatting and references continue through the existing tokenizer, and quoted TODO/DONE controls remain interactive while preserving the prefix. Tests cover exact and non-prefix cases, inline content, raw editing, prefix removal, and quoted TODO round-trips.
