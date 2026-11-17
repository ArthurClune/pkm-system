---
# pkm-p47v
title: 'Query block: Refresh button re-runs the query and releases held rows'
status: completed
type: feature
priority: normal
created_at: 2026-11-17T10:16:57Z
updated_at: 2026-11-17T12:03:01Z
---

Cell edits in a query table no longer change what a query matches until the reader asks. A Refresh button in the query block header re-runs the query; when the new records land, rows held by an edit are released, so rows edited out of the query go and the sort applies again. Edits never refetch.

- [x] Spec and plan
- [x] Reducer: refresh releases held rows when the refreshed load lands
- [x] QueryResults: Refresh button in the header
- [x] Property suite covers the new transition
- [x] e2e spec
- [x] Docs (frontend.md / Help)
- [x] Verify gates

## Summary of Changes

A Refresh button in a query block's header (beside Blocks/Table/Cards, always shown, so it also retries after an error) re-runs the query. A cell edit never refetches; rows a cell edit holds in place stay until a view change or until a Refresh's records land, which releases them (rows edited out of the query go, sort and filter apply again; unsaved filter, sort and columns survive).

- The table view machine gains a `release` step; the query block reducer remembers the load a Refresh was clicked on and releases on records for any other load. A failed refresh keeps holding until the next load. A cell edit that freezes rows after the click cancels the pending refresh, since the refreshed records predate it.
- Refresh fetches only once the block's cell writes are delivered (capped at `REFRESH_WAIT_MS`), so a draft the click commits shows its new value instead of snapping back.
- Query view and table view properties draw Refresh, with reach labels, floors and teeth mutants; e2e in `web/e2e/query-table.spec.ts`.
- Rules: docs/architecture/contracts/frontend-editor.md § The table view, and docs/architecture/frontend-editor.md (query table view).
