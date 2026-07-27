---
# pkm-nl6h
title: query shortcut creates pages for markers
status: completed
type: bug
priority: normal
created_at: 2026-07-27T18:57:06Z
updated_at: 2026-07-27T19:12:57Z
---

/query shortcut creates a placeholder query [A] [B] item, which creates the 'A' and 'B' pages. We need to stop those pages being created. It's probably fine to just special case A and B, or maybe do something smarter with the expansion of the shortcut


## Summary of Changes

Root cause: `/query-and`, `/query-or`, `/query-and-not` (web/src/outline/slashCommands.ts,
shipped with pkm-6nif) expanded to placeholders like
`{{query: {and: [[A]] [[B]]}}}` — real `[[A]]` / `[[B]]` page-link tokens.
Both the client replica (web/src/replica/localOps.ts's reindexRefs) and the
server (server/src/pkm/server/ops_apply.py's ReindexRefs effect) unconditionally
get-or-create a page for every ref extracted from a block's committed text
(web/src/grammar/refs.ts / server/src/pkm/refs.py — this is the generic,
intentional [[link]] auto-create behaviour, not specific to queries). Picking
the shortcut left the cursor at the very end of the inserted text (outside
both bracket pairs), so the placeholder's `[[A]]`/`[[B]]` committed as
ordinary refs on the very next debounced autosave (500ms) even if the user
never typed anything further — silently creating junk pages titled "A" and
"B".

Fix chosen: changed the expansion itself (web/src/outline/slashCommands.ts's
QUERY_EXPRESSIONS) so the operand placeholders are bare, non-bracketed text
("A"/"B") instead of real `[[A]]`/`[[B]]` page links. Plain text is never
scanned as a ref (web/src/grammar/scan.ts requires literal `[[...]]`), so
nothing gets auto-created merely by inserting the shortcut. This was
preferred over special-casing the page titles "A"/"B" in the ref-extraction
or get-or-create-page code paths (server/src/pkm/server/store.py,
server/src/pkm/server/ops_apply.py, web/src/replica/localOps.ts): that logic
is shared by every real `[[link]]` in the app, a real user could legitimately
have (or want) a page named "A", and special-casing there would be a global,
surprising carve-out in generic ref-creation semantics for a problem that is
really about one shortcut's initial content. The query grammar
(server/src/pkm/server/query.py's parse_query) does require literal
`[[Page]]` tokens for a real operand, so the placeholder is intentionally
left as invalid query syntax until the user replaces "A"/"B" with real
`[[Page]]` links (the query block shows the server's ordinary parse-error
text in the meantime, same as any hand-typed malformed query) — no new
UI/error-handling code was needed since QueryBlock.tsx already surfaces
QueryParseError messages.

Files changed:
- web/src/outline/slashCommands.ts — QUERY_EXPRESSIONS placeholders no longer
  use `[[...]]`
- web/src/outline/slashCommands.test.ts — updated expected placeholder
  strings/cursors; added a regression test asserting `extractRefs()` finds no
  refs (and no `[[`) in any of the three query placeholders
- docs/keyboard.md — Slash commands table + instructions updated to match
  the new bare "A"/"B" placeholder text

No server route/schema changes, so no openapi.json/TS type regen was needed.

Verification:
- `cd server && uv run pytest -q` — 754 passed, 95.76% coverage (>= 95% required)
- `cd server && uv run pyrefly check` — 0 errors
- `cd server && uv run ruff check` — All checks passed
- `cd web && pnpm build && E2E_PORT=8981 pnpm verify` — typecheck clean; lint
  clean; FCIS check clean; 107 unit test files / 1536 tests passed with
  coverage (97.26% stmts); all 38 Playwright e2e specs passed
