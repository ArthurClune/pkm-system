---
# pkm-wp0f
title: vitest 5 for the tinypool and vitest advisories
status: completed
type: task
priority: normal
created_at: 2026-11-17T20:00:01Z
updated_at: 2026-11-17T21:02:20Z
---

A full pnpm audit on 2026-11-17 reported 8 advisories, all in dev and test tooling: tinypool (2 critical, prototype pollution to RCE) and vitest/@vitest/mocker (3 moderate) via vitest 3.2.7, glob and minimatch (moderate) and picomatch (high). pnpm audit --prod is clean. pkm-vrnh left the vitest ones open because vitest 3 has no fixed release.

vitest 5.1.0 still accepts vite ^6.4, so vite stays on 6. eslint 10.15 moves eslint's minimatch to 11 within range. What stays open: glob and minimatch via vite-plugin-pwa 1 > workbox-build (needs vite-plugin-pwa 2, deferred-majors bean) and picomatch via typescript-eslint (no patched release).

- [x] vitest and @vitest/coverage-v8 to 5.1.0; eslint and typescript-eslint in range
- [x] Unit suite and coverage thresholds green under vitest 5
- [x] tooling configs that use vitest (perf rebase, orphan watchdog, proptest web) still work
- [x] pnpm verify green
- [x] proptest/check.sh web and perf/check.sh frontend
- [x] Record the audit before/after

## Summary of Changes

vitest and @vitest/coverage-v8 3.2.7 to 5.1.0 (vite stays 6.4.6, which vitest 5 accepts); eslint 10.15 and typescript-eslint 8.73 within range. pnpm audit went from 8 (2 critical, 1 high, 5 moderate) to 3: glob and minimatch via vite-plugin-pwa 1 > workbox-build (pkm-tcca carries vite-plugin-pwa 2) and picomatch via typescript-eslint (no patched release). pnpm audit --prod stays clean.

vitest 5 defaults `clearMocks` to true, so a test can no longer read a mock call recorded in an earlier test. One did: MermaidDiagram's secured-config test read `initialize`'s call from the fallback test, since loadMermaid() initializes once per file. The two are merged into the test that triggers the call. vitest 4 removed `poolOptions`; the perf rebase config uses `maxWorkers: 1`. `ReturnType<typeof vi.fn>` widened to a constructable union, so CellMediaLabel.test.tsx types its sidebar mock as `Mock<SidebarApi["openInSidebar"]>`.

pnpm verify green: 7136 unit tests, coverage 96.83 / 93.91 / 96.55 / 98.35 (statements, branches, functions, lines) against thresholds 95 / 91 / 89 / 95; 127 Playwright specs. proptest web: 248 passed. perf frontend: counts unchanged and the precache budget OK; four timings read stale-baseline, measured as slow at the merge base as on the branch, on a machine with a game running, so the baselines were not re-recorded.
