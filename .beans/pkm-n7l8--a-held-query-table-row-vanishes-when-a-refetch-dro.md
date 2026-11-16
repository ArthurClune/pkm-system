---
# pkm-n7l8
title: A held query-table row vanishes when a refetch drops its record
status: completed
type: bug
priority: normal
created_at: 2026-11-15T22:02:02Z
updated_at: 2026-11-16T13:17:45Z
parent: pkm-l79g
---

After a cell edit, query-table rows freeze by id (viewRows.ts) until the filter, sort or view changes. A resync refetch replaces the records, so a row whose edit made it stop matching the query itself disappears, and an open draft in it is committed (DataTable's row-gone path). Breaks the spec anti-goal "a row never jumps out from under the cursor after an edit". Fix: keep the last record for a frozen id the refetch no longer returns and show it stale. Also: RecordCell.child_count is generated required but omitted on the wire when 0; make the TS type agree.

## Summary of Changes

- Symptom: in a query table, after a cell edit made a row stop matching the query (e.g. `Status:: reading` with a row changed to done), a reconnect or resync made the row vanish, and a draft open in it was written.
- Cause: `viewRows` built frozen rows from the refetched records only, so a frozen id the server no longer returned dropped out, and DataTable's "open cell stops rendering" effect committed its draft.
- Fix: `holdRecords` (tables/queryView.ts) keeps the last record of each frozen id a refetch drops; `viewRows` shows it, always marked stale ("no longer matches"). The fresh record wins whenever a refetch returns the id again; held records go when the freeze ends (filter, sort, view, columns or Reset). A held row stays writable: its write plans against the held cells' text hashes, so a change made since lands as a conflict, and a failed write shows the usual failure notice.
- `RecordCell.child_count` is now `Field(default_factory=int)`, so the generated TypeScript makes it optional, as the JSON is when it is 0. `_omit_empty` refuses any omitted field without a `default_factory`, naming the fix.


## Summary of Changes

Symptom: after editing a query-table cell so its row stopped matching (e.g. Status:: reading -> done under a `Status:: reading` query), a reconnect made the row vanish, and a draft open in it was saved on its own. Cause: `viewRows` built frozen rows only from the records the refetch returned. Fix: `holdRecords` (`web/src/tables/queryView.ts`) keeps the last record of each frozen id a refetch drops, shown stale and still writable, until the view changes; a record the server returns again replaces it. A write to a held row whose page was deleted lands where the server puts any orphaned edit; nothing is lost. Rule: docs/architecture/frontend-editor.md § The table view.

Also: `RecordCell.child_count` was required in the generated TypeScript but omitted on the wire when 0. Models that leave empty fields out now derive from `OmitEmptyModel` (`server/src/pkm/contracts/responses.py`), which refuses at import a named field without a `default_factory`, so the generated type is optional wherever the JSON can omit it.
