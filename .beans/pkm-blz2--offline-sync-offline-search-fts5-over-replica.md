---
# pkm-blz2
title: 'Offline sync: offline search (FTS5 over replica)'
status: completed
type: task
priority: normal
created_at: 2026-07-12T17:38:43Z
updated_at: 2026-07-13T20:33:32Z
parent: pkm-y8p0
blocked_by:
    - pkm-wptk
---

Spec step 6 (section 4): /api/search served from the replica's FTS5 when offline - same query semantics, ranking and snippets as the server. Parity fixtures against the Python route where rankings are deterministic.

## Summary of Changes

Offline search shipped inside the wptk shim work: `web/src/replica/localApi/search.ts` ports routes_search's FTS queries (page-title + block-snippet ranking, query escaping via fts.ts port of server fts.py); routed offline through the gateway's /api/search handler. Parity pinned by 4 search cases in shared/fixtures/shim_parity.json (byte-identical against the server dump, regenerated via `uv run python -m pkm.server.shim_parity_dump`).

This commit adds the e2e offline-search step (web/e2e/offline.spec.ts): while disconnected, SearchBar returns a block hit for text typed during the SAME offline session (FTS triggers index optimistic edits) and a page hit for the offline-created page.
