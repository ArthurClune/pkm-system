---
# pkm-zotb
title: 'KaTeX bundle hygiene: dedupe dual katex, drop @types/katex, measure entry growth'
status: in-progress
type: task
priority: normal
created_at: 2026-07-17T18:57:17Z
updated_at: 2026-07-19T14:07:29Z
---

Follow-ups from pkm-lr96 final review (branch feature/latex-support):

1. Two katex versions ship as lazy chunks: our direct katex@0.17.0 plus mermaid@11.16.0's transitive katex@0.16.47 (pre-existing). ~260KB avoidable lazy/precache bytes. Try a pnpm override forcing katex@^0.17 (needs a mermaid-compat check), then rebaseline budgets.json (katexOwnedBytes roughly halves; totalOutputBytes/precacheBytes/precacheEntries shrink).
2. Remove the redundant @types/katex devDep — katex 0.17.0 bundles its own types (types/katex.d.ts), so the 0.16-era @types package is inert and could confuse a future katex bump. Lockfile regen + pnpm verify rerun.
3. One-off measurement: initialEntryBytes grew +6407B on the latex branch vs the plan's ~2KB estimate. Attribution (eager tokenizer/MathSpan-shell code vs Vite preload-manifest wiring) is asserted, not measured. Run a build with sourcemaps through source-map-explorer on index-*.js and record where the bytes went; informs the cumulative-drift watch.

See budgets.json rationale entries (measuredOn 2026-07-17) for the full investigation.
