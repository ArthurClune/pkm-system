---
# pkm-n7l8
title: A held query-table row vanishes when a refetch drops its record
status: todo
type: bug
created_at: 2026-11-15T22:02:02Z
updated_at: 2026-11-15T22:02:02Z
parent: pkm-l79g
---

After a cell edit, query-table rows freeze by id (viewRows.ts) until the filter, sort or view changes. A resync refetch replaces the records, so a row whose edit made it stop matching the query itself disappears, and an open draft in it is committed (DataTable's row-gone path). Breaks the spec anti-goal "a row never jumps out from under the cursor after an edit". Fix: keep the last record for a frozen id the refetch no longer returns and show it stale. Also: RecordCell.child_count is generated required but omitted on the wire when 0; make the TS type agree.
