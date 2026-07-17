---
# pkm-lr96
title: Latex support
status: in-progress
type: feature
priority: normal
created_at: 2026-07-17T16:49:54Z
updated_at: 2026-07-17T17:01:20Z
---

Content in '$$' should be rendered latex. i.e. $$ ... latex expression here...$$ should show as render latex

See  [[Software Estimation]] for an example. This should render both as a standalone block and embeded within a block i.e

some test $$ some latex $$ some more text

should render the latex within the line

## Summary of Changes

- **Tokenizer**: `$$...$$` spans are tokenized into a new `{ kind: "math", tex, display }`
  segment (`web/src/grammar/tokenize.ts`). The close-`$$` search is code-aware (won't split
  a `$$` sitting inside inline code), and `display` is true only when the whole block is a
  single `$$...$$` expression (otherwise it renders inline, flowing with surrounding text).
- **Rendering**: `web/src/components/MathSpan.tsx` renders math segments via a lazily
  loaded KaTeX (`import("katex")` + its CSS, cached per-page module-level promise, mirroring
  `MermaidDiagram`'s lazy-load pattern) so pages without math never pay the ~280KB cost.
  Inline math renders as `span.math-inline .katex`; display math as `span.math-display
  .katex-display`. Invalid TeX (KaTeX throws) falls back to the raw `$$source$$` text in a
  tinted `span.math-error` rather than crashing the block.
- **Bundle budgets + PWA precache**: `tooling/buildBudgets.mjs` caps the KaTeX chunk's
  owned bytes (`katexOwnedBytes`) and the PWA service worker precaches KaTeX's core fonts
  so offline math rendering doesn't require a network round-trip on first use.
- **Test coverage**: unit tests for the tokenizer additions and `MathSpan` (loading/ok/error
  states, inline vs. display) land with Tasks 1–2; `tooling/buildBudgets.test.ts` covers the
  new budget dimension. A new E2E spec, `web/e2e/math.spec.ts`, drives a real browser
  build end-to-end: inline math renders inside the block's text flow, display math renders
  as a standalone KaTeX display block, and invalid TeX (`$$\frac{$$ broken`) shows the raw
  source in `.math-error` instead of crashing. Full `pnpm verify` (typecheck, lint,
  check:fcis, unit coverage, build budgets, full Playwright suite including the new spec)
  passes clean.
- **Design docs**: see `docs/superpowers/specs/2026-07-17-latex-support-design.md` (spec)
  and `docs/superpowers/plans/2026-07-17-latex-support.md` (implementation plan) for the
  full design rationale and task breakdown (Tasks 1–4).
