---
# pkm-cpke
title: Cache rendered mermaid/KaTeX output; single theme observer
status: todo
type: task
priority: low
created_at: 2026-09-01T21:28:06Z
updated_at: 2026-09-01T21:28:06Z
parent: pkm-fgjg
---

Tier 2 — the most expensive synchronous computation in the app is re-run on every remount.

## Findings (confirmed from code)
- `web/src/components/MermaidDiagram.tsx:113-125` keeps rendered SVG in `useState`, effect keyed `[code, renderId, effectiveTheme]`; `web/src/components/MathSpan.tsx` keeps KaTeX HTML in state keyed `[tex, display]`. Module promises are cached (`MermaidDiagram.tsx:45-46`, `MathSpan.tsx:25-35`) — good — but rendered *output* is not, so navigation/remount re-runs full mermaid layout (beautiful-mermaid chunk is 1.5 MB).
- Each `MermaidDiagram` calls `useEffectiveTheme()`, installing a per-instance `MutationObserver` on `documentElement` + `matchMedia` listener (`web/src/useEffectiveTheme.ts:23-36`). 20 diagrams = 20 observers on one attribute.

## Ideas
- Module-level bounded cache keyed `(code, theme)` → SVG, and `(tex, display)` → HTML.
- Hoist effective theme into one context with a single observer.
- Preserve the standing ruling: beautiful-mermaid primary, stock mermaid fallback — never simplified away.

## Checklist
- [x] Output caches + tests
- [x] Single theme observer
