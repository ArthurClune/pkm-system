---
# pkm-5nrm
title: Generate TypeScript types for read responses from Pydantic response models
status: in-progress
type: task
priority: normal
created_at: 2026-07-10T10:57:16Z
updated_at: 2026-07-10T11:44:59Z
parent: pkm-m309
---

Review finding 5 (Important design gap). OpenAPI generation covers operation request models, but the main read payloads are hand-copied into web/src/api/payloads.ts (1-111). Backend routes return bare dicts (server/src/pkm/server/routes_pages.py:88-175, routes_search.py:17-87), so FastAPI emits no response schema, and apiFetch<T>() (web/src/api/client.ts:25-35) asserts T without validation. A backend rename can pass the OpenAPI drift test (server/tests/test_openapi_sync.py), strict TS compilation, and frontend tests built from the same stale interfaces.

## Checklist
- [x] Define Pydantic response models for page, journal, search, query, sidebar, and asset responses
- [x] Declare them as FastAPI response_model on the routes
- [x] Generate TS definitions from them; delete/reduce handwritten interfaces in payloads.ts
- [x] Consider runtime validation at trust boundaries where malformed responses would be hard to diagnose (considered; out of scope per team-lead decision — compile-time generated types + drift test are the agreed scope)
- [x] Extend the OpenAPI drift test to cover response models
