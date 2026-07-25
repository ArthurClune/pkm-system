---
# pkm-uvqf
title: markdown export UI
status: completed
type: feature
priority: normal
created_at: 2026-07-22T09:31:04Z
updated_at: 2026-07-25T07:48:37Z
---

The backend has a markdown export (see docs/architecture/backend.md) but it's not exposed in the UI at all. We need a page-level 'export as markdown' option and also a 'export whole db as markdown' option

## Design

- `GET /api/export/page/{title}` renders one page's tree to markdown
  (reusing `export.markdown.render_page`, one-level `((ref))` resolution
  scoped to that page) with `Content-Type: text/markdown` and
  `Content-Disposition: attachment`. Note the path: NOT nested under
  `/api/page/{title:path}/...` — that prefix is already claimed by
  `routes_pages.get_page`'s greedy `{title:path}` route, registered
  earlier in the app, which would swallow anything under `/api/page/`
  as a page title before a more specific suffixed route ever got a look.
- `GET /api/export.zip` builds the full `export_graph()` output (pages +
  journal + assets) into a temp dir and streams it back zipped, with
  `Content-Disposition: attachment`.
- UI: page-level action added to the existing "…" page menu in
  `TopBar.tsx` (same place as "Delete page…"), as a plain download link
  ("Export as Markdown"). Whole-db export placed on the Help page (chosen
  over the top bar: it's a global, infrequent action, and Help already
  hosts static reference content — least invasive spot).
- Downloads trigger via plain `<a href download>` navigation (cookies
  carry auth), matching the existing `PdfFallbackLink` pattern — no
  fetch+blob.

## Checklist

- [x] Explore export core (markdown.py/writer.py), routes conventions, web menu conventions
- [x] Server: failing test for page export route, then implement `GET /api/export/page/{title}`
- [x] Server: failing test for whole-db export route, then implement `GET /api/export.zip`
- [x] Add both routes to `EXEMPT_READ_ROUTES` in test_openapi_sync.py (binary, non-JSON)
- [x] Regenerate `web/src/api/openapi.json` + `pnpm gen-types` (types.d.ts), commit
- [x] Web: failing test for TopBar "Export as Markdown" menu item, then implement
- [x] Web: failing test for Help page whole-db export link, then implement
- [x] Run server pytest + pyrefly + ruff — all green
- [x] Run web pnpm verify (typecheck, coverage, Playwright) on E2E_PORT=8976 — all green
- [x] Update bean: checklist complete, Summary of Changes, status completed

## Summary of Changes

**Server**
- `server/src/pkm/server/routes_export.py` (new): two GET routes reusing
  the existing Core export functions (no changes needed to
  `export/markdown.py` / `export/writer.py`).
  - `GET /api/export/page/{title}` — one page → markdown download
    (`text/markdown`, `Content-Disposition: attachment`). Builds a
    one-level uid→text map for `((ref))` resolution scoped to that page,
    same semantics as the nightly `export_graph()`.
  - `GET /api/export.zip` — whole graph → `export_graph()` into a temp
    dir, zipped in-memory, `application/zip` attachment.
  - Both are exempt from the response-model/JSON-payload rule (binary
    downloads), added to `EXEMPT_READ_ROUTES` in
    `server/tests/test_openapi_sync.py`.
- `server/src/pkm/server/app.py`: registers the new router.
- `server/tests/test_export_routes.py` (new): 6 tests — page render
  shape, one-level ref resolution, 404, auth, zip contents (pages +
  journal + `.gitignore`), auth on the zip route.
- `web/src/api/openapi.json` + `web/src/api/types.d.ts`: regenerated
  (`uv run python -m pkm.server.openapi_dump` → `pnpm gen-types`).
- `docs/architecture/backend.md`: added `routes_export.py` to the module
  map, both new endpoints to the HTTP API reference table, and a note in
  "Export and backup" describing the HTTP surface and UI placement.

**Web**
- `web/src/components/TopBar.tsx`: added an "Export as Markdown" download
  link to the existing "…" page menu (same list as "Open in sidebar" /
  "Delete page…"), a plain `<a href download>` to
  `/api/export/page/{encodeTitle(title)}`.
- `web/src/views/Help.tsx`: added an "Export" section with a whole-database
  export download link (`<a href="/api/export.zip" download>`).
- `web/src/styles.css`: extended `.top-bar-menu` button styling to also
  cover `a` elements so the new download link matches existing menu items.
- `web/src/components/TopBar.test.tsx` / `web/src/views/Help.test.tsx`:
  new unit tests for both link's presence, href, and `download` attribute
  (plus namespaced-title slash-encoding for the page link).

**Verification**
- `cd server && uv run pytest -q` — 618 passed, 95.34% coverage.
- `cd server && uv run pyrefly check` — 0 errors.
- `cd server && uv run ruff check` — all checks passed.
- `cd web && E2E_PORT=8976 pnpm verify` — clean pass (1436 unit tests,
  33 Playwright e2e). Two flaky pre-existing/unrelated tests
  (`tooling/lintConfig.test.ts`, `e2e/edit.spec.ts` pkm-xlah,
  `e2e/backlink-filter.spec.ts`) were seen to fail-then-pass across
  repeated runs under this machine's parallel-session load — none touch
  export/TopBar/Help code, consistent with known flakes noted elsewhere
  in the project (see MEMORY.md).

Not merged to main; not deployed, per instructions.
