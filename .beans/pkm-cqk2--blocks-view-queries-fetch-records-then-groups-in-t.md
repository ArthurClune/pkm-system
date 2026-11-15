---
# pkm-cqk2
title: Blocks-view queries fetch records then groups in turn
status: todo
type: task
created_at: 2026-11-15T22:02:02Z
updated_at: 2026-11-15T22:02:02Z
parent: pkm-l79g
---

QueryResults loads /api/query/records first, because records decide the default view, and /api/query only after, so a query with no :: lines (TODO queries) shows its results one round trip later than before and downloads them twice. When options.view is blocks the two could start together; otherwise consider starting groups in parallel and discarding them if the table view wins.
