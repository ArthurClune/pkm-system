---
# pkm-cqk2
title: Blocks-view queries fetch records then groups in turn
status: completed
type: task
priority: normal
created_at: 2026-11-15T22:02:02Z
updated_at: 2026-11-16T13:17:45Z
parent: pkm-l79g
---

QueryResults loads /api/query/records first, because records decide the default view, and /api/query only after, so a query with no :: lines (TODO queries) shows its results one round trip later than before and downloads them twice. When options.view is blocks the two could start together; otherwise consider starting groups in parallel and discarding them if the table view wins.


Decision (Arthur, 2026-11-16): no speculative /api/query fetch, since an extra request on the common (table-defaulting) case costs most on slow connections. Instead, when no record has cells (the case where the default view is blocks), /api/query/records also returns the groups and ref_counts that /api/query would, so a blocks-defaulting query takes one request. A saved view: blocks on a query whose records do have cells starts /api/query alongside /api/query/records. Table queries are unchanged.

Note: the records payload carries `groups` but not `ref_counts`, unlike the decision recorded above. No web code reads `QueryPayload.ref_counts` (QueryResults reads only `groups` from `/api/query`), so the blocks view needs nothing more.


## Summary of Changes

Symptom: a query with no `::` lines (most TODO queries) showed its blocks one round trip late, after `/api/query/records` and then `/api/query` in turn. Fix: when no record has a cell, `GET /api/query/records` also returns `groups` (null otherwise), built from the same plan rows in the same read snapshot, and `queryDefaults` takes the default view from whether `groups` is null, so the rule lives on the server only. A saved `view: blocks` starts `/api/query` alongside the records; picking Blocks on a table query fetches it on demand. Accepted perf cost (Arthur, 2026-11-16): on the cell-less perf fixture, query/records bytes 114314 -> 212318, statements 8 -> 9, vm_steps_k 77 -> 82, in exchange for the separate `/api/query` request the client no longer makes. Rules: docs/architecture/frontend-rendering.md (QueryResults) and the backend.md API row.
