---
# pkm-5nrm
title: Generate TypeScript types for read responses from Pydantic response models
status: completed
type: task
priority: normal
created_at: 2026-07-10T10:57:16Z
updated_at: 2026-07-10T11:55:09Z
parent: pkm-m309
---

Review finding 5 (Important design gap). OpenAPI generation covers operation request models, but the main read payloads are hand-copied into web/src/api/payloads.ts (1-111). Backend routes return bare dicts (server/src/pkm/server/routes_pages.py:88-175, routes_search.py:17-87), so FastAPI emits no response schema, and apiFetch<T>() (web/src/api/client.ts:25-35) asserts T without validation. A backend rename can pass the OpenAPI drift test (server/tests/test_openapi_sync.py), strict TS compilation, and frontend tests built from the same stale interfaces.

## Checklist
- [x] Define Pydantic response models for page, journal, search, query, sidebar, and asset responses
- [x] Declare them as FastAPI response_model on the routes
- [x] Generate TS definitions from them; delete/reduce handwritten interfaces in payloads.ts
- [x] Consider runtime validation at trust boundaries where malformed responses would be hard to diagnose (considered; out of scope per team-lead decision — compile-time generated types + drift test are the agreed scope)
- [x] Extend the OpenAPI drift test to cover response models

## Summary of Changes

- New server/src/pkm/server/response_models.py (Functional Core): Pydantic models for page/journal/search/query/titles/sidebar/asset read responses, all fields required (a dropped key raises loudly rather than silently filtering), recursive BlockNode modeled.
- Declared as response_model on the 8 read routes; payloads unchanged (verified field-by-field in review against the dicts routes build).
- openapi.json + types.d.ts regenerated; payloads.ts and sync/assets.ts reduced to re-exports of generated schemas.
- test_openapi_sync.py now asserts each read route resolves to a named component and catches response-field renames.
- Verified post-merge on main: server 273 passed + pyrefly clean; web 262 passed + tsc clean. Merged to main (--no-ff).
- Deferred minor: the route→model map in the drift test is hardcoded; new read routes must be added to it.
