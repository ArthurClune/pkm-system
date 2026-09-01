---
# pkm-l33u
title: Memoise tokenizeBlock and highlight.js output; lazy-load highlight.js
status: todo
type: task
priority: normal
created_at: 2026-09-01T21:28:06Z
updated_at: 2026-09-01T21:28:06Z
parent: pkm-fgjg
---

Tier 2 — pure-function work redone on every render.

## Findings (confirmed from code and from web/dist)
- `tokenizeBlock` runs in the render body of every non-focused block (`web/src/components/EditableBlockTree.tsx:383`) and at `BlockRef.tsx:54`, `QueryBlock.tsx:73`, `BacklinkGroupList.tsx:43`, `UnlinkedSection.tsx:149`, `roamTable.tsx:10`, `AssistantPanel.tsx:137`. No cache anywhere in `web/src/grammar/`. During assistant streaming the whole transcript re-tokenizes per delta (O(transcript × deltas)).
- `web/src/components/CodeBlock.tsx:2` statically imports `highlight.js/lib/common` (37 grammars) and `:16` calls `hljs.highlight` in the render body, no memo. `CodeBlock` is statically imported by `InlineSegments.tsx:8-19`, so hljs sits in the eager entry chunk (`index-*.js`, 531 KB). `web/tooling/budgets.json` has caps for mermaid/pdf.js/katex/beautiful-mermaid but none for hljs.
- **Docs are wrong:** `docs/architecture/frontend.md:629` says highlight.js is lazy-loaded. It is not; the other four are.

## Ideas
- Bounded module-level `Map<string, Segment[]>` in front of `tokenizeBlock` keyed on raw text (immutable per render; no invalidation problem).
- Lazy-load hljs the way `MathSpan` loads KaTeX (cached `import()` promise), cache highlighted HTML per `(code, lang)`, add an hljs entry to `budgets.json`. Cold load is already fast (~160 ms to first block, 99 KB returning-user transfer) so the bundle half is modest; the recompute half compounds with the context-churn bean.
- Memoise settled assistant transcript items so only the streaming tail re-parses.

## Checklist
- [ ] tokenizeBlock cache + tests (cache hit is observably identical output)
- [ ] hljs lazy + cached + budget entry
- [ ] Correct frontend.md:629 (say what was corrected vs added in the commit message)
