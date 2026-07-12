---
# pkm-y6af
title: Expose UI for creating block-level links
status: completed
type: feature
priority: normal
created_at: 2026-07-11T20:37:00Z
updated_at: 2026-07-12T16:53:10Z
---

Block-level linking works for blocks imported from the graph, but there is no UI to create NEW block-level links from within the app. Need a way to reference/link to a specific block (e.g. a ((block-ref)) style autocomplete, a 'copy block reference' action on the block menu, or both) so users can create block links natively.

Checklist:
- [x] Decide UX for creating a block link (trigger syntax and/or block context-menu action)
      → bullet context menu with "Copy block reference" (user preference); design doc:
      docs/superpowers/specs/2026-07-12-block-ref-ui-design.md
- [x] Server: GET /api/block-refs?uids=... endpoint (transitive resolver) + tests
- [x] Web: BlockMenu popup on bullet click/right-click; Copy block reference → clipboard ((uid)) + tests
- [x] Web: BlockRefProvider lazily fetches unknown uids so pasted refs resolve live + tests
- [x] Regenerate openapi.json + types.d.ts
- [x] Render/navigate the new links the same as imported ones (covered by lazy fetch; verified e2e)
- [x] Full suites: pytest (316), pyrefly, ruff, pnpm test (409), typecheck — all green

## Summary of Changes

UX: click or right-click a block's bullet → context menu with **Copy block
reference**, which puts `((uid))` on the clipboard (works read-only/offline;
plain click included because iPad Safari doesn't fire contextmenu from touch).
Paste into any block; the existing grammar renders it.

- server: `GET /api/block-refs?uids=...` — on-demand transitive `((uid))`
  resolution (extracted `_resolve_ref_uids` from the page-payload path);
  `BlockRefsPayload` response model; openapi.json + types.d.ts regenerated.
- web: `BlockMenu` (fixed-position menu, Escape/click-away close),
  bullet click handlers + menu state in `EditableBlockTree`;
  `BlockRefProvider` + `BlockRefRequestContext` — `BlockRef` asks the
  provider to fetch uids missing from the payload map (batched, once per
  uid per mount), so freshly pasted refs resolve live without reload.
  `PageView`/`Journal` now mount the provider around the old context.
- e2e verified on a scratch server: copy writes `((uid))`, typed ref
  resolved live via one `/api/block-refs` call; verify-skill selector
  table gained `.block-menu` / `.block-menu-item`.

Design doc: docs/superpowers/specs/2026-07-12-block-ref-ui-design.md.
Deferred (create follow-up if wanted): `((` autocomplete to search blocks
by text; click-to-navigate on resolved refs.
