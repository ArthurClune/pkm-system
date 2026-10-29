---
# pkm-vrnh
title: Dev and build-tool advisories (pnpm audit without --prod)
status: todo
type: task
priority: low
created_at: 2026-10-29T18:06:05Z
updated_at: 2026-10-29T18:06:05Z
---

After the security epic's dependency upgrades, `pnpm audit --prod` reports only the two react-router advisories (pkm-ov19), but a full `pnpm audit` on 2026-10-29 reported 49 in dev and build tools (vite, vitest, brace-expansion, fast-uri, browserslist, zod and others; 2 critical, 27 high). They affect building, testing and the dev server, not the shipped bundle. SECURITY.md's dependency row says so.

- [ ] Run `pnpm audit` and sort each advisory by reach (dev server, build, test only)
- [ ] Upgrade what has a fix on the current major; re-run pnpm verify and perf
- [ ] Record what stays open and why
