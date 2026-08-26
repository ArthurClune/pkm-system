---
# pkm-yus0
title: Beautiful-mermaid as primary diagram renderer with stock mermaid fallback
status: in-progress
type: feature
priority: normal
created_at: 2026-08-26T13:59:19Z
updated_at: 2026-08-26T14:25:26Z
---

Step 2 of the mermaid prettiness work (step 1 = pkm-91y3 token theming, deployed at 0a8d1db). Spike on 2026-08-26 rendered all 20 real diagrams (PKM export + docs/architecture) through both renderers: beautiful-mermaid's ELK layout is clearly better on complex flowcharts, zero render failures. Arthur approved the swap.

## Design (approved in chat)
- MermaidDiagram.tsx tries beautiful-mermaid first (lazy, cached module promise). On throw: silent fallback to stock mermaid exactly as today. Both fail -> existing raw-source error block.
- New pure core maps design tokens -> beautiful-mermaid RenderOptions (bg/fg/line/muted/surface/border/accent/font).
- Live re-theming NOW IN SCOPE for the beautiful-mermaid path: per-diagram render, re-render on effective theme change. Stock fallback path keeps mount-time snapshot.
- Accepted: ER column comments dropped (no ER diagrams in graph; docs ER rendered by GitHub, not the app). v1.1.x library risk covered by fallback.

## Todo
- [x] Build smoke: beautiful-mermaid + elkjs bundle under Vite — clean lazy chunk, 1,614,362 bytes raw (elk.bundled dominates); entry unchanged. Chunk is named index-*.js after the package's dist/index.js — use a local re-export shim to name it beautifulMermaid-*.js. Rebaseline needed: largestAssetBytes, totalOutputBytes, precacheBytes (+~1.4MB offline weight, accepted — diagrams must work offline like mermaid.core); precacheEntries/initialEntryBytes/mermaidOwnedBytes unaffected. Add beautifulMermaidOwnedBytes family cap seeded on the package (elkjs/entities join via reachability).
- [x] TDD: pure token->RenderOptions mapping tests (incl. transparent: true — opaque --bg card seamed against row hover tints)
- [x] TDD: component three-tier path (bm success / fallback to stock / both fail -> raw source)
- [x] TDD: theme-flip re-render on the bm path (new useEffectiveTheme hook: data-theme MutationObserver + media query — useTheme state is per-component, invisible cross-component)
- [x] Implement (beautifulMermaid.ts re-export barrel names the chunk + mock seam; budget work: beautifulMermaidOwnedBytes cap, largest/total/precache rebaselined, chunkSizeWarningLimit 1550; FIXED latent budget-plugin bug — owned-graph seed regexes matched the package name anywhere in the path, so a worktree named beautiful-mermaid made all 2200 modules seeds; all seeds now anchored to node_modules/ via isPackageModule, with tests)
- [x] pnpm verify green
- [x] Live check: flowchart via bm, live theme flips BOTH directions re-render with fresh tokens (no reload), gantt fired the silent stock fallback. Screenshots sent; Arthur eyeball pending before merge.
- [x] docs/architecture/frontend.md updated (render order + fallback invariant, useEffectiveTheme in module map, checker clean)
