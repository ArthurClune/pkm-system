---
# pkm-dn1z
title: Query table shows 'write failed' for a write the queue still delivers
status: todo
type: bug
created_at: 2026-11-15T21:05:01Z
updated_at: 2026-11-15T21:05:01Z
parent: pkm-l79g
---

A query-table cell write patches the record at enqueue and reverts it on `settled: failed`. But `failed` does not mean dropped: on a replica error that does not reject the op, the queue keeps the ops and still delivers them to the server. The cell then shows the old value with a write-failed notice while the server takes the write, until the next refetch. Revert only on outcomes that mean the op was dropped.
