---
# pkm-gxc3
title: vite 6 to 8 with @vitejs/plugin-react 6 and vite-plugin-pwa 2
status: in-progress
type: task
priority: normal
created_at: 2026-11-18T11:30:28Z
updated_at: 2026-11-18T12:06:49Z
parent: pkm-tcca
---

Part of pkm-tcca. vite 8 bundles with Rolldown instead of Rollup, so the budget plugin's module ownership (tooling/viteBudgetPlugin.ts) needs re-checking. vite-plugin-pwa 2 is meant to clear the glob and minimatch advisories that reach the build through workbox-build.

- [x] Bump vite, @vitejs/plugin-react, vite-plugin-pwa
- [x] Budget plugin still attributes chunks correctly; bundle and precache budgets re-checked
- [ ] pnpm audit: glob/minimatch advisories gone (they are not: see below)
- [x] pnpm verify green
- [ ] perf/check.sh frontend (H/cold requests 13 -> 14: see Status)

## Status (not merged)

Done on the branch: the bumps; budgets (precacheEntries 90 -> 122, every byte budget lower); the owned-bytes probe (no chunk with mermaid code also holds app modules); the two lone-surrogate fixture tests moved to JSON.parse; a workbox-build>glob ^14.0.6 override that clears the glob and minimatch advisories with an identical precache manifest (120 URLs and revisions). pnpm verify green after merging main.

Open: perf/check.sh frontend reports a count regression, H/cold requests 13 -> 14. Cause: Rolldown emits its module runtime as a separate chunk (app-assets/rolldown-runtime-*.js) that the entry imports statically, so dist/index.html gains a modulepreload for it. Next: keep the runtime in the entry chunk through a Rolldown output option (build.rolldownOptions.output; check advancedChunks/codeSplitting groups or a runtime-placement option in the installed rolldown's types), rebuild, confirm index.html loads only index-*.js and index-*.css, then re-run perf/check.sh frontend. If no option does it, the 13 -> 14 goes to Arthur with the perf table.
