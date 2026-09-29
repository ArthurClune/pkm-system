---
# pkm-rrzq
title: 'Composed sync tests the review found missing: conflict/skip e2e, browser-restart e2e, WS skipped echo, shared placement cases'
status: completed
type: task
priority: normal
created_at: 2026-09-29T13:20:45Z
updated_at: 2026-09-29T16:20:58Z
parent: pkm-a4t2
---

Review § Tests. Both suites are green with high coverage, and every confirmed
finding lives in a gap between the editor, the queue, the server, the feed and
recovery that no test composes. The fixes in this epic each carry their own
composed test; these belong to no single fix:

- No e2e exercises a conflict landing or a skipped op, though four beans in
  the window exist to make those paths safe.
- `offline.spec.ts` reconnects before reloading and `offline-shell.spec.ts`
  waits for delivery before its offline reload, so neither shows undelivered
  edits surviving a browser restart.
- The server excludes skipped ops from the WS echo, tested one hop short of
  the socket.
- `missing_targets.json` pins skip-or-not only; no shared fixture pins
  placement state (live-parent landing, stale hint, replay re-page,
  cross-page) across both sides.

A conflict lands on today's daily note by design, so that spec writes today's
journal in the shared e2e database: it must delete what it creates, and the
full suite runs before the report (see the e2e gotchas).

## Todo

- [x] E2E: a conflict landing and a skipped op reach the daily note; cleanup
- [x] E2E: edit offline, close and relaunch the browser context, reconnect, the edit is delivered
- [x] WS-level test: skipped ops are absent from the echo
- [x] Placement-state cases in `missing_targets.json`, pinned on both sides
- [x] verify, merge (branch verified; the merge, full e2e suite and perf gate are the orchestrator's)

## Summary of Changes

Tests only; no test exposed a bug.

- `server/tests/test_ws.py`: two socket-level tests. A mixed batch (block
  missing, parent missing, cycle, one live op) puts only the live op on the
  frame a subscriber receives; an all-skipped batch puts no op on the socket.
- `shared/fixtures/missing_targets.json`: `placement_state` plus six
  `placement_cases` (live-parent landing, stale hint on create and on move,
  cross-page move re-paging the subtree, a replayed create over a parent a
  window re-paged, a replayed create a later move took elsewhere).
  `replica_only` rows are the replica's own earlier apply. Pinned by
  `test_ops_core.py::test_placement_matches_shared_fixture` (real
  `apply_batch` on a fresh file) and `missingTarget.test.ts` (real
  `applyLocalOps`, `reapply` for replays).
- `web/e2e/conflict-landing.spec.ts`: the browser's batch is held in a route
  while another client edits (conflict) or deletes (orphan edit) the block;
  asserts the ack, the server page, the `[[conflict]]` header and child on
  today's note, and the Daily Notes view. Cleanup deletes only the entries
  naming its stamped page, the page, and `conflict` if it created it, then
  checks today's top-level blocks equal what it found.
- `web/e2e/offline-restart.spec.ts`: a persistent Chromium profile; edit
  offline, wait for a durable (not memory-only) pending row, close the
  browser, relaunch offline (edit served from the replica), reconnect, edit
  delivered.
- Docs: the fixture row in `backend.md`, and the fixture sentences in
  `sync-and-offline.md` and `sync-recovery.md`, now name the placement cases;
  the `missingTarget.ts` header comment likewise.
