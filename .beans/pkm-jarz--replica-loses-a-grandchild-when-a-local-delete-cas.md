---
# pkm-jarz
title: Replica loses a grandchild when a local delete cascades past a child moved out elsewhere
status: completed
type: bug
priority: high
created_at: 2026-10-05T11:37:49Z
updated_at: 2026-10-05T14:37:52Z
parent: pkm-nws9
---

Found by the sync property (seed -133991234) on feat/pkm-f7zv-outline-props; reproduces 3/3 on main 9199cdfd.

P > K > G. Another device moves K out of P before this replica's delete of P reaches the server. The server deletes P alone. The replica's optimistic delete (web/src/replica/localOps.ts ~264-270) cascaded K and G locally. The feed re-ships K's row (its move) and P's tombstone, but G's row never changes (a same-page move journals only the moved row, server ops_core.py ~777 SetParent), so G stays lost on that replica until a snapshot. The effect ledger records only shifts and re-pages, so nothing restores the cascade. A third path to the symptom pkm-pp7q and pkm-d3qh fixed for the feed's own tombstone cascade.

Candidate fix (from the diagnosis): record a local delete's cascaded descendants (full rows) in the effect ledger; dropWindowRecords already drops a record when a window ships the uid live or tombstoned; settleBatches at the head window re-inserts the records still standing, parents first. Server-side journalling of survivors is possible defence in depth but a wire change.

Deterministic 2-client offline scenario (fails 3/3 on main; copy into sync.prop.ts as a fixed scenario when fixing):

```ts

// S1, deterministic. Pool: #0 = pt_seed_1 (page Proptest), #5 = pt_sec_1,
// #7 = pt_sec_3 (page Second). A nests sec_1 > sec_3 > seed_1, both batches
// acked and their echo pulled. Offline, A deletes sec_1: the local cascade
// takes sec_3 and seed_1. C meanwhile moves sec_3 to the top level of
// Second, so the server's later delete removes sec_1 alone. The feed ships
// sec_3 (C's move) and sec_1's tombstone; seed_1's row never changes again,
// so nothing re-ships it and A never gets it back.
test("S1: offline delete of a parent whose child another device moved out", async () => {
  await runExample(["A", "C"], [
    new Edit("A", [draft({ kind: "move", target: 0, parent: 7 })]),
    new Edit("A", [draft({ kind: "move", target: 7, parent: 5 })]),
    new Drained("A"), new Pull("A"), new Pull("C"),
    new Offline("A"),
    new Edit("A", [draft({ kind: "delete", target: 5 })]),
    new Edit("C", [draft({ kind: "move", target: 7 })]),
    new Drained("C"),
  ]);
});

// Control: A's cursor still behind A-1's echo when it goes offline. The
// later window re-ships seed_1's row from A-1's own move, so it converges.
test("S1 control: echo not yet pulled", async () => {
  await runExample(["A", "C"], [
    new Edit("A", [draft({ kind: "move", target: 0, parent: 7 })]),
    new Edit("A", [draft({ kind: "move", target: 7, parent: 5 })]),
    new Drained("A"), new Pull("C"),
    new Offline("A"),
    new Edit("A", [draft({ kind: "delete", target: 5 })]),
    new Edit("C", [draft({ kind: "move", target: 7 })]),
    new Drained("C"),
  ]);
});

// Variant without nesting moves: the seeded tree already has the shape.
// sec_3 moved under sec_1 by C first, then A pulls, so the replica's view is
// server-made, not A's own batches.
test("S1 variant: the nesting came from the other device", async () => {
  await runExample(["A", "C"], [
    new Edit("C", [draft({ kind: "move", target: 0, parent: 7 })]),
    new Edit("C", [draft({ kind: "move", target: 7, parent: 5 })]),
    new Drained("C"), new Pull("A"), new Pull("C"),
    new Offline("A"),
    new Edit("A", [draft({ kind: "delete", target: 5 })]),
    new Edit("C", [draft({ kind: "move", target: 7 })]),
    new Drained("C"),
  ]);
});
```

## Summary of Changes

A local delete now records each cascaded descendant in `effect_ledger` as a row record (new `row_json` column, base row plus base page; it absorbs the uid's other records). A window that ships or tombstones the uid drops it. `settleBatches` restores the records still standing after the reverts, parents first, under the parent's page, with refs derived against pages present; a record whose parent is absent is dropped. The enqueue guard adds the column to an old file. Page lookup helpers moved to `replica/pageLookup.ts`. Sync property scenarios S1 to S3 pin the case. Docs: sync-recovery.md, sync-and-offline.md, frontend.md, one troubleshooting row.
