---
# pkm-cqk2
title: Blocks-view queries fetch records then groups in turn
status: todo
type: task
priority: normal
created_at: 2026-11-15T22:02:02Z
updated_at: 2026-11-16T12:26:19Z
parent: pkm-l79g
---

QueryResults loads /api/query/records first, because records decide the default view, and /api/query only after, so a query with no :: lines (TODO queries) shows its results one round trip later than before and downloads them twice. When options.view is blocks the two could start together; otherwise consider starting groups in parallel and discarding them if the table view wins.


Decision (Arthur, 2026-11-16): no speculative /api/query fetch, since an extra request on the common (table-defaulting) case costs most on slow connections. Instead, when no record has cells (the case where the default view is blocks), /api/query/records also returns the groups and ref_counts that /api/query would, so a blocks-defaulting query takes one request. A saved view: blocks on a query whose records do have cells starts /api/query alongside /api/query/records. Table queries are unchanged.

Note: the records payload carries `groups` but not `ref_counts`, unlike the decision recorded above. No web code reads `QueryPayload.ref_counts` (QueryResults reads only `groups` from `/api/query`), so the blocks view needs nothing more.
