---
# pkm-c9hp
title: 'backlink-filter.spec e2e flaky: ''Server rejected a change'' outline repair detaches editor'
status: completed
type: bug
priority: normal
created_at: 2026-07-26T21:10:51Z
updated_at: 2026-07-27T18:30:35Z
---

e2e/backlink-filter.spec.ts ('linked-refs filter: include, exclude, ancestor tags, pkm-m4an') fails intermittently (~70% standalone on 2026-07-26, at main f16c88e, unrelated to any pending change — reproduced with clean tree + fresh build). Failure mode: while typing the scenario blocks, the page shows the banner 'Server rejected a change. Active outlines repaired.', the outline resets to 'Click to start writing…', and textarea.block-input detaches forever -> 30s timeout at spec line ~48. When it passes it passes fast (1.3s). Likely the resyncSeq/op-rejection remount churn family. Needs systematic-debugging: capture the rejected op + server response in e2e_serve.py exception/request logs.

## Summary of Changes

**Root cause (captured, not guessed).** Instrumented the client op-rejection path and the server ops route. The 'Server rejected a change. Active outlines repaired.' banner is the *legacy-rejected* repair path, fired by `opQueue`'s `onDesync`. In the replica-backed queue `onDesync` fires ONLY when `replica.enqueue()` throws — and the server logged **no** 4xx (it never rejected anything). The thrown error was an OPFS SAH-pool contention inside the replica worker:

```
Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles
cannot be created if there is another open Access Handle or Writable stream ...
```

Each Playwright `page.goto` is a full document load that spawns a **new** replica worker while the previous page's worker still holds the sqlite-wasm OPFS SAH pool. The new worker cannot open its local DB, so the first edit's `enqueue` rejects. The queue mistook this local-storage failure for a server desync → legacy repair ran an authoritative read that adopted the edit-less server state → the outline was wiped to 'Click to start writing…' and `textarea.block-input` detached → 30s timeout. (A ~19s retry budget proved the prior worker's handle never releases within the test, so retry alone cannot fix it.)

**Fix.**
- `web/src/sync/opQueue.ts`: a 'cannot persist locally' enqueue failure — quota exhaustion OR OPFS SAH-pool contention — now degrades to a best-effort **direct POST to the server** (mirroring the existing quota path) instead of firing `onDesync`. The edit still lands and the active outline is never wiped. A genuine replica failure ('worker crashed') still desyncs, unchanged.
- `web/src/replica/openRetry.ts` (new, unit-tested): a short bounded retry (~1.5s) around the worker's OPFS open, so a genuine browser reload that releases the prior pool quickly keeps offline support; a persistent holder fails fast to the direct-delivery fallback.
- `web/src/replica/worker.ts`: `openDb` wrapped in `openWithRetry`.

**Tests.** New `openRetry.test.ts` (7) and a new regression test in `opQueue.replica.test.ts` asserting SAH-pool contention → direct post + no desync. e2e-only proof for the full race (worker/OPFS lifecycle is not unit-testable).

**Verification.** backlink-filter.spec.ts 16/16 green standalone fresh-server (was ~55-70% failing). Full web e2e suite 35 passed; web unit coverage green; server `pytest` 741 passed @95.71%; pyrefly/ruff/typecheck/lint/fcis all clean.
