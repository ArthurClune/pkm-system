---
# pkm-hb4x
title: Conflict landing reads the clock a second time
status: completed
type: bug
priority: normal
created_at: 2026-10-03T13:47:51Z
updated_at: 2026-10-03T17:47:14Z
parent: pkm-nws9
---

Found by the sync protocol property (pkm-yxcs), serial replay invariant. post_ops reads now once before BEGIN IMMEDIATE (and stores it as applied_at), but _conflict_landing takes the day from a second clock read (date.today()). A batch that waits on the write lock across midnight lands its daily-note conflict entry on a different day from its applied_at. Seed -727035110, path 2071:437:73:20:3:7:32:57:12:30:0:10:22:26:13:18:45:23:86:20:10:14:25:22:12:14:13:19:17:27:24:19:15:15:12:18:17:17:23:24:12:22:22:12:15:10:15:9:13:12:24:17:22:11:15:9:14:14:31:13:8:17:32:10:28:27:20:42:26:17:11:8:12:18, replayPath AAWALAABFA/wA/////k:V1+B (timing-dependent, 2/3). Fix: derive every date/time the batch path uses from the batch's single now_ms.

- [x] Deterministic failing server test (now_ms before midnight, wall clock after)
- [x] One clock read per batch: derive the landing day (and any other date/time in the batch path) from now_ms
- [x] Troubleshooting row


## Summary of Changes
The conflict landing day derives from the batch's single now_ms; the batch path has one clock read. Commit b331b4e4.
