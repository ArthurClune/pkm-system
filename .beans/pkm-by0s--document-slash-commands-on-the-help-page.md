---
# pkm-by0s
title: document slash commands on the help page
status: completed
type: feature
priority: normal
created_at: 2026-07-26T18:32:27Z
updated_at: 2026-07-26T18:33:42Z
---

The /help page (docs/keyboard.md) doesn't mention slash commands. Add a Slash commands section listing every command in SLASH_COMMANDS with what it does, plus a unit test guarding against drift between SLASH_COMMANDS and the doc.

## Summary of Changes

Added a '## Slash commands' section to docs/keyboard.md (rendered at /help) documenting all 15 commands, including the query placeholders and the letters-and-digits-only filter caveat (type /query and pick a variant — a typed hyphen closes the menu). Added web/src/help/slashCommandsDocumented.test.ts as a drift guard: it fails if any SLASH_COMMANDS entry is missing from the doc. 1473 unit tests + typecheck pass.
