---
# pkm-60bf
title: Make generated OpenAPI types enforce the API boundary
status: todo
type: task
created_at: 2026-08-01T13:21:07Z
updated_at: 2026-08-01T13:21:07Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 11.

**References:** web/src/api/client.ts:69-108; web/src/replica/localApi/router.ts:24-27; web/src/replica/localApi/tree.ts:24-35; web/src/replica/localApi/pages.ts:91-116; web/src/replica/localApi/search.ts:9-24; web/src/components/PageTitle.tsx:14-17; web/src/api/types.d.ts:1590-1605

Callers choose apiFetch<T> independently of the URL and method, while offline gateway bodies are unknown cast to T. TypeScript cannot detect online/offline response drift, an obsolete caller type, or an incorrect request body/method. Several local and component models duplicate generated server shapes.

**Direction:** Build a path/method-aware client from generated OpenAPI paths. Give local response builders explicit generated return types, add a concrete rename response model server-side, regenerate the schema, and remove handwritten duplicates.

- [ ] Design a path/method-aware API client without weakening local gateway support
- [ ] Type local API response builders with generated models
- [ ] Replace handwritten duplicate response types
