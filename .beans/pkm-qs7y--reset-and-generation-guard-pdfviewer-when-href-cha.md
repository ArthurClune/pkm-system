---
# pkm-qs7y
title: Reset and generation-guard PdfViewer when href changes
status: completed
type: bug
created_at: 2026-08-01T13:20:53Z
updated_at: 2026-08-01T13:20:53Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 8.

**References:** web/src/components/PdfViewer.tsx:147-215; web/src/components/InlineSegments.tsx:52-54

failed, document metadata, expansion, and current-page state are retained when href changes. A slow getPage(1) from the previous PDF can overwrite metadata for the new document.

**Direction:** Reset viewer state in an effect keyed by href, and generation-guard both document load and page metadata callbacks.

- [x] Add rerender and old-document completion race tests
- [x] Reset and guard per-document state

## Summary of Changes

`PdfViewer` now tracks a `gen` counter (`genRef`) alongside the href it last
saw (`prevHrefRef`), both updated **synchronously during render** rather
than in a `useEffect`:

- When `href` changes, the component resets `doc`/`failed`/`expanded`/
  `currentPage` to their defaults and bumps `gen`, all inline in the render
  body (before returning JSX), not via an effect keyed on `href`.
- `onLoadSuccess`, `onLoadError`, and the nested `getPage(1).then` callback
  each capture `gen` (fixed for the render that created them) and compare
  it against `genRef.current` (always the latest) before writing state; a
  stale callback for an abandoned document is a no-op.

**Why not an effect for the reset, as the direction suggested:** effects
fire child-before-parent. A first attempt used `useEffect(() => {
setDoc(null); ... }, [href])` in the parent, but the mocked (and
potentially a fast/cached real) `Document` child can call
`onLoadSuccess`/`onLoadError` synchronously within its own mount/href-change
effect, which runs *before* the parent's effect in the same commit -- so
the parent's reset ran second and wiped out state the child had just
legitimately set, breaking the pre-existing "falls back on load failure"
test. Doing the reset synchronously during render (React's documented
"adjusting state when a prop changes" pattern) avoids the ordering hazard:
React discards and re-renders once before commit, so the child never
observes stale state and its effect can never race the reset.

Tests added to `PdfViewer.test.tsx` (all TDD, all failing before the fix):
reset of expansion/page state on href change, a stale `getPage(1)` from the
old document not overwriting the new document's metadata, an abandoned old
document's load finishing late without resurrecting its data, and a stale
load error not marking a successfully-loaded new document as failed. The
mock's `Document` gained a "manual" controllable-promise mode
(`pendingLoads`, `createDeferred`) to drive these races precisely, alongside
the existing auto-resolving mode used by all prior tests (unchanged).

Verification: `pnpm test:unit` (115 files / 1756 tests) and `pnpm
typecheck` both pass.
