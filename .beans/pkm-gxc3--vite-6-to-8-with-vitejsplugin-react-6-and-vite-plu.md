---
# pkm-gxc3
title: vite 6 to 8 with @vitejs/plugin-react 6 and vite-plugin-pwa 2
status: in-progress
type: task
priority: normal
created_at: 2026-11-18T11:30:28Z
updated_at: 2026-11-18T11:39:40Z
parent: pkm-tcca
---

Part of pkm-tcca. vite 8 bundles with Rolldown instead of Rollup, so the budget plugin's module ownership (tooling/viteBudgetPlugin.ts) needs re-checking. vite-plugin-pwa 2 is meant to clear the glob and minimatch advisories that reach the build through workbox-build.

- [x] Bump vite, @vitejs/plugin-react, vite-plugin-pwa
- [x] Budget plugin still attributes chunks correctly; bundle and precache budgets re-checked
- [ ] pnpm audit: glob/minimatch advisories gone (they are not: see below)
- [x] pnpm verify green
- [ ] perf/check.sh frontend
