---
# pkm-mzks
title: 'Add /toc slash command: live table of contents from page headings'
status: in-progress
type: feature
created_at: 2026-09-07T12:43:33Z
updated_at: 2026-09-07T12:43:33Z
---

Add a /toc slash command (label 'table of contents') that inserts a {{toc}} macro. Unfocused, the block renders a nested list of the page's heading blocks (heading field 1-3), nested by outline depth: each entry's parent is its nearest heading ancestor. Entries link to #<uid> so the existing hash scroll-and-flash handles navigation. Derived live from the block tree on every render, nothing stored; server/CLI/MCP untouched ({{toc}} passes through as literal text, like {{table}}).

## Checklist
- [x] slashCommands.ts: toc command + test
- [x] tocEntries.ts pure walk + test
- [x] TableOfContents.tsx + test
- [x] EditableBlockTree: detect {{toc}}, root-blocks context, live update test
- [x] Playwright e2e for /toc (web/e2e/toc.spec.ts written; the suite itself has not been run yet)
- [x] docs/keyboard.md row; docs/architecture/frontend.md module map + renderer list — keyboard.md done; frontend.md pending
- [ ] pnpm verify green
- [ ] Known limitations noted: collapsed targets no-op; sidebar links target main pane hash; raw text entries
