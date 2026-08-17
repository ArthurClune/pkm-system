---
# pkm-t3qw
title: Centralize reference reindexing invariants across server and replica
status: todo
type: task
priority: high
tags:
    - review
    - architecture
created_at: 2026-08-17T20:55:21Z
updated_at: 2026-08-17T20:55:21Z
parent: pkm-wvvu
---

## Review findings

Backend A2 and frontend A5. The invariant that refs and block refs are rebuilt from block text is encoded as repeated delete, extract, and insert rituals in two Python paths and two replica paths.

## Acceptance criteria

- [ ] Add a server `store.reindex_refs_for_text(db, uid, text, now_ms)` composition and use it from operation application and snapshot rewriting
- [ ] Add a replica `reindexBlockRefs(db, uid, text)` composition and use it from both remote apply and local operation application
- [ ] Preserve blank-ref handling, page creation/index semantics, timestamps, and transaction ownership
- [ ] Add focused tests that would fail if either call site drifted from its shared implementation
- [ ] Check server/TypeScript parity explicitly and update sync/backend architecture invariants
