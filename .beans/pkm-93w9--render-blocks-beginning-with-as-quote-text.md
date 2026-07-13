---
# pkm-93w9
title: Render blocks beginning with > as quote text
status: todo
type: feature
created_at: 2026-07-13T18:57:34Z
updated_at: 2026-07-13T18:57:34Z
---

Treat a block whose text begins with `> ` as quoted content in both imported data and newly edited blocks.

## Acceptance Criteria

- [ ] Any block whose stored text starts with the exact prefix `> ` renders with quote styling.
- [ ] Quote rendering works identically for imported blocks and blocks created or edited in the web UI.
- [ ] The display presents the text after the prefix as quote content, while editing preserves and exposes the original `> ` source so it round-trips unchanged.
- [ ] Inline formatting, page references, block references, and other supported inline segments continue to render inside quoted content.
- [ ] Text containing `>` anywhere other than the start-of-block prefix is unaffected.
- [ ] Adding or removing the prefix updates the rendered style immediately after the edit is applied.
- [ ] Tests cover imported/new blocks, prefix removal, non-prefix greater-than characters, and inline content inside quotes.
