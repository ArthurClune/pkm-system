---
# pkm-ak4e
title: Title lookup with control whitespace must not resolve to a different page
status: completed
type: bug
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-24T21:52:15Z
parent: pkm-mfd0
---

Review finding (Low): normalize_title collapses every whitespace run once a control character is present, so /api/page/A%20%20B%0A acts on page 'A B' while 'A  B' exists. GET, DELETE, rename (and MCP rename_page with allow_merge) all reach the folded page while the approval card shows the raw title.

- [ ] Red test first, from the review probe: sec-pages/p1_titles.py and sec-pages/p1b_fold_rename.py. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [x] Decide the rule: fold only the control characters, or refuse a lookup key that folds onto a different existing title
- [x] Regression test with both pages present for get, delete, rename and the MCP client path

## Decision (Arthur, 2026-10-24)

See docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md, row pkm-ak4e.

## Summary of Changes

- Title fold: every whitespace run in a title folds to one U+0020 at creation and lookup, from one explicit list TITLE_WHITESPACE (Unicode White_Space, 25 code points) in pkm/contracts/titles.py; the web gets it as generated web/src/grammar/titleWhitespace.gen.ts with an exact-match guard. Server and web fold identically (differential check over U+0000–U+FFFF plus astral samples: 0 mismatches). The review probes now reach exactly one page under both flag values.
- Migration: the audited title migration groups pages that now share a spelling and retitles every non-canonical sidebar entry; it may run on an already-active database when the audit finds work (still 409 when there is nothing to do). Digest payload version 3; audit/apply responses gain sidebar_retitles / sidebars_retitled.
- Startup check: logs one ERROR on pkm.titles naming non-canonical page titles and sidebar entries, pointing at pkm migrate-titles and docs/cli.md § Rows the migration cannot fix; it never stops startup (any failure is logged).
- Properties: server and web title properties draw every listed whitespace character, with event() reach and mutants caught.
- Docs: backend.md § Title integrity, sync-and-offline.md, frontend.md, cli.md (incl. manual fix for rows the migration cannot fix), troubleshooting row.
- Prod: the three approved NBSP titles were renamed via pkm rename before deploy; a fresh prod copy then audited clean (0 groups, blockers, retitles, non-canonical titles).
- Rulings: startup check logs, never refuses or repairs; audited apply allowed on an active DB when it has work; fence/attribute trimming keep their own set; title properties run in every pytest/pnpm verify.
