---
# pkm-blz2
title: 'Offline sync: offline search (FTS5 over replica)'
status: todo
type: task
created_at: 2026-07-12T17:38:43Z
updated_at: 2026-07-12T17:38:43Z
parent: pkm-y8p0
blocked_by:
    - pkm-wptk
---

Spec step 6 (section 4): /api/search served from the replica's FTS5 when offline - same query semantics, ranking and snippets as the server. Parity fixtures against the Python route where rankings are deterministic.
