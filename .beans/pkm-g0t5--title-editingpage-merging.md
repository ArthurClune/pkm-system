---
# pkm-g0t5
title: Title Editing/Page merging
status: completed
type: feature
priority: normal
created_at: 2026-07-15T20:40:36Z
updated_at: 2026-07-17T19:16:36Z
---

Must be able to edit page titles

If there is no existing page with the same title as the new one (case sensitive), just rename the page including updating all references, then go to that page

If there is an existing page with the same title, merge the two pages by concatination, update all references then go to the merged page




## Summary of Changes

- `server/src/pkm/rename.py` (Functional Core): `rewrite_title_refs` rewrites `[[Title]]`, `#[[Title]]`, `#tag`, and leading `attr::` refs using the pinned ref grammar; code spans untouched; forms preserved or downgraded (`#tag` → `#[[..]]`, `attr::` → `[[..]]`) when the new title breaks the form's grammar. Case-sensitive throughout.
- `POST /api/page/{title}/rename` (`routes_pages.py` + `store.py` helpers): atomic rename — retitle row, rewrite/reindex every referencing block, retitle sidebar entry; one commit, one WS nudge. 404 missing page, 400 unchanged/daily-note source, 422 blank or bracket-sequence titles, 409 collision without `allow_merge`.
- Merge path (`merge_page_rows`): with `allow_merge=true`, rewrites refs to the target, appends the source's top-level blocks after the target's (subtrees + `((uid))` refs intact), drops the source page. Returns `{"result": "merged"}`.
- Web: click-to-edit `PageTitle` component in PageView — Enter/blur commit, Escape reverts, 409 → confirm dialog → merge retry, errors revert with a message; daily-note titles not editable. Regenerated openapi.json/types.d.ts.
- Tests: 16 core unit tests, 22 endpoint tests, 9 component tests, 2 Playwright E2E flows. Final whole-branch review done; bracket-sequence corruption guard added (c73bffe).

Follow-up candidates (not blocking): a11y bundle (keyboard-reachable title edit, aria-live error, error reset on navigation); IntegrityError→409 on concurrent rename race; self-referencing-block test; `_BARE_TAG`/`_HASHTAG` parity assertion.
