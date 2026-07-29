---
# pkm-hjhy
title: Page titles with newlines create unreachable pages
status: in-progress
type: bug
created_at: 2026-07-29T20:15:53Z
updated_at: 2026-07-29T20:15:53Z
---

A block containing a multi-line [[link]] mints a page whose title holds a literal newline. Such pages are unreachable through the API: Starlette's {title:path} converter compiles to '^/api/page/(?P<title>.*)$' without re.DOTALL, so '.' never matches the newline and GET/DELETE/rename/export all 404. The page shows up in search but cannot be opened or deleted from the UI.

Root cause of creation: refs._scan_brackets is a character scan with no newline restriction, so extract() yields a ref title containing the newline; ops_apply.py:141 and store.py:65 then call get_or_create_page() for every extracted ref, minting the page implicitly. No create endpoint is ever called, so a 422 has nowhere to live.

Fix (agreed with user 2026-07-29): normalize the title where it is born rather than making the broken route reachable.

- [x] Core: whitespace-normalize extracted ref titles in refs.py (collapse runs containing a control char to one space, then strip; leave runs of plain spaces alone so an existing 'foo  bar' title is not collateral)
- [x] Update shared/fixtures/ref_grammar.json with multi-line link cases
- [x] Mirror in web/src/grammar/{refs,scan}.ts and web/src/replica/refs.ts so the parity tests pass
- [x] Belt and braces: normalize in store.get_or_create_page (covers ops page_title, CLI save -p, importer, POST /api/pages, rename). Normalize rather than 422: an offline client replaying a queued op must never hit a permanent rejection or its queue wedges
- [x] server: pytest, pyrefly, ruff
- [x] web: pnpm verify

Found while implementing, also fixed:

- [x] A title that normalizes to empty is no longer a reference at all: `[[]]` and `[[\n]]` used to mint a blank-titled page (regenerated shared/fixtures/refs_parity.json documents the change)
- [x] tokenize.ts rendered the raw slice, and PageLink uses that one string for both the label and the href -- a multi-line link rendered a live link to a page the API cannot address
- [x] refAtCaret.ts (Ctrl-O navigation) had the same raw-slice bug
- [x] replica/localApi/router.ts POST /api/pages mirrors the server route; without normalizing there, an offline create would leave a local row the server never agrees with

Live-data cleanup was done separately on 2026-07-29 (operational, not part of this bean): deleted two empty ATLAS pages (4389, 4390) and renamed four content-bearing Roam-import pages (2999, 3028, 3029, 3069) to their single-line titles. Backup at ~/.config/pkm/backups/pkm.sqlite3.bak-2026-07-29-pre-title-cleanup.
