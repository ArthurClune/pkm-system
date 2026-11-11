---
# pkm-60ry
title: Pin the web worker's fill set to the replay-hash exclusions
status: todo
type: task
created_at: 2026-11-11T02:11:40Z
updated_at: 2026-11-11T02:11:40Z
parent: pkm-4gda
---

shared/fixtures/op_hashes.json pins the batch hashes on both sides. The web worker fills some op fields before hashing; nothing ties the set of fields it fills to the set the server's replay hash excludes. Add a shared fixture or parity test so one side cannot change its set alone.
