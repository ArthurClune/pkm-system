---
# pkm-wp0f
title: vitest 5 for the tinypool and vitest advisories
status: in-progress
type: task
priority: normal
created_at: 2026-11-17T20:00:01Z
updated_at: 2026-11-17T20:00:01Z
---

A full pnpm audit on 2026-11-17 reported 8 advisories, all in dev and test tooling: tinypool (2 critical, prototype pollution to RCE) and vitest/@vitest/mocker (3 moderate) via vitest 3.2.7, glob and minimatch (moderate) and picomatch (high). pnpm audit --prod is clean. pkm-vrnh left the vitest ones open because vitest 3 has no fixed release.

vitest 5.1.0 still accepts vite ^6.4, so vite stays on 6. eslint 10.15 moves eslint's minimatch to 11 within range. What stays open: glob and minimatch via vite-plugin-pwa 1 > workbox-build (needs vite-plugin-pwa 2, deferred-majors bean) and picomatch via typescript-eslint (no patched release).

- [x] vitest and @vitest/coverage-v8 to 5.1.0; eslint and typescript-eslint in range
- [ ] Unit suite and coverage thresholds green under vitest 5
- [ ] tooling configs that use vitest (perf rebase, orphan watchdog, proptest web) still work
- [ ] pnpm verify green
- [ ] proptest/check.sh web and perf/check.sh frontend
- [ ] Record the audit before/after
