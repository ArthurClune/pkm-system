---
# pkm-ytbz
title: Remove the stale-bundle breadcrumbs placeholder from backlink items
status: todo
type: task
created_at: 2026-11-11T10:38:32Z
updated_at: 2026-11-11T10:38:32Z
parent: pkm-4gda
---

Every BacklinkItem carries a breadcrumbs field holding STALE_BUNDLE_CRUMB, kept only so a tab running a bundle built before the ancestors field would not throw. Arthur confirmed (2026-11-11) no such tab exists. Remove the field and the constant on both sides: contracts/responses.py, server/grouping.py, the replica's localApi/pages.ts, the shim parity fixture, and the paragraph in backend.md § Breadcrumbs and recursive traversal. Regenerate the OpenAPI artifacts and parity fixtures (backend.md § Generated artifacts). Check GET /api/block/{uid}, whose own breadcrumbs field is real and stays.
