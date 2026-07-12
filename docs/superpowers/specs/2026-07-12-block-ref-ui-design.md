# Block-level link creation UI (pkm-y6af)

Date: 2026-07-12
Bean: pkm-y6af

## Problem

`((uid))` block refs render and resolve for blocks imported from the Roam
graph, but there is no way to create a new block ref from inside the app.
Two gaps:

1. **Creation UI** — nothing exposes a block's uid, so users can't write
   `((uid))` by hand.
2. **Live resolution** — `block_ref_texts` arrive only with the initial page
   payload, so a freshly pasted ref renders as unresolved `((uid))` until the
   page is reloaded.

## Decision (user preference: block-level context menu)

### Creation: bullet context menu

- Left-click or right-click (`contextmenu`) on a block's bullet opens a small
  menu anchored at the pointer. The bullet currently has no click action, so
  this is free; drag continues to work (drag suppresses click).
- One item for now: **Copy block reference** — writes `((uid))` to the
  clipboard and closes the menu. Copying is read-only-safe, so the menu also
  works while disconnected (same rationale as multi-block copy).
- Menu closes on Escape, on click-away, and after picking an item.
- Insertion is then a plain paste into any block textarea — no special paste
  handling needed; the existing grammar/tokenizer already renders `((uid))`.

Alternatives considered:
- `((` autocomplete popup (search blocks by text): more work, needs a block
  search endpoint, and the user explicitly prefers a context menu. Can be a
  follow-up bean.
- "Copy ref" only on right-click: plain click added too because iPad Safari
  does not reliably fire `contextmenu` from touch.

### Live resolution: lazy fetch of unknown uids

- New endpoint `GET /api/block-refs?uids=a,b,c` returning
  `{"block_ref_texts": {...}}`, reusing the existing transitive resolver in
  `routes_pages.py` (refactored to accept seed uids). Unknown uids are simply
  omitted (they render unresolved, as today).
- Web: `BlockRefProvider` (imperative shell) wraps the payload-provided map
  and exposes `requestRef(uid)` through a second context
  (`BlockRefRequestContext`, default no-op so existing render sites/tests are
  untouched). `BlockRef` calls it from an effect when its uid is missing from
  the map. The provider batches requested uids (microtask/short debounce),
  fetches once per uid per mount (a `requested` set prevents refetch loops for
  genuinely missing uids), and merges results under the payload map
  (payload wins).
- `PageView` and `Journal` mount the provider seeded from their payloads.

## Components

- `web/src/components/BlockMenu.tsx` — dumb fixed-position popup styled like
  `.ac-popup`; props: `{x, y, items, onClose}`. Owns Escape/click-away
  listeners.
- `EditableBlockTree.tsx` — tree-level `menu` state `{uid, x, y} | null`;
  bullet gains `onClick`/`onContextMenu`; the copy action calls
  `navigator.clipboard.writeText("((uid))")` (this file is already the
  imperative shell for the outline).
- `web/src/components/BlockRefProvider.tsx` — shell described above.
- `server/src/pkm/server/routes_pages.py` — extract `_resolve_ref_uids(db,
  uids)` from `_block_ref_texts`; add `GET /api/block-refs` with uid-format
  validation (`^[a-zA-Z0-9_-]{6,32}$`, cap ~50 uids); new
  `BlockRefsPayload` response model; regenerate `openapi.json` + `types.d.ts`.

## Testing

- Server: endpoint resolves direct + transitive refs, omits unknown uids,
  rejects malformed uids.
- Web unit: menu opens on bullet click/right-click; copy writes `((uid))`;
  Escape/click-away close; provider fetches unresolved uid and re-renders
  resolved; missing uid fetched once only.
- E2E (verify skill): copy a ref on one page, paste into another, see it
  resolve live without reload.

## Out of scope

- `((` autocomplete / block search insertion (follow-up bean if wanted).
- Click-to-navigate on resolved refs (parity with imported refs preserved).
- Context menu on read-only `BlockTree` render sites (backlinks, queries).
