---
# pkm-m0u3
title: 'Query table: line titles show raw markdown; long titles push the :: columns off-screen'
status: completed
type: bug
priority: normal
created_at: 2026-11-15T22:45:58Z
updated_at: 2026-11-15T22:57:05Z
parent: pkm-l79g
---

Reported on the iPad for {{query: {and: [[LLM]] [[Paper]]}}}: Table view shows only the Result column, and a line record's title shows as raw markdown ([text](url) #LLM #Paper) in table and cards, while Blocks view renders it.

- [x] Reproduce both against a copy of prod data
- [x] Line record titles render through the inline renderer (table and cards)
- [x] Long titles and values wrap, so the :: columns stay in view
- [x] Help page: how a query table picks its columns and saved-view options
- [x] Assistant system prompt and pkm skill: query tables and options
- [x] Docs and verification

## Summary of Changes

Symptom: a query's Table view showed only the Result column, and a line result's title showed as raw markdown (`[text](url) #LLM #Paper`) in Table and Cards while Blocks rendered it.

Causes: (1) `RecordLink` printed a line record's `row_title` as plain text. It now renders through `InlineSegments` inside a `role=link` span that opens the line, leaving clicks on its own links alone (the `BacklinkGroupList` pattern). (2) The columns were there but off-screen: `.data-table` is `min-width: max-content`, so one unwrapped URL made the Result column ~1500px wide. Each body cell's content now sits in a capped `.table-cell` (also in the static `roamTable` fallback so a plain table doesn't jump when its chunk loads); see styling.md § Tables.

Docs: help page (docs/keyboard.md) gains a Query tables section (how results map to rows, where columns come from, filter syntax, saved-view options); the assistant's SYSTEM_PROMPT and the pkm skill gain the same, and the skill no longer says the table macro text must be exactly {{table}}. initialEntryBytes budget raised by the size of the help text, which the entry chunk carries.
