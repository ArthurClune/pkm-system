---
# pkm-pmym
title: A pull during a long recovery hold can raise the stuck banner
status: todo
type: bug
priority: low
created_at: 2026-11-11T12:51:54Z
updated_at: 2026-11-11T12:51:54Z
parent: pkm-4gda
---

While a Reset or poison repair holds the worker gate, each pull pass blocks at its first replica RPC (pendingBatches) and fails at the 30 s RPC timeout. If RpcLifecycleError('timeout') counts as stall-shaped, three such passes raise 'Local sync is stuck: replica RPC pendingBatches timed out after 30000ms' about 95 s into the hold, although the recovery is progressing. Older than W11, but W11 removed the 120 s ceiling on a hold; gzip shortens holds about 8.6x, so it needs a link below roughly 150 kbit/s on the perf fixture. A successful Reset clears it (forceReadyOnSuccess). First check whether RpcLifecycleError is stall-shaped. Reproduction: replicaSync.test.ts, a fake replica whose pendingBatches rejects with RpcLifecycleError('timeout') while a resetLocalData download is held open for 150 s; collect onState and look for 'stalled'. From the W11 review (report-w11-review.md, P2).
