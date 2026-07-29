# Asset file browser (pkm-jdu3) — design

Date: 2026-07-29
Bean: pkm-jdu3 (parent pkm-zx19; builds on pkm-zc0c descriptions and the
pkm-t5pu `refs` field in `/api/assets/search`).

## Goal

A `/files` page for browsing, filtering, exporting, and deleting uploaded
assets, including an orphan-cleanup workflow and a retro-scan trigger for
image descriptions.

## Decisions made during brainstorming

- New top-level `/files` route with a sidebar nav entry (not a Settings
  section or modal).
- Thumbnail grid layout, not a table.
- Deleting a linked asset strips the reference tokens from block text.
  Blocks left empty (whitespace-only) **with no children** are deleted;
  emptied blocks that still have children are kept as empty parents
  (asset deletion must never cascade away real content).
- Export of selected assets is a server-built zip (uniform for 1 or many).
- Orphan detection is a `linked` filter on the main list, not a separate
  panel.
- Filtering, orphan detection, and pagination are server-side (Approach A):
  the orphan filter must see all matches, not just the loaded page.
- Multi-delete continues through individual failures and reports a summary
  at the end, then refetches.
- "Select all" selects everything matching the current filter (fetching
  remaining pages first if needed), so orphan purge is:
  Orphans filter → Select all → Delete.

## Server API

### `GET /api/assets/search` (extended, backwards-compatible)

New optional params alongside `q` and `limit`:

- `type`: `image | pdf | document | other`, mapped from stored mime
  (`image/*` → image; `application/pdf` → pdf; `text/*` + JSON + office
  mimes → document; else other).
- `from_ms` / `to_ms`: inclusive epoch-ms bounds on `created_at`. The
  client computes these from date inputs (timezone stays the browser's
  problem). Rows with `NULL created_at` are excluded only when a bound is
  set.
- `linked`: `all` (default) / `linked` / `orphan`. Orphan =
  `referencing_blocks()` returns empty.
- `offset`: pagination with the existing `limit`; the response gains
  `total`.

Execution: SQL handles `q`/type/date filtering and ordering (unchanged
`created_at IS NULL, created_at DESC, sha256`). With `linked=all`, SQL
does COUNT + LIMIT/OFFSET and refs are computed only for the returned
page. With `linked≠all`, the server computes refs for all SQL-filtered
candidates, filters in Python, then slices — the one full-scan path
(~1,100 sub-ms FTS lookups worst case; acceptable at personal scale and
the price of a correct orphan filter).

Carry-over from pkm-t5pu: tighten `referencing_blocks`'s return type to
`list[dict[str, str]]` while adding these callers.

### `DELETE /api/assets/{sha256}` (new)

The loud warning is client-side (the grid already has `refs`). The server
always:

1. Strips every reference token from block text, in this order:
   `![alt](/assets/<sha>/<name>)`, `[label](/assets/<sha>/<name>)`,
   `{{[[pdf]]: /assets/<sha>/<name>}}`, then any bare
   `/assets/<sha>/<name>` left over; collapses doubled spaces. FTS stays
   consistent via existing triggers.
2. Deletes blocks whose stripped text is empty (whitespace-only) and that
   have no children; keeps emptied blocks that have children.
3. Deletes the `assets` row.
4. Commits.
5. Best-effort unlinks the disk file (logged on failure).

Commit-before-unlink means a crash leaves at worst an unreferenced file on
disk (harmless in a content-addressed store), never a row pointing at a
missing file. `sha256` is the primary key, so no two rows share a file.

Returns `{deleted: true, refs_removed: n}`. 404 on unknown sha. A missing
disk file with an existing row still deletes the row.

No bulk endpoint: the client loops per sha.

### `POST /api/assets/export.zip` (new)

Body: list of selected sha256s. Streams back `assets-YYYY-MM-DD.zip` with
files under their original filenames; filename collisions get a short sha
prefix (`report (a1b2c3d4).pdf`). Unknown shas are skipped, not an error
(an all-unknown selection returns an empty zip). Built in RAM like
`/api/export.zip` — bounded by the user's selection. Delivered via
form-POST navigation so the browser handles the download under cookie
auth.

### Existing endpoints reused untouched

- `POST /api/assets/scan?force=` — retro-scan trigger.
- `GET /api/assets/describe-status` — enabled/reason for inline notes.
- Per-asset describe `status` (described/pending/failed) is already in the
  search payload.

All new endpoints sit behind `require_auth`. Route/docstring changes
require regenerating `openapi.json` + generated web types, committed
together.

## Web UI (`/files`)

- **Route & entry**: `/files` in `App.tsx` rendering a `Files` view;
  "Files" sidebar nav entry; document title "Files — pkm".
- **Filter bar**: debounced text search (`q`), type chips
  (All/Images/PDFs/Documents/Other), two native date inputs
  (from/to → `from_ms`/`to_ms`), linked-state select
  (All/Linked/Orphans). Any filter change resets to offset 0. Count line
  shows "N of M files".
- **Thumbnail grid**: responsive CSS grid (auto-fill, ~160px min column).
  Card: image-as-thumbnail for `image/*` (the `/assets/` URL is
  inline-rendered and immutable-cached; `onError` falls back to the type
  icon), type icon otherwise; truncated filename; size + upload date;
  describe-status badge (failed shows the error on hover); link badge
  ("3 refs" or "orphan"). Thumbnail click opens the asset in a new tab;
  a checkbox handles selection.
- **Selection & toolbar**: checkbox per card plus "Select all" =
  everything matching the current filter (fetches remaining pages first
  if `total` exceeds loaded). Toolbar shows "M selected" and activates
  **Export** (form-POST) and **Delete**.
- **Delete confirm**: always `ConfirmDialog` (never `window.confirm` —
  iPad PWA suppresses it). Loud when any selected asset is linked: lists
  each linked asset with its referencing page titles and states "removes
  N links from M blocks; blocks left empty are deleted". Calm confirm for
  orphan-only selections. Delete loops `DELETE` per sha, continues
  through failures, reports one end summary ("Deleted 17 of 19; failed:
  …"), then refetches.
- **Orphan workflow**: with the Orphans filter, each card offers
  **Copy link** — copies the markdown token (`![filename](url)` for
  images, `[filename](url)` otherwise) to the clipboard.
- **Scan**: toolbar button calls `POST /api/assets/scan`, reports
  "queued N" or the disabled reason inline, then refetches. No polling;
  a manual refresh button sits next to it.
- **Pagination**: "Load more" appends the next page; selection persists
  because loaded cards stay mounted.
- **Offline**: assets never enter the OPFS replica; offline, the view
  shows a "Files needs a connection" note instead of stale data.
- **FCIS**: query-string building, mime→category mapping, clipboard token
  formatting, confirm-message assembly, and batch-result summarising live
  in a functional-core `filesCore.ts`; the `Files` view is the imperative
  shell.

## Data flow & sync

- Reads hit `/api/assets/search` directly (online-only view, like
  unlinked references).
- Block-text edits from deletion ride the page-rename path: commit bumps
  the sync seq, `notify.nudge_threadpool` pokes the WebSocket hub,
  connected clients resync the changed blocks. An open page updates
  within a sync round-trip.
- Accepted edge: a client holding a dirty draft on a referencing block at
  delete time can win LWW and resurrect the link text — same behavior as
  rename today.
- Export and scan involve no client state; the grid refetches after
  mutating actions.

## Error handling & edge cases

- Row-without-file: DELETE still removes the row and strips links.
- Re-upload after delete: creates a fresh row; content addressing makes
  this naturally idempotent — no guard.
- Confirm-dialog ref counts are render-time values; the strip is by-sha,
  so correctness never depends on the displayed count.
- `from_ms > to_ms` → empty page, no error. `offset` past the end →
  empty page with correct `total`.
- Scan while describe is disabled: response carries `enabled:false` +
  reason, shown inline (same contract Settings uses).

## Testing

- **Server (pytest)**: search filter matrix (type/date/linked/offset/
  `total`, NULL `created_at`, orphan pagination correctness); DELETE
  strips each token form, deletes emptied leaf blocks, keeps emptied
  parents, updates FTS (end-to-end: a stripped/deleted block drops out of
  `refs` — pins the FTS delete trigger, per the pkm-t5pu carry-over),
  removes row+file, 404s unknown sha, tolerates missing disk file;
  export.zip contents, filename collisions, unknown-sha skip; strengthen
  `test_render_assets_tolerates_missing_refs_key` with
  `assert "in [[" not in out`.
- **Web unit (vitest)**: `filesCore.ts` pure functions; Files view render
  states (loading/empty/error/offline), filter→fetch wiring,
  select-all-across-pages, loud-vs-calm confirm, batch summary.
- **E2E (Playwright)**: upload two assets, link one from a POST-created
  unique page (never today's journal); filter to orphans, select all,
  delete via calm dialog; delete the linked asset via loud dialog listing
  the page, verify the token is stripped from the block and the asset
  404s; export a selection downloads a zip. Clipboard asserted via the
  patched-`writeText`/`window.__copied` trick.
- **Verification**: regen `openapi.json` + types; `cd server && uv run
  pytest -q && uv run pyrefly check && uv run ruff check`;
  `cd web && pnpm verify`.
