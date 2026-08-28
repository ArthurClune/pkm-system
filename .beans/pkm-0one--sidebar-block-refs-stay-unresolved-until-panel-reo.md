---
# pkm-0one
title: Sidebar block refs stay unresolved until panel reopen
status: completed
type: bug
priority: normal
created_at: 2026-08-28T17:15:25Z
updated_at: 2026-08-28T17:17:43Z
---

A block reference ((uid)) typed into a block in the sidebar stays rendered as the raw unresolved ((uid)) text until the page is closed and re-opened. In the main pane it resolves to a link as soon as the block blurs.

Root cause: EditableSidebarPanel.tsx wraps the editor in a bare BlockRefContext.Provider (value=payload.block_ref_texts), whereas PageView.tsx mounts the BlockRefProvider component, which additionally supplies BlockRefRequestContext -- the channel BlockRef.tsx uses to ask for on-demand fetches of uids missing from the seed map. Because the sidebar only provides the bare context, BlockRefRequestContext falls back to its no-op default, so newly-typed refs never trigger a fetch and stay unresolved until the panel is closed and reopened (a fresh payload fetch).

Fix: mount BlockRefProvider in EditableSidebarPanel.tsx exactly as PageView.tsx does, seeded with payload.block_ref_texts.

## Todo
- [x] Write failing test in EditableSidebarPanel.test.tsx: a block whose text contains a ((uid)) not in block_ref_texts; assert it resolves after the mocked /api/block-refs fetch
- [x] Confirm test fails for the right reason (no fetch made, ref stays unresolved)
- [x] Apply one-line fix: BlockRefProvider instead of bare BlockRefContext.Provider
- [x] Confirm test passes
- [x] Add one sentence to docs/architecture/frontend.md recording the invariant
- [x] Run pnpm verify (typecheck + unit coverage + e2e) from web/
- [x] Commit code + test + doc + bean together

## Summary of Changes
- `web/src/components/EditableSidebarPanel.tsx`: replaced the bare
  `BlockRefContext.Provider value={payload.block_ref_texts}` with
  `<BlockRefProvider seed={payload.block_ref_texts}>`, mirroring
  `PageView.tsx`. This restores the `BlockRefRequestContext` channel that
  `BlockRef.tsx` uses to request an on-demand fetch of a `((uid))` missing
  from the seed map, so newly-typed refs in the sidebar resolve live instead
  of waiting for the panel to remount.
- `web/src/components/EditableSidebarPanel.test.tsx`: added a regression
  test asserting a `((uid))` ref absent from `block_ref_texts` resolves
  after the mocked `/api/block-refs` fetch, the same as the existing
  `BlockRefProvider.test.tsx` coverage for the main pane.
- `docs/architecture/frontend.md`: added one sentence recording the
  invariant that both single-page surfaces sharing `useOutlinePageLoad`
  must mount `BlockRefProvider`, not the bare context, or refs typed there
  never resolve.
- `pnpm verify` (typecheck, unit tests w/ coverage, Playwright e2e) passed
  clean: 147 test files / 2326 unit tests, 54 e2e tests, no flakes.
