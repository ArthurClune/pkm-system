---
# pkm-kyle
title: '@playwright/test 1.61 to 1.65'
status: completed
type: task
priority: normal
created_at: 2026-11-17T22:05:50Z
updated_at: 2026-11-17T23:00:00Z
parent: pkm-tcca
---

Part of pkm-tcca. @playwright/test is pinned exactly (1.61.1) because each release needs its own cached browser build.

- [x] Bump the pin and install the matching browsers
- [x] pnpm verify green
- [x] perf/check.sh frontend (the harness drives Chromium through Playwright)

## Summary of Changes

@playwright/test 1.61.1 to 1.65.1 (still pinned exactly), which runs
Chromium 159; install its browsers with pnpm exec playwright install chromium
chromium-headless-shell.

Symptom fixed: e2e/assistant.spec 'pagehide closes the live conversation via
sendBeacon' failed every run with 'page.waitForRequest: Timeout 5000ms exceeded
while waiting for event "request"'. Cause: Chromium 159 does not report a
beacon sent from pagehide as a page or context request event. The beacon is
still sent and closes the conversation (with sendBeacon stubbed out the
conversation stays open). The spec now asserts the server's answer: /stop on
the conversation is 200 before pagehide and 404 after; it fails if the app
stops sending the beacon.

perf: perf/check.sh refuses to compare across Chromium versions, so the
frontend baseline was re-recorded on a quiet machine; counts are unchanged and
the branch then reads 'no changes'. A same-commit A/B (592cb35, Chromium 149
vs 159) matched within noise on every timing. K/drag-bottom's move from 36 to
58 ms predates this branch: pkm-izun.
