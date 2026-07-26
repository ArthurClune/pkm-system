---
# pkm-6nif
title: \query shortcut
status: completed
type: feature
priority: normal
created_at: 2026-07-26T15:31:55Z
updated_at: 2026-07-26T18:23:03Z
---

Add a 'query' shortcut that puts in a placeholder for a query

\query-and => 'query {and: [[A]] [[B]]}

and the same for 'or' and 'and-not' variations



## Checklist
- [x] Read slashCommands.ts, slashCommands.test.ts, server/src/pkm/server/query.py
- [x] Write failing unit tests for query-and / query-or / query-and-not (empty-block insert + non-empty preserve + matchSlashCommands)
- [x] Implement SLASH_COMMANDS entries + applySlashCommand cases via a name->expression lookup
- [x] Run web unit tests, confirm pass
- [x] cd web && pnpm verify (typecheck + coverage + e2e)
- [x] Commit code + bean file

## Summary of Changes

Added three slash-menu commands (`query-and`, `query-or`, `query-and-not`) to
`web/src/outline/slashCommands.ts`, mirroring the existing `table` command's
behavior exactly: non-empty block content is left unchanged (cursor at end),
otherwise a `{{query: ...}}` placeholder is inserted (cursor at end of the
inserted text). The three expression bodies are factored into a single
`QUERY_EXPRESSIONS` name->expression lookup rather than three copy-pasted
case bodies, feeding one `queryPlaceholder()` helper.

Placeholders inserted:
- query-and: `{{query: {and: [[A]] [[B]]}}}`
- query-or: `{{query: {or: [[A]] [[B]]}}}`
- query-and-not: `{{query: {and: [[A]] {not: [[B]]}}}}`

Verified each expression parses via the server's `parse_query`
(server/src/pkm/server/query.py) with a one-off Python check, and confirmed
the outer `{{query: ...}}` wrapping matches the exact format already covered
by web/src/grammar/tokenize.test.ts's balanced-brace-scan tests. Server was
not modified.

Only slashCommands.ts + slashCommands.test.ts were touched, as expected — the
autocomplete popup and BlockInput consume SLASH_COMMANDS/applySlashCommand
generically.

Full `pnpm verify` (typecheck, lint, fcis, coverage, build, e2e) passed except
for one pre-existing, unrelated e2e failure: "Cmd-B bolds the selection and
renders <strong> (pkm-kkpe)" times out waiting on a Meta+b keypress. Verified
via `git stash` that this fails identically with the slashCommands changes
removed — a pre-existing headless-CDP Meta-chord limitation (same category as
prior "headless CDP can't reproduce native mac selection chords" findings),
not a regression from this change.
