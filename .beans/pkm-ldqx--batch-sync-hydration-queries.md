---
# pkm-ldqx
title: Batch sync hydration queries
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 12).

## Context

**References:** `server/src/pkm/server/routes_sync.py:36-71,93-104,124-135`

Changed blocks are hydrated with one block query and one refs query per UID; pages/sidebar entries are also fetched individually. A legal 5,000-entity window can execute over 10,000 SQL statements, and snapshots have no block limit while holding a read transaction.

**Direction:** Fetch blocks, refs, pages, and sidebar rows in chunked set queries under SQLite's parameter limit and group them in memory.

## Tasks

- [ ] Add distinct-UID query-count or benchmark coverage
- [ ] Replace N+1 hydration with bounded set queries
