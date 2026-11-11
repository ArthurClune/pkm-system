---
# pkm-ytbz
title: Remove the stale-bundle breadcrumbs placeholder from backlink items
status: completed
type: task
priority: normal
created_at: 2026-11-11T10:38:32Z
updated_at: 2026-11-11T13:46:29Z
parent: pkm-4gda
---

Every BacklinkItem carries a breadcrumbs field holding STALE_BUNDLE_CRUMB, kept only so a tab running a bundle built before the ancestors field would not throw. Arthur confirmed (2026-11-11) no such tab exists. Remove the field and the constant on both sides: contracts/responses.py, server/grouping.py, the replica's localApi/pages.ts, the shim parity fixture, and the paragraph in backend.md § Breadcrumbs and recursive traversal. Regenerate the OpenAPI artifacts and parity fixtures (backend.md § Generated artifacts). Check GET /api/block/{uid}, whose own breadcrumbs field is real and stays.

## Checklist
- [x] Red tests: backlink items carry no `breadcrumbs` key
- [x] Remove field and STALE_BUNDLE_CRUMB on server and replica
- [x] Regenerate openapi, types, shim parity fixture
- [x] Drop the backend.md paragraph and the deploy README symptom

## Summary of Changes
`BacklinkItem` no longer has `breadcrumbs`, and `STALE_BUNDLE_CRUMB` is gone from `contracts/responses.py`, `server/grouping.py` and `replica/localApi/pages.ts`. Regenerated openapi.json, types.d.ts and shim_parity.json; the diff only removes the backlink-item field (the block payload's own `breadcrumbs` stays). Removed the backend.md paragraph and the deploy README `…` breadcrumbs symptom.
