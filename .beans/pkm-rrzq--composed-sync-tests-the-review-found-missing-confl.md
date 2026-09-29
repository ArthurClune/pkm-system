---
# pkm-rrzq
title: 'Composed sync tests the review found missing: conflict/skip e2e, browser-restart e2e, WS skipped echo, shared placement cases'
status: todo
type: task
priority: normal
created_at: 2026-09-29T13:20:45Z
updated_at: 2026-09-29T13:20:45Z
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

- [ ] E2E: a conflict landing and a skipped op reach the daily note; cleanup
- [ ] E2E: edit offline, close and relaunch the browser context, reconnect, the edit is delivered
- [ ] WS-level test: skipped ops are absent from the echo
- [ ] Placement-state cases in `missing_targets.json`, pinned on both sides
- [ ] verify, merge
