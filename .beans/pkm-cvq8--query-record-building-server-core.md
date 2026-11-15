---
# pkm-cvq8
title: Query record building (server core)
status: completed
type: task
priority: normal
created_at: 2026-11-15T16:08:09Z
updated_at: 2026-11-15T17:47:16Z
parent: pkm-l79g
---

Task 5 of docs/superpowers/plans/2026-11-15-tables-and-queries.md.

## Summary of Changes

- New Functional Core `server/src/pkm/server/query_records.py`: `ResultBlock`, `AttrBlock`, `HolderInfo`, `RecordsResult`, `record_key` (top-level `Key::` result -> its page, nested one -> its parent line, any other block -> itself) and `build_records` (one record per key in first-result order; a page's or line's `::` lines become cells keyed by attribute page, first line wins and later ones become `extra_uids`; `last_attr_order_idx` is the max `::` order_idx; `insert_parent_uid` is the line uid or None for a page; keys ranked by record count, ties by first appearance).
- Models `RecordCell`, `QueryRecordModel`, `KeyStat` in `contracts/responses.py`. `RecordCell` leaves `extra_uids` and `child_count` out of the JSON when empty, as `BacklinkItem.ancestors` does.
- The row title field is `row_title`, not `title`: the brand rules require a field named `title` to carry a title brand, and a line record's title is block text.
- Tests: `server/tests/test_query_records.py`.
