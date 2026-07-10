---
# pkm-pekk
title: Support mermaid diagrams
status: completed
type: feature
priority: normal
created_at: 2026-07-10T17:50:54Z
updated_at: 2026-07-10T18:03:40Z
---

Add support for rendering mermaid diagrams in pages.

## Notes
- A fenced code block with language `mermaid` should render as a diagram
- Consider render-on-view (read mode) vs raw text while editing
- Handle invalid mermaid syntax gracefully (show error or fall back to raw text)

## Acceptance criteria
- [x] ```mermaid fenced blocks render as diagrams
- [x] Invalid diagram source degrades gracefully
- [x] Editing experience unaffected (raw text editable)
- [x] Web tests and typecheck pass

## Summary of Changes

- New `web/src/components/MermaidDiagram.tsx` (Imperative Shell): renders a
  `mermaid` fenced code block's source via mermaid's async `render()` API.
  `mermaid` is imported lazily (`import("mermaid")`) so its ~1MB doesn't
  bloat the initial bundle; the load+`initialize()` call is deduplicated
  behind a module-level cached Promise (mirroring `bluesky.ts`'s
  `didCache` pattern) so multiple diagrams on one page share a single
  chunk fetch/init. That dedup also turned out to be load-bearing for
  correctness: two `MermaidDiagram`s mounting in the same React commit
  each calling `import("mermaid")` independently hit a real race in
  Vitest's mocked dynamic-import resolution (the second import resolved to
  the *real* module instead of the mock) — caching the import behind one
  shared promise fixes both the test race and avoids redundant chunk
  loads/`initialize()` calls in production.
- `InlineSegments.tsx` dispatches `code-block` segments with `lang ===
  "mermaid"` to `MermaidDiagram` instead of `CodeBlock`; every other fence
  language is unaffected. Only the focused block renders as a raw textarea
  (`EditableBlockTree.tsx`, unchanged) — unfocused blocks always go through
  this read-mode dispatch, so editing stays raw markdown automatically.
- Render failures (invalid mermaid syntax) are caught and fall back to a
  muted "Couldn't render this diagram." note plus the raw source rendered
  via `CodeBlock` — no uncaught promise rejections, no blank block.
- `mermaid.render()`'s output is library-generated SVG assigned via
  `dangerouslySetInnerHTML`, the same trust boundary `CodeBlock`'s
  `hljs.highlight()` output already crosses (see that file's comment);
  `securityLevel: "strict"` (mermaid's default) additionally sanitizes any
  HTML/script-like content embedded in diagram labels.
- Theme: computed once per page load from the app's `data-theme` attribute
  (`dark` -> mermaid's `dark` theme, `light`/`system`+OS-light ->
  `default`), not tracked live — a diagram already on screen won't
  re-theme if the user flips light/dark mid-session, an intentional
  simplification per the bean's guidance against over-engineering this.
- Each `MermaidDiagram` instance gets a unique render id from `useId()` so
  concurrent diagrams don't collide inside mermaid's DOM-id-keyed render.
- Bundle impact: `pnpm build` succeeds; mermaid and its many per-diagram-
  type sub-chunks (flowchart, sequence, gantt, etc.) are all separate lazy
  chunks fetched only on first mermaid render, not part of the main entry
  bundle (`index-*.js` stayed ~382 kB / 125 kB gzip, unchanged in kind).
  Vite's "chunk larger than 500 kB" warning fires for `mermaid.core-*.js`
  (~634 kB / 151 kB gzip) and one mermaid-internal diagram chunk
  (~691 kB / 155 kB gzip) — expected given mermaid's size, and acceptable
  since neither is in the initial-load path.
- Tests: `web/src/components/MermaidDiagram.test.tsx` (new) covers
  successful render, passing the raw source through, distinct render ids
  per instance, render-rejection fallback to a raw code block with no
  uncaught rejection, and the muted error note. `InlineSegments.test.tsx`
  gained a dispatch test (mermaid fence -> diagram, not `CodeBlock`).
  mermaid is mocked via `vi.mock("mermaid", ...)`; mock variables are named
  `mock*` per Vitest's factory-hoisting convention (a `renderMock` naming
  choice was the initial symptom of the race described above).
- Verification: `pnpm test -- --run` (342/342 passed), `pnpm typecheck`
  (clean), `pnpm build` (succeeds, chunk-size warning only, see above).
