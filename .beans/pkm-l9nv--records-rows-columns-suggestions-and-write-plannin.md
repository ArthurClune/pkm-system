---
# pkm-l9nv
title: Records rows, columns, suggestions and write planning
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T18:31:07Z
parent: pkm-l79g
---

Task 9 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.


## Summary of Changes

- `web/src/tables/records.ts` (Functional Core): `defaultColumns`, `recordRow`, `suggestions`, `similarKey`, `planCellWrite` over the records payload.
- `web/src/api/payloads.ts`: short names for `QueryRecordsPayload`, `QueryRecordModel`, `RecordCell`, `KeyStat`.
- A missing cell's create uses `insert_before_order_idx` directly: the server (`ops_core` create plan, `ShiftSiblings`) and the replica (`localOps`) shift siblings at `>= order_idx` before inserting, so the new `Key::` line lands before that sibling, never on top of it.
- `similarKey` rule: case-insensitive, whitespace-folded; a shared prefix of 4+ or Levenshtein <= 2 with both 4+ long; closest by distance, then longest prefix.
