---
# pkm-zotb
title: 'KaTeX bundle hygiene: dedupe dual katex, drop @types/katex, measure entry growth'
status: completed
type: task
priority: normal
created_at: 2026-07-17T18:57:17Z
updated_at: 2026-07-19T14:18:33Z
---

Follow-ups from pkm-lr96 final review (branch feature/latex-support):

1. [x] Two katex versions ship as lazy chunks: our direct katex@0.17.0 plus mermaid@11.16.0's transitive katex@0.16.47 (pre-existing). ~260KB avoidable lazy/precache bytes. Try a pnpm override forcing katex@^0.17 (needs a mermaid-compat check), then rebaseline budgets.json (katexOwnedBytes roughly halves; totalOutputBytes/precacheBytes/precacheEntries shrink).
2. [x] Remove the redundant @types/katex devDep — katex 0.17.0 bundles its own types (types/katex.d.ts), so the 0.16-era @types package is inert and could confuse a future katex bump. Lockfile regen + pnpm verify rerun.
3. [x] One-off measurement: initialEntryBytes grew +6407B on the latex branch vs the plan's ~2KB estimate. Attribution (eager tokenizer/MathSpan-shell code vs Vite preload-manifest wiring) is asserted, not measured. Run a build with sourcemaps through source-map-explorer on index-*.js and record where the bytes went; informs the cumulative-drift watch.

See budgets.json rationale entries (measuredOn 2026-07-17) for the full investigation.

## Summary of Changes

**1. Deduped katex.** Added `overrides: { katex: ^0.17.0 }` to `web/pnpm-workspace.yaml` (pnpm 11 moved the canonical location for overrides out of `package.json`'s `pnpm.overrides`, which is now silently ignored — see https://github.com/pnpm/pnpm/issues/11536). `pnpm why katex` now reports a single resolved version instead of two, and the production build emits exactly one `katex-*.js` chunk (260023 bytes) instead of two. Confirmed mermaid is unaffected: the full `pnpm verify` run (unit + E2E) passes, including `e2e/offline-shell.spec.ts` (mermaid renders offline from the precached chunk) and `e2e/math.spec.ts` (KaTeX renders inline/display math) — mermaid resolves to the shared katex@0.17.0 install without issue.

**2. Dropped @types/katex.** Removed the devDependency from `web/package.json` and regenerated `web/pnpm-lock.yaml`. No source file referenced `@types/katex` directly; katex 0.17.0's own bundled `types/katex.d.ts` (referenced via its `package.json` `types` field) is picked up automatically. `pnpm typecheck` (`tsc`) passes clean.

**3. Rebaselined budgets.json** (measuredOn 2026-07-19). katexOwnedBytes roughly halved as predicted:
- `katexOwnedBytes`: 544813 → 271724 (actual 521352 → 260023)
- `totalOutputBytes`: 8519929 → 8254962 (actual 8153042 → 7899485)
- `precacheBytes`: 7576607 → 7311640 (actual 7250342 → 6996785)
- `precacheEntries`: 91 → 90 (actual 88 → 87)
- `initialEntryBytes`, `largestAssetBytes`, `mermaidOwnedBytes`, `pdfjsOwnedBytes`: left unchanged (unaffected by the katex dedupe; see per-field rationale notes for 2026-07-19 re-measurements).

**4. Source-map-explorer measurement — and a correction to the original assertion.** The pkm-lr96 rationale claimed the LaTeX branch's +6407B entry-chunk growth (445507 pkm-srek reference → 451914) traced to the eager `$$...$$` tokenizer and MathSpan/InlineSegments dispatch wrapper. That was asserted, not measured, and it turns out to be substantially wrong. Built sourcemapped `index-*.js` for the commit immediately before the pkm-lr96 merge (`24690e6`) and for the merge commit itself (`3b67c19`), then diffed source-map-explorer's per-file byte breakdown between the two (`pnpm dlx source-map-explorer <file> <file>.map --no-border-checks --json`, budget-plugin build check temporarily bypassed via an env-gated no-op for this one-off analysis, then reverted — not part of the shipped diff).

  Actual LaTeX-only contribution to the eager entry: **+1389 bytes**, not +6407 — `MathSpan.tsx` +758 (new file), `grammar/tokenize.ts` +463 (the `$$` delimiter scan), `InlineSegments.tsx` +58 (dispatch wiring), +110 unmapped/EOL noise. Vite's preload-manifest wiring for the new lazy katex import is not a material contributor (no distinguishable multi-hundred-byte entry attributable to it).

  The other ~5KB of the originally-measured +6407 had already landed on main *before* the LaTeX merge: commit `24690e6` (pkm-aze9, "expand uploaded images in a modal", merged 2026-07-17) measures 451961 bytes on its own — already +6454 over the 445507 pkm-srek reference, with no LaTeX code present. The two measurements (pkm-srek and pkm-lr96) happened to straddle an unrelated feature, which is why it was misattributed. This is now recorded in the `initialEntryBytes` rationale in budgets.json as a correction, and is worth keeping in mind for future one-off attribution claims: always diff against the immediate parent of the feature merge, not just "the last time we measured."

**Final budget numbers** (from `pnpm build`, 2026-07-19): initialEntryBytes 457509/462016, largestAssetBytes 1046214/1093294, totalOutputBytes 7899485/8254962, precacheBytes 6996785/7311640, precacheEntries 87/90, mermaidOwnedBytes 3427931/3461961, pdfjsOwnedBytes 466849/486845, katexOwnedBytes 260023/271724.

**Verification:** `pnpm verify` (typecheck + lint + fcis + coverage + build + Playwright E2E) — all green: typecheck clean, lint clean, fcis "112 runtime modules, no boundary violations", 93 test files / 1239 tests passed at 97.99% statement coverage, production build within all budgets with a single katex chunk, 15/15 E2E specs passed (including math.spec.ts and the mermaid-offline spec).
