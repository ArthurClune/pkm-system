# pkm-vcn6: File browser improvements — design

**Date:** 2026-08-12
**Bean:** pkm-vcn6
**Status:** approved

## Problem

Four gaps in the `/files` browser's cards (bean pkm-vcn6):

1. The "N refs" badge is a dead `<span>` — you can see an image is
   referenced but not from where.
2. The "described" badge is also dead; the description (the whole point
   of pkm-zc0c) is invisible in the UI. The "failed" badge hides its
   error behind a hover tooltip.
3. Clicking an image thumbnail opens the raw asset in a new tab instead
   of the in-app fullscreen overlay used everywhere else.
4. "Search files" reads as filename-only search. (Investigation showed
   the backend already LIKE-matches description **and** filename —
   `routes_assets.py` `search_assets`, proven by
   `test_describe_routes.py` — so this is purely a discoverability
   fix.)

## Scope

Web app only. **No server, API, or schema changes** — the refs popover
reuses the existing `GET /api/block-refs?uids=…` batch endpoint
(pkm-y6af), which returns `{uid: {text, page_title}}` for up to 50
uids. No openapi regen, no shim-parity work (`/files` is online-only;
it early-returns when disconnected).

## Design

### 1. Refs popover

- The linked badge (`N refs`) becomes a `<button>`; the `orphan` badge
  stays inert.
- Click opens a popover following the `BlockRefBacklinksPopover`
  conventions exactly: `block-ref-popover`-style panel, position
  clamped via `clampPopoverPosition` with a re-clamping layout effect,
  dismissal on Escape or outside mousedown, mouse/touch-only (no focus
  trap — the accepted popover convention from pkm-3w2h).
- On open it fetches `/api/block-refs?uids=<card's ref uids>`. Requests
  are chunked at 50 uids (the endpoint's cap). The card's `refs` array
  (from the search payload) is the row source; the fetch only supplies
  block text.
- Rows are grouped by `page_title`; each row shows the referencing
  block's text and navigates to `pagePath(page_title)#<uid>` (the same
  scroll-and-flash navigation the backlinks popover uses), closing the
  popover first.
- A uid the endpoint omits (block deleted between search and click)
  renders as a page-title-only row that still navigates to
  `pagePath(page_title)#<uid>` — PageView tolerates a missing hash
  target.

### 2. Description popover

- The status badge becomes a `<button>` when it has content:
  - `described` → popover showing `item.description` (already in the
    search payload; no fetch).
  - `failed` → popover showing `item.describe_error`; the existing
    hover `title` tooltip is kept as a secondary affordance.
  - `pending` → stays inert.
- Same popover chrome and dismissal as the refs popover.

### 3. In-app image expansion

- Extract `AssetImage`'s fullscreen overlay (portal onto `document.body`,
  body scroll lock, Escape to close, Tab kept on the Close button,
  focus returned to the trigger) into a shared
  `web/src/components/ImageOverlay.tsx`.
- `AssetImage` keeps byte-identical behaviour, now delegating to
  `ImageOverlay`.
- `FileCard`'s thumbnail for `mimeCategory === "image"` changes from
  `<a target="_blank">` to a `<button>` opening `ImageOverlay` with the
  asset URL. The broken-image fallback (`file-type-label`) is
  unchanged. Non-image thumbs (pdf / document / other) keep the
  new-tab `<a>`.

### 4. Search discoverability

- Placeholder and `aria-label` change from "Search files" to
  "Search names & descriptions". No behaviour change.

## Components

- `web/src/components/ImageOverlay.tsx` — new; the extracted overlay.
- `web/src/views/Files.tsx` — badge buttons, popover wiring, thumbnail
  button.
- `web/src/views/FileCardPopovers.tsx` — new; the refs popover
  (fetching) and the description popover (static). Pure helpers
  (grouping refs by page, chunking uids) go in `filesCore.ts`
  (Functional Core).
- `web/src/components/AssetImage.tsx` — slimmed to use `ImageOverlay`.

## Error handling

- `/api/block-refs` failure → popover shows a "Could not load
  references" line (mirroring `BlockRefBacklinksPopover`), rows fall
  back to page-title-only.
- Overlay image load error → overlay closes, thumb falls back to the
  existing broken state.

## Testing

- `Files.test.tsx`: refs badge click opens popover with grouped rows
  (block text from a stubbed `/api/block-refs`); row click navigates
  and closes; described/failed badge popovers show text; pending and
  orphan badges render as non-buttons; image thumb opens overlay,
  Escape closes; non-image thumb still an `<a>`; placeholder text.
- `filesCore.test.ts`: grouping/chunking helpers.
- `AssetImage.test.tsx`: unchanged expectations still pass after the
  extraction.
- E2E: extend the files spec if one exists in `web/e2e`; otherwise unit
  coverage suffices (popover behaviour matches an already-e2e-covered
  pattern).

## Docs

- `docs/architecture/frontend.md`: touch the Files module entry if it
  enumerates card behaviours; no API reference changes.
