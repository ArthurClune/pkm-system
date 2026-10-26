---
# pkm-ax2j
title: Page titles longer than 1,000 characters are refused
status: completed
type: feature
priority: normal
created_at: 2026-10-25T12:48:18Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

Arthur, 2026-10-25 (decisions spec row 'Page title length'): page titles are limited to 1,000 characters, refused on create, rename and import like the other title rules. The server accepted a 2,000,000-character title, and a rename to a long title inflates every linking block. Check prod's longest title first.

- [x] Prod survey: longest title
- [x] Server: refuse on every title entry point (ops create_page, rename/merge, importer refuses naming the page, MCP/CLI via ops); web mirror for the editor/replica; parity fixture
- [x] troubleshooting.md row; backend.md title rules

Arthur, 2026-10-25: a line whose text before `::` is over 1,000 characters stays refused (the attribute name is a page title); no grammar change.

## Summary of Changes

- Behaviour: page titles longer than 1,000 code points are refused on every entry point: ops create_page and rename/merge (page_title included), POST /api/pages, rename, sidebar pin, importer (skips the page and lists it in the import report, the message carries the length, never the title), MCP and CLI via ops; the web mirrors it in the editor, replica and offline queue, with shared/fixtures/title_length.json as the parity fixture and the ops property reaching it (13-20 per run; a mutant at 1,001 fails both web properties). Length is measured in code points after the whitespace fold, on what the client sent, and is judged before title syntax. A line whose text before `::` is over 1,000 characters stays refused (no grammar change).
- Prod survey: longest title 260 characters, sidebar 20, 0 rows over. Commits: ca92d30c, e2d11ee8, e201ce07 (length-before-syntax pinned on every title route). backend.md Refused titles and troubleshooting row.
- Rulings: Arthur 2026-10-25: 1,000-character title limit (decisions spec row); over-long attribute name stays refused, no grammar change. Orchestrator: the importer skips an over-long title and lists it in the report like the other title rules (the bean's "refuse the import naming the page" was a paraphrase; a one-step change if wrong); fold-then-measure (a padded 1,000-char title is refused at 1,002).
- Follow-ups: pkm-5sot, pkm-qgjs, pkm-8ui6, pkm-yeat, pkm-v3ub.

Follow-up beans filed from the final review and re-reviews: pkm-hlom (subtree-sized moves and deletes cost a tiny op its subtree), pkm-8w77 (run apply_batch off the event loop), pkm-5sot (importer report prints a refused over-long title in full), pkm-qgjs (title-length check keystroke cost near the cap), pkm-8ui6 (legacy over-long titles skip the client check on drag, Unlinked Link, no-replica), pkm-yeat (title-length parity fixture lacks NBSP/combining/surrogate cases), pkm-76sh (test_no_500_upstream_props reach floor flake), pkm-7981 (ops property never reaches the over-limit landings), pkm-v3ub (editor does not pre-check forbidden title characters; unverified).
