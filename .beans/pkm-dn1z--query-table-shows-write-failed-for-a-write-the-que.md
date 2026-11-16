---
# pkm-dn1z
title: Query table shows 'write failed' for a write the queue still delivers
status: todo
type: bug
priority: normal
created_at: 2026-11-15T21:05:01Z
updated_at: 2026-11-16T10:41:05Z
parent: pkm-l79g
---

A query-table cell write patches the record at enqueue and reverts it on `settled: failed`. But `failed` does not mean dropped: on a replica error that does not reject the op, the queue keeps the ops and still delivers them to the server. The cell then shows the old value with a write-failed notice while the server takes the write, until the next refetch. Revert only on outcomes that mean the op was dropped.



Checked 2026-11-16: still true. useCellWrites.send reverts on ticket.settled failed; opQueue.enqueue resolves settled failed and then retains the ops in its lane for any replica error without rejected === true. ticket.delivered failed is the outcome that means dropped.


## Summary of Changes

Symptom: a query-table cell showed its old value with "The write to <page> failed: ..." while the server still took the write. Cause: `useCellWrites.send` reverted on `ticket.settled` failed, but the op queue retains and delivers any op the replica did not reject. It now reverts on `ticket.delivered` failed (server or replica rejection, text limit, disposal). The rule is in docs/architecture/frontend-editor.md § Tables ("A dropped write" row), and `WriteTicket.settled`'s doc comment says a failure there is not a drop.
