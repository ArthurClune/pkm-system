---
# pkm-1rb5
title: Reject normalized-empty page titles at the shared creation boundary
status: todo
type: bug
priority: high
created_at: 2026-07-31T15:54:38Z
updated_at: 2026-07-31T15:54:38Z
parent: pkm-ulae
---

From pkm-ulae high-priority finding 2.

**References:** server/src/pkm/server/store.py:18-38; server/src/pkm/server/ops_apply.py:61-79; server/src/pkm/server/routes_pages.py:197-204

get_or_create_page() normalizes control whitespace but does not reject a title that becomes "". The normal page route checks this, but create/create_page/cross-page move operations call the store directly and can commit an unreachable blank-titled page.

**Direction:** Make the shared creation boundary define normalized-empty behavior. Prefer rejecting the operation before mutation with a stable operation error; if offline replay needs a different recovery policy, specify it explicitly. NOTE: pkm-hjhy established titles must never 422 on the ops path (wedges offline queues) — reconcile with that invariant.

- [ ] Add whitespace-only title tests for create, create_page, and move operations
- [ ] Enforce the invariant in the shared creation path
