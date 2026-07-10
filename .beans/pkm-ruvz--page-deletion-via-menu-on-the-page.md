---
# pkm-ruvz
title: Page deletion via menu on the page
status: completed
type: feature
priority: normal
created_at: 2026-07-10T16:36:47Z
updated_at: 2026-07-10T17:50:49Z
blocked_by:
    - pkm-j92y
---

Add a Delete action for pages, living in the page menu on the new top menu bar (pkm-j92y).

- [x] Delete action in the top-bar page menu, with confirmation
- [x] Server endpoint / op for page deletion (handle blocks and references to the deleted page)
- [x] Navigate somewhere sensible after deletion (e.g. home/daily note)
- [x] Tests

## Summary of Changes

- Added `DELETE /api/page/{title:path}` in `server/src/pkm/server/routes_pages.py`:
  404s if the page doesn't exist; deletes `blocks` for the page explicitly
  first (so the `blocks_fts_ad` trigger fires per-row rather than relying on
  FK-cascade deletes to fire it), then the `pages` row (fires `pages_fts_ad`;
  inbound `refs` targeting the page go via `target_page_id` CASCADE), then
  any `sidebar_entries` row for the title, then commits. Returns
  `{"ok": true}`. Inbound `[[links]]` in other pages' block text are left
  as-is by design -- only the `refs` rows disappear.
- Added a second "Delete page…" menuitem to the "…" page menu in
  `web/src/components/TopBar.tsx`: `window.confirm`-gated, sends the DELETE
  via `apiFetch` (reusing `encodeTitle` from `paths.ts`), closes the menu,
  and navigates to `/` on success; on a failed request the menu still closes
  but there's no navigation.
- Regenerated `web/src/api/openapi.json` and `web/src/api/types.d.ts`.
- Tests: `server/tests/test_page_endpoint.py` (page+blocks gone, FTS no
  longer surfaces the deleted page/blocks while an unrelated page's
  plain-text mention is untouched, inbound `refs` row removed while the
  linking block's text is untouched, sidebar entry removed, 404 for a
  missing page, 401 without auth) and `web/src/components/TopBar.test.tsx`
  (cancel makes no request; confirm sends the DELETE and navigates to `/`;
  a failed DELETE closes the menu without navigating).
