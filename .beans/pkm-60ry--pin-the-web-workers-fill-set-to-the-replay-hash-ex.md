---
# pkm-60ry
title: Pin the web worker's fill set to the replay-hash exclusions
status: completed
type: task
priority: normal
created_at: 2026-11-11T02:11:40Z
updated_at: 2026-11-11T14:17:40Z
parent: pkm-4gda
---

shared/fixtures/op_hashes.json pins the batch hashes on both sides. The web worker fills some op fields before hashing; nothing ties the set of fields it fills to the set the server's replay hash excludes. Add a shared fixture or parity test so one side cannot change its set alone.

## Summary of Changes

shared/fixtures/op_hashes.json gains a top-level replay_excluded map (kind to fields); cases untouched. The server test reads REPLAY_EXCLUDED from it (existing assertions kept). New web/src/replica/opHashesParity.test.ts enqueues each minimal fixture op through enqueueBatch and diffs the stored op's keys against the sent op, so the worker's fill set per kind must equal the fixture. Docs: write-path.md Idempotency and the backend.md fixtures row name the fixture.
