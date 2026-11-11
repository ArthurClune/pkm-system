---
# pkm-vrnh
title: Dev and build-tool advisories (pnpm audit without --prod)
status: completed
type: task
priority: low
created_at: 2026-10-29T18:06:05Z
updated_at: 2026-10-29T18:06:05Z
---

After the security epic's dependency upgrades, `pnpm audit --prod` reports only the two react-router advisories (pkm-ov19), but a full `pnpm audit` on 2026-10-29 reported 49 in dev and build tools (vite, vitest, brace-expansion, fast-uri, browserslist, zod and others; 2 critical, 27 high). They affect building, testing and the dev server, not the shipped bundle. SECURITY.md's dependency row says so.

- [x] Run `pnpm audit` and sort each advisory by reach (dev server, build, test only)
- [x] Upgrade what has a fix on the current major; re-run pnpm verify and perf
- [x] Record what stays open and why

## Summary of Changes

`pnpm update` within each direct dependency's range (vite 6.4.3 to 6.4.6, postcss, eslint, typescript-eslint, playwright and others) moved the transitive fixes with it: brace-expansion, fast-uri, browserslist, js-yaml, nanoid, zod, serialize-javascript and the rest resolved without an override or a major jump. The full `pnpm audit` went from 49 (5 low, 15 moderate, 27 high, 2 critical) to 8 (1 low, 5 moderate, 2 critical); `pnpm audit --prod` stays clean.

## Advisories that stay open

All are test or build time; none ships in the bundle.

| Package | Severity | Reach | Why open |
|---|---|---|---|
| tinypool (2 advisories) | critical | test only, via vitest 3 | fixed in tinypool 2.1.1+, which vitest 4 pulls in; vitest 3 has no fixed release |
| vitest, @vitest/mocker (3 advisories) | moderate | test only | fixed from 4.1.11; needs the vitest 4 major |
| glob (via @vitest/coverage-v8 > test-exclude) | moderate | test coverage only | fixed in glob 14.0.2; test-exclude pins an older major, so an override would cross majors |
| minimatch (via vite-plugin-pwa > workbox-build > glob) | moderate | build only | fixed in 11.0.1; workbox-build pins an older major, so an override would cross majors |
| deepmerge (via workbox-build) | low | build only | no patched release exists |
