---
# pkm-nqfh
title: Query results carry their ancestors
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T16:20:57Z
parent: pkm-l79g
---

Task 1 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.

## Summary of Changes

/api/query items carry their ancestors: `fetch_ancestors` moved to `server/ancestors_db.py`; `QueryItem.ancestors` and `QueryGroup.ancestor_texts`/`ancestor_uids` are omitted when empty; `group_query_results` builds them. QueryPayload is now its own model (not a GroupsPayload subclass), so `render_groups` accepts either. backend.md row and generated web types updated.
