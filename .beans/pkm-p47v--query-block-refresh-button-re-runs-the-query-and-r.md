---
# pkm-p47v
title: 'Query block: Refresh button re-runs the query and releases held rows'
status: in-progress
type: feature
priority: normal
created_at: 2026-11-17T10:16:57Z
updated_at: 2026-11-17T10:54:31Z
---

Cell edits in a query table no longer change what a query matches until the reader asks. A Refresh button in the query block header re-runs the query; when the new records land, rows held by an edit are released, so rows edited out of the query go and the sort applies again. Edits never refetch.

- [x] Spec and plan
- [x] Reducer: refresh releases held rows when the refreshed load lands
- [x] QueryResults: Refresh button in the header
- [x] Property suite covers the new transition
- [ ] e2e spec
- [ ] Docs (frontend.md / Help)
- [ ] Verify gates
