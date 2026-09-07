---
# pkm-mzks
title: 'Add /toc slash command: live table of contents from page headings'
status: completed
type: feature
priority: normal
created_at: 2026-09-07T12:43:33Z
updated_at: 2026-09-07T12:57:05Z
---

Add a /toc slash command (label 'table of contents') that inserts a {{toc}} macro. Unfocused, the block renders a nested list of the page's heading blocks (heading field 1-3), nested by outline depth: each entry's parent is its nearest heading ancestor. Entries link to #<uid> so the existing hash scroll-and-flash handles navigation. Derived live from the block tree on every render, nothing stored; server/CLI/MCP untouched ({{toc}} passes through as literal text, like {{table}}).

## Checklist
- [x] slashCommands.ts: toc command + test
- [x] tocEntries.ts pure walk + test
- [x] TableOfContents.tsx + test
- [x] EditableBlockTree: detect {{toc}}, root-blocks context, live update test
- [x] Playwright e2e for /toc (web/e2e/toc.spec.ts)
- [x] docs/keyboard.md row; docs/architecture/frontend.md module map + renderer list + editor note
- [x] pnpm verify green (typecheck, unit coverage, 57 e2e)
- [x] Known limitations noted (see Summary)

## Summary of Changes

- `/toc` slash command (label "table of contents") inserts `{{toc}}` into an empty block, sharing a `macro()` helper with `/table`.
- `tocEntries.ts` (Core) walks the page tree and nests headings by nearest heading ancestor; `TableOfContents.tsx` renders them as router links to `#<uid>`, which PageView's `useScrollFlashTarget` consumes.
- `EditableBlockTree` publishes its blocks via `RootBlocksContext`; only `TocBlock` reads it, so row memoisation is unchanged. A focused toc block shows the raw macro textarea; its children render as ordinary rows.
- No server, CLI or MCP change: `{{toc}}` passes through as literal text like `{{table}}`.
- Docs: keyboard.md slash row; frontend.md module map, renderer list, editor note, e2e count.

## Known limitations

- Only PageView consumes the URL hash: entries do nothing in the journal, and from a sidebar panel they scroll the main pane (only if the same page is open there). A follow-up could scroll within the nearest `.block-tree` instead.
- A heading inside a collapsed subtree is listed but its link is a no-op (target not in the DOM).
- Entry text is the heading's raw block text, so `[[links]]` show their brackets.
