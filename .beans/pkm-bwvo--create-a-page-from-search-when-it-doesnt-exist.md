---
# pkm-bwvo
title: Create a page from search when it doesn't exist
status: completed
type: feature
priority: normal
created_at: 2026-07-10T16:36:45Z
updated_at: 2026-07-10T17:42:26Z
---

When searching for a page that doesn't exist, offer a 'Create page "<query>"' action so the page can be created directly from the search UI.

- [x] Search results show a create option when no exact title match exists
- [x] Selecting it creates the page and navigates to it
- [x] Works from the Cmd-U search entry point
- [x] Tests

## Summary of Changes

**Server** (`server/src/pkm/server/routes_pages.py`):
- Added `POST /api/pages` accepting `{"title": "..."}` (new `CreatePageRequest`
  model, `Field(min_length=1)` + a manual `.strip()` check, matching
  `routes_sidebar.py`'s `AddSidebarEntryRequest` convention). Rejects a
  blank/whitespace-only title with 422.
- Delegates to the existing `get_or_create_page(db, title, now_ms)` + commit,
  so creating an existing page is idempotent (returns the existing row, not
  an error/duplicate).
- Declared `response_model=PageMeta` (reused from `response_models.py` —
  already exactly `{id, title, created_at, updated_at}`, no new model needed).
- Regenerated `web/src/api/openapi.json` via
  `uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`,
  then `pnpm gen-types` (`openapi-typescript`) to regenerate
  `web/src/api/types.d.ts`. Both committed; `test_openapi_sync.py` passes.
- Tests added to `server/tests/test_page_endpoint.py`: creates a new page,
  idempotent on an existing (seeded) page, rejects blank/whitespace title
  (422), requires auth (401).

**Web** (`web/src/components/SearchModal.tsx`):
- Appends a final `Create page "<query>"` row when the trimmed query is
  non-empty, no `PAGE` hit (not block hit) matches it case-insensitively, and
  — this is the key behaviour decision — the *current* query's search results
  have actually settled. A new `resultsQuery` state (separate from `rows`)
  records which query the currently-displayed `rows` belong to; the create
  row only renders when `resultsQuery === trimmedQuery`. This means it never
  flashes on for a newer query whose fetch hasn't resolved yet (verified by a
  dedicated test using controllable fetch promises, mirroring the existing
  stale-response test's pattern) — it simply doesn't render until we know
  for certain there's no exact match for the query on screen right now.
- The row participates in arrow-key navigation, Enter, and click identically
  to page/block rows (`displayRows` = `rows` + optional create row, used
  everywhere `rows` was used for selection bounds/lookup).
- Picking it calls `apiFetch("/api/pages", {method: "POST", ...})` with the
  trimmed query as `title`; on success it closes the modal and navigates via
  `pagePath(title)` exactly like a normal hit. On a failed POST (caught
  `ApiError`/network failure) it does nothing further — modal stays open, no
  navigation — so the user can retry.
- Tests added to `web/src/components/SearchModal.test.tsx`: create row shown
  on no exact match, shown with zero results at all, hidden on an exact
  case-insensitive title match, hidden while a newer query's fetch is still
  in flight (no flash), successful create+navigate, and failed create leaves
  the modal open without navigating.

No changes were needed to wire up the Cmd/Ctrl-U entry point — it already
renders this same `SearchModal`.
