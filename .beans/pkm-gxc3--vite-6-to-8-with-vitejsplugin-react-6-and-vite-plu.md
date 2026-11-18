---
# pkm-gxc3
title: vite 6 to 8 with @vitejs/plugin-react 6 and vite-plugin-pwa 2
status: completed
type: task
priority: normal
created_at: 2026-11-18T11:30:28Z
updated_at: 2026-11-18T12:40:10Z
parent: pkm-tcca
---

Part of pkm-tcca. vite 8 bundles with Rolldown instead of Rollup, so the budget plugin's module ownership (tooling/viteBudgetPlugin.ts) needs re-checking. vite-plugin-pwa 2 is meant to clear the glob and minimatch advisories that reach the build through workbox-build.

- [x] Bump vite, @vitejs/plugin-react, vite-plugin-pwa
- [x] Budget plugin still attributes chunks correctly; bundle and precache budgets re-checked
- [x] pnpm audit: glob/minimatch advisories gone (via the workbox-build>glob override; only picomatch remains, unpatched)
- [x] pnpm verify green
- [x] perf/check.sh frontend (H/cold requests 13 -> 14 accepted by Arthur; baseline bootstrapped)

## Status (not merged)

Done on the branch: the bumps; budgets (precacheEntries 90 -> 122, every byte budget lower); the owned-bytes probe (no chunk with mermaid code also holds app modules); the two lone-surrogate fixture tests moved to JSON.parse; a workbox-build>glob ^14.0.6 override that clears the glob and minimatch advisories with an identical precache manifest (120 URLs and revisions). pnpm verify green after merging main.

Open: perf/check.sh frontend reports a count regression, H/cold requests 13 -> 14. Cause: Rolldown emits its module runtime as a separate chunk (app-assets/rolldown-runtime-*.js) that the entry imports statically, so dist/index.html gains a modulepreload for it. Next: keep the runtime in the entry chunk through a Rolldown output option (build.rolldownOptions.output; check advancedChunks/codeSplitting groups or a runtime-placement option in the installed rolldown's types), rebuild, confirm index.html loads only index-*.js and index-*.css, then re-run perf/check.sh frontend. If no option does it, the 13 -> 14 goes to Arthur with the perf table.


## Runtime chunk: no Rolldown option folds it (2026-11-18)

Checked against rolldown 1.2.19 (vite 8.3.8). Since rolldown 1.2.16
(rolldown/rolldown#11293, fixing #11360) the runtime module is hosted only in
a chunk that every consumer's entries load. Each lazy chunk is a dynamic
entry, and 12 of them use the helpers (PdfViewer, tablesChunk, the mermaid
chunks, LocalFilePicker), so index-*.js never qualifies and the runtime stays
in rolldown-runtime-*.js (1.1 kB). The chunkOptimization options
(mergeCommonChunks, avoidRedundantChunkLoads) are on by default and do not
override the rule; top-level await, which would disable them, appears in no
built chunk. codeSplitting.groups makes Rolldown always emit a runtime chunk,
and experimentalInlineCommonChunks keeps a shared runtime file by design. The
remaining choice is to accept H/cold requests 13 -> 14 or hold vite 8.


## Summary of Changes

vite 6 to 8 (Rolldown), @vitejs/plugin-react 6, vite-plugin-pwa 2. Budgets
re-checked (every byte budget lower; precacheEntries 90 -> 122). The two
fixture tests holding lone surrogate escapes read their JSON with JSON.parse,
since vite 8's native JSON loader rejects them. A workbox-build>glob ^14.0.6
override clears the glob and minimatch advisories with an identical precache
manifest; pnpm audit now lists only picomatch, which has no patched release.

Perf: H/cold requests 13 -> 14, accepted by Arthur. The extra request is
Rolldown's runtime chunk (rolldown-runtime-*.js, 1.1 kB), preloaded from
index.html in parallel with the entry; Rolldown places the runtime only in a
chunk every consumer loads, and no option overrides that (see the Runtime
chunk section). Frontend baseline re-recorded with --bootstrap on a quiet
machine; no other count moved.
