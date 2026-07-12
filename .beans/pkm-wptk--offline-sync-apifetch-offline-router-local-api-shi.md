---
# pkm-wptk
title: 'Offline sync: apiFetch offline router + local API shim + status indicator'
status: todo
type: task
created_at: 2026-07-12T17:38:43Z
updated_at: 2026-07-12T17:38:43Z
parent: pkm-y8p0
blocked_by:
    - pkm-su05
---

Spec step 5 (section 4): offline routing in apiFetch to local handlers over the replica returning the same OpenAPI shapes - page (incl backlinks), unlinked, journal, titles, block-refs, page create (create_page op enqueue), sidebar read; daily auto-create locally; online-only errors for sidebar writes/page delete/query/assets upload; 'offline - N changes pending' indicator replaces the read-only banner; quota-exhausted-offline rejects edits (explicit read-only reason). Needs its own written plan.
