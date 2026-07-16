---
# pkm-57n9
title: 'E2E: offline-shell reloads race the local replica enqueue of the last flush'
status: completed
type: bug
created_at: 2026-07-16T19:26:19Z
updated_at: 2026-07-16T19:26:19Z
---

Both offline-shell.spec.ts tests edit online, then setOffline + reload and assert the content survived from the replica. Nothing waits for the flushed op to become durable (replica.enqueue) before the reload; the intervening render assertions are UI-only and only incidentally take long enough — same class of latent flake as pkm-h7jb, smaller window. Fix: waitForServerText (e2e/server-state.ts) before going offline; server delivery strictly implies the durable local enqueue landed, because drain() only POSTs rows it reads back out of the replica (opQueue.ts nextBatch).

## Checklist

- [x] waitForServerText before the offline reload in the SW-shell test (exact block text incl. asset url)
- [x] waitForServerText before the offline reload in the mermaid test (exact multi-line block text)
- [x] `pnpm verify` green (typecheck, lint, fcis, unit coverage, build, 9/9 e2e)

## Summary of Changes

Both offline-shell.spec.ts tests now call waitForServerText (shared helper
from pkm-h7jb, e2e/server-state.ts) on the exact flushed block text just
before context.setOffline(true) + reload. Server delivery strictly implies
the durable local replica enqueue landed (drain() only POSTs rows read back
via replica.nextBatch), so the offline reload can no longer race the flush.
Also captures pageTitle from h1.page-title in each test for the helper.
