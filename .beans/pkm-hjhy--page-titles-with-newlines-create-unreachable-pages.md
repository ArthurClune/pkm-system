---
# pkm-hjhy
title: Page titles with newlines create unreachable pages
status: completed
type: bug
priority: normal
created_at: 2026-07-29T20:15:53Z
updated_at: 2026-07-29T20:34:48Z
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

## Summary of Changes

`refs.normalize_title` collapses the whitespace in any page title holding a
control char (`\t\n\r\f\v`), then strips. Deliberately narrow: a title with no
control whitespace is returned byte for byte, so existing "Two  Spaces" titles
are never collateral damage. Both regexes are single-quantifier character
classes, so neither can backtrack (cf. pkm-7myl's O(n^2) incident).

Applied at two levels: every title `refs.extract` yields, and the single
creation choke point `store.get_or_create_page` (ops create/move `page_title`,
the CLI, the importer, `POST /api/pages`, rename). Normalizing rather than
rejecting is deliberate -- an offline client replaying a queued op must never
meet a permanent 422, or its queue wedges.

Three more instances of the same bug, found while implementing:

- `tokenize.ts` fed PageLink the raw slice, and PageLink uses that one string
  for both the label and the href -- a multi-line link rendered as a live link
  to a page the API cannot address.
- `refAtCaret.ts` (Ctrl-O navigation) had the identical raw-slice bug.
- `replica/localApi/router.ts` `POST /api/pages` mirrors the server route;
  unnormalized, an offline create left a local row the server never agrees with.

Also: a title that normalizes to empty is no longer a reference at all --
`[[]]` and `[[\n]]` used to mint a blank-titled page.

Not done, by decision: the Starlette `{title:path}` route stays newline-blind.
Prevention closes the source; it does not make an already-broken row
reachable, which is why the six existing pages needed the one-off cleanup.

Verified: server 915 tests / 95.88% coverage / pyrefly 0 errors / ruff clean;
web `pnpm verify` exit 0 (1670 unit + 46 e2e). Merged to main at 6c4774b and
deployed to prod 2026-07-29 21:33 (service restart confirmed against the
deployed HEAD).
