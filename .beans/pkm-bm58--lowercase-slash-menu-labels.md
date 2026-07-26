---
# pkm-bm58
title: lowercase slash-menu labels
status: completed
type: task
priority: normal
created_at: 2026-07-26T18:27:42Z
updated_at: 2026-07-26T18:28:45Z
---

Slash command menu labels are inconsistently cased (Text, To-do, Query (AND)...). Make them all lowercase only, e.g. /Text -> text, per user request 2026-07-26.

## Summary of Changes

Lowercased every slash-menu label in web/src/outline/slashCommands.ts (text, to-do, table, python code block, bash code block, javascript code block, mermaid diagram, upload file…, heading 1-3, normal text, query (and)/(or)/(and not)) and updated the matching assertions in slashCommands.test.ts and EditableBlockTree.test.tsx. Block-menu items (menuitemradio: Plain text / Heading 1-3, Copy block reference) are a separate menu and were left unchanged. Typecheck + 1457 unit tests pass.
