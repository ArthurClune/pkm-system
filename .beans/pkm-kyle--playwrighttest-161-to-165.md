---
# pkm-kyle
title: '@playwright/test 1.61 to 1.65'
status: in-progress
type: task
priority: normal
created_at: 2026-11-17T22:05:50Z
updated_at: 2026-11-17T22:31:27Z
parent: pkm-tcca
---

Part of pkm-tcca. @playwright/test is pinned exactly (1.61.1) because each release needs its own cached browser build.

- [x] Bump the pin and install the matching browsers
- [x] pnpm verify green
- [ ] perf/check.sh frontend (the harness drives Chromium through Playwright)
