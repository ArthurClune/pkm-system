---
# pkm-gdi5
title: llm UI clickable links
status: todo
type: feature
priority: normal
created_at: 2026-07-28T10:04:09Z
updated_at: 2026-07-28T10:07:30Z
---

In the LLM panel, the assistant needs the ability to link to sub-page items (images, blocks)

Example below. In this it would be better to make the chart a clickable link that opens the relevant block in the main window or, with shift-click, in the side panel



can you open the compute growth chart
✓ search_assets
✓ search_assets
Here it is — I can't render the image directly, but you can view it at this URL, and here's a description of what's in it:

Chart: "Global AI computing capacity is doubling every 7 months" (source: epoch.ai)

📊 /assets/492d80a8b6a72a7c4615c69a9a7def6fac0e019d452f9c88bb61ca8a671dbfd7/IMG_0868.jpeg

- Y-axis: Cumulative compute capacity (H100-equivalents), from 0 to 16M

## Tasks

- [x] tokenize.ts: autolink bare `/assets/<64-hex-sha256>/<filename>` as a new `asset-link` segment kind
- [x] `AssetLink.tsx`: resolve the sha via `GET /api/search?exact=1`, click navigates to the referencing block, shift-click opens it in the sidebar, no-hit/error falls back to opening the raw asset
- [x] Wire `asset-link` into `InlineSegments.tsx`
- [x] `AssistantPanel.tsx`: wrap the message list in `BlockRefProvider` so `((uid))` block refs in replies resolve and are clickable
- [x] `SidebarApi.openInSidebar(title, uid?)`: App's stack carries an optional uid; `BlockRef.tsx` shift-click passes its own uid
- [x] `EditableSidebarPanel.tsx`: scroll+flash effect for the target uid, scoped to the panel's own container (never document-wide)
- [x] Unit tests for all of the above (tokenizer, AssetLink, InlineSegments dispatch, AssistantPanel block-ref resolution, BlockRef/SidebarPanel/EditableSidebarPanel plumbing)
- [x] E2E: `web/e2e/assistant-asset-link.spec.ts` — click opens the referencing block (scroll+flash), shift-click opens it in the sidebar
- [x] `pnpm verify` green (typecheck, lint, fcis, coverage, build, full Playwright e2e)

## Summary of Changes

Assistant replies mentioning assets as bare `/assets/<sha256>/<filename>` URLs are now
clickable: `tokenize.ts` gained an `asset-link` autolink rule (mirroring the existing
bare-`https://` rule, including trailing-punctuation stripping), rendered by a new
`AssetLink.tsx` component. Click resolves the sha via `GET /api/search?q=<sha>&exact=1`
(FTS5's unicode61 tokenizer keeps the 64-hex sha as one token, so a block whose text
contains the URL is an exact hit) and opens that block in the main window (plain click)
or the sidebar (shift-click); no hit, or a failed lookup, falls back to
`window.open(url, "_blank", "noopener")` on the raw asset.

`((uid))` block refs in assistant replies now resolve too: `AssistantPanel.tsx` wraps
its message list in `<BlockRefProvider seed={{}}>`, so every ref is fetched live via the
existing `GET /api/block-refs` batching machinery.

Sidebar navigation was extended to carry an optional target uid end-to-end:
`SidebarApi.openInSidebar(title, uid?)` (`contexts.ts`) -> `App.tsx`'s stack entries ->
`SidebarPanel` -> `EditableSidebarPanel`, which scrolls to and flashes that uid via an
effect scoped to its OWN container ref (never a document-wide `querySelector`, since the
same page can be open in the main window at the same time). `BlockRef.tsx`'s shift-click
now passes its own uid through the same path. All existing `openInSidebar(title)`
call sites (`PageLink.tsx`) keep compiling unchanged since the uid is optional.

Verified with `pnpm verify` (typecheck, lint, fcis boundary check, unit coverage, build,
full Playwright e2e) — all green; 110 unit test files / 1590 tests, 42/42 e2e specs.
No server changes were needed (existing `GET /api/search?exact=1` and
`GET /api/block-refs` covered both resolution paths).
