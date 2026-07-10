---
# pkm-g356
title: Editable sidebar panels
status: completed
type: feature
priority: normal
created_at: 2026-07-09T19:50:01Z
updated_at: 2026-07-09T21:53:09Z
---

Sidebar panels (shift-click stack) are currently read-only BlockTree renders. Make them full editable outlines like the main pane — same useOutline editing, live WS sync — including being a drag-and-drop target/source once block DnD lands (see pkm-jg1p). Click-through-to-edit stops being the only write path for stacked pages.


## Plan
- [x] Registry (`outline/activeOutlines.ts`) tracking which page titles have a live editable outline mounted in this tab
- [x] `EditablePage` falls back to read-only (still live via `outline.blocks`) when its title is already active elsewhere in the tab
- [x] New `EditableSidebarPanel` (fetch + delegate to `EditablePage`); `SidebarPanel.tsx` becomes a thin wrapper
- [x] Tests: registry, EditablePage dedup fallback, EditableSidebarPanel (edit sends op, remote batch updates, same-page-in-main-and-panel fallback)
- [x] `pnpm vitest run` and `pnpm typecheck` green
- [x] Follow-up bean for DnD sources/targets integration (pkm-auvy)

## Summary of Changes

Panels are now full editable outlines, not one-shot read-only fetches.

- **`web/src/outline/activeOutlines.ts`** (new): a per-tab refcounted
  registry of which page titles currently have a live editable outline
  mounted. Needed because two `useOutline` instances of the *same* page in
  one browser tab cannot reconcile — the websocket dedupes a batch as "our
  own echo" once per tab (`SyncProvider`, by `client_id`), not per outline
  instance, so a second live editor would never learn about edits flushed
  through the first and the two would silently diverge.
- **`web/src/views/EditablePage.tsx`**: on mount, checks the registry once
  (via a ref, decided synchronously so there is no editable-then-read-only
  flash) and registers itself if the title is not already active. If the
  title *was* already active elsewhere, it renders a read-only `BlockTree`
  fed by `outline.blocks` instead of the editable tree — so it still still
  updates live for batches from genuinely other clients, it just cannot
  itself be edited. This single change point covers every caller
  (`PageView`, `Journal`, and the new `EditableSidebarPanel`), so the main
  pane and Journal did not need their own changes.
- **`web/src/components/EditableSidebarPanel.tsx`** (new): fetches
  `/api/page/{title}` (same as the old `SidebarPanel` body) and renders it
  through `EditablePage`, gaining the outline hook, op queue, and live WS
  sync for free.
- **`web/src/components/SidebarPanel.tsx`**: reduced to a thin wrapper
  (header + close button) delegating the body to `EditableSidebarPanel` —
  net diff is -22/+2 lines, to keep the merge with `worktree-dnd-blocks`
  (which also touches this file, per the handover doc) as small as
  possible.
- Tests: `outline/activeOutlines.test.ts` (4), `EditablePage.test.tsx` (+3:
  read-only fallback, fallback still receives remote batches, re-editable
  after the first instance unmounts), `EditableSidebarPanel.test.tsx` (5:
  fetch+render, op on edit, remote batch, same-page-elsewhere fallback,
  fetch error). `SidebarPanel.test.tsx` unchanged and still passes.

**Multiple simultaneous outlines (different pages):** already safe with no
changes needed — `SyncProvider` broadcasts every remote batch to every
subscriber, and `outline/tree.ts`’s `applyOps` filters ops to the
subscriber's own `pageTitle` (by `page_title` for `create`, by uid presence
for everything else), so N concurrent `useOutline` instances on N different
pages already coexist correctly; the shared op queue just batches
everyone's ops into shared POST /api/ops calls, which is intentional.

**Same page open twice (main pane + panel, or panel + panel):** the one
real hazard, handled via `outline/activeOutlines.ts` as above — first
mount wins editing, later ones fall back to a read-only (but still
live-for-remote-batches) view. This was explicitly pre-authorized by the
task brief as an acceptable resolution when the sync layer could not be
touched to fully generalize it (`useOutline.ts` / `SyncProvider.tsx` were
off-limits for restructuring due to the concurrent DnD branch).

**`useOutline.ts` / `SyncProvider.tsx`: untouched**, as required.

**Follow-up:** pkm-auvy tracks wiring panels into block drag-and-drop once
pkm-jg1p lands (blocked-by pkm-jg1p), including revisiting the read-only
fallback UX once dragging exists.

Branch: `bean/pkm-g356-editable-sidebar-panels`. All tests green: `pnpm
vitest run` — 33 files / 203 tests. `pnpm typecheck` — clean.
