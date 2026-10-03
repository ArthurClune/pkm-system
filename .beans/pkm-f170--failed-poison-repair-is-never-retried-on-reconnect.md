---
# pkm-f170
title: Failed poison repair is never retried on reconnect
status: in-progress
type: bug
priority: normal
created_at: 2026-10-03T12:03:48Z
updated_at: 2026-10-03T12:13:37Z
parent: pkm-nws9
---

Found by the sync protocol property (pkm-yxcs). If a poison repair's snapshot fetch fails because the device went offline, the runtime leaves the queue paused for recovery and nothing retries on reconnect: every later edit on that device stays undelivered until the user clicks the banner's Retry or reloads. Shrunk: one client, BadBatch, BadBatch, Offline (seed -496395878, path 35:4:13:14:13:11:11:12, replayPath JAGAZAr:VB). Ruling (Arthur 2026-10-03): retry the failed repair automatically on reconnect. Fix on feat/pkm-yxcs-sync-harness with the shrunk case as a unit test.

- [x] Shrunk case as a failing unit test
- [x] Retry a failed poison repair on reconnect (path shared by SyncProvider and the harness)
- [x] Docs: sync-recovery.md, troubleshooting row
