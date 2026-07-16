---
# pkm-ss9k
title: 'Offline-shell E2E flake: resyncSeq remount churn'
status: todo
type: bug
created_at: 2026-07-16T13:01:52Z
updated_at: 2026-07-16T13:01:52Z
---

The offline-shell cold-start E2E (web/e2e/offline-shell.spec.ts, 'cold start offline' test) can fail once in a full-suite run with Playwright's 'element is visible, enabled but not stable' timeout while clicking a journal block in the ONLINE phase. Observed once on 2026-07-16 during the pkm-c1cg final verification; passed 4/4 isolated re-runs and two subsequent full verifies.

The pkm-c1cg final review adjudicated it as the pre-existing resyncSeq remount churn (documented during the offline epic pkm-y8p0): after earlier specs leave journal content and sync churn behind, a resyncSeq bump remounts the tree while Playwright's stability check is looping. The Task 10 reviewer ruled out the epic's suppression conversions as the cause.

- [ ] Reproduce under full-suite conditions (run e2e specs in sequence against a dirty server db).
- [ ] Fix the underlying remount churn (avoid full-tree remount on resyncSeq bump, or make the journal block identity stable across bumps) OR make the test robust to a single remount if churn is by design.
- [ ] Full pnpm verify green x3 consecutive runs.
