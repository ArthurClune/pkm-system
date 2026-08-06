# Block reference indicator (pkm-d31f) — design

**Bean:** pkm-d31f · **Date:** 2026-08-06 · **Status:** approved design

Blocks that are referenced by other blocks (via `((uid))`) show a count badge
in the right gutter. Clicking the badge opens a popover listing the places
that reference the block, backlink-style, with navigation.

## Decisions made during brainstorming

| Question | Decision |
|---|---|
| Popup content | Backlink-style entries (page title, ancestor breadcrumb, formatted block text); clicking navigates |
| Count freshness | Page-payload freshness — no live recompute on local edits; popup fetch is live-at-open |
| Badge visibility | Always visible when count ≥ 1, on all devices (not hidden on phones, unlike `.block-stamp`) |
| Architecture | Write-time index (`block_refs` table), mirroring the page-refs pattern |
| Count semantics | Distinct referencing **blocks**, not mention count (two `((uid))`s in one block = 1) |
| Surfaces | Page view and journal. Sidebar panels and CLI/MCP `get` are explicit non-goals (follow-up bean if wanted) |

## Data layer

New table in `BASE_DDL` (`server/src/pkm/schema.py`), replayable:

```sql
CREATE TABLE IF NOT EXISTS block_refs(
  src_block_uid    TEXT NOT NULL REFERENCES blocks(uid) ON DELETE CASCADE,
  target_block_uid TEXT NOT NULL,
  PRIMARY KEY (src_block_uid, target_block_uid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_block_refs_target ON block_refs(target_block_uid);
```

No FK on `target_block_uid`: an unresolved `((uid))` is a legal state (it
already renders unresolved), so dangling rows are permitted and simply never
match a count query.

**Maintenance — the same choke points that maintain `refs`:**

- Server: `ops_apply.py` deletes + reinserts a block's `block_refs` rows on
  every text write. It already calls `extract()` and currently discards
  `.block_refs`.
- Client (local edits): `web/src/replica/localOps.ts`, which already has
  `extractRefs(text).blockRefs` in hand.
- Client (sync apply): the sync applier derives `block_refs` from each
  applied block's text. **Block refs are never shipped over sync.** Page refs
  ship only because `target_page_id` needs title→id resolution and dependency
  pages; block refs target uids directly, and the extractor is parity-pinned
  on both sides (`shared/fixtures/refs_parity.json`), so local derivation is
  guaranteed to match the server.

**Migration / backfill:**

- The BASE_DDL change bumps the generated schema hash
  (`web/src/replica/baseSchema.gen.ts`), so every client replica rebootstraps
  from snapshot automatically; the applier fills `block_refs` as it applies.
  Clients need no explicit backfill.
- Server: a one-time historical catch-up at startup — iterate existing block
  text through `extract()` and populate the table, in one guarded
  transaction. Guard is a marker in `sync_meta` (not "table is empty": an
  empty table is legitimate for a graph with no block refs). Same pattern as
  the title migration. On failure the server refuses to start — a
  half-filled index that silently undercounts is worse than a loud stop.
- The Roam importer populates `block_refs` when building a fresh database.

## API & parity

**Counts.** Payloads that ship an editable outline gain a sibling field to
`block_ref_texts`:

```
block_ref_counts: { [uid]: n }    // only uids with n ≥ 1
```

- `GET /api/page/{title}` — one GROUP BY against `idx_block_refs_target`
  over the page's uids.
- `GET /api/journal` — same, one payload-level map covering all days'
  blocks (uids are globally unique; per-day maps would add structure for
  nothing).

**Popup.** New endpoint:

```
GET /api/block/{uid}/backlinks  →  { groups: [...] }
```

- Backlink-shaped: reuses `group_backlinks` + `_fetch_ancestors`, grouped by
  source page, ordered like page backlinks.
- No pagination: counts are small and nothing user-visible truncates
  silently in this project.
- Semantics mirror `GET /api/block/{uid}`: 422 malformed uid, 404 unknown
  block. Empty `groups` is legal (a stale badge can race a deleted ref).
- Named `backlinks` to stay distinct from the existing outbound resolver
  `GET /api/block-refs`.

**Parity artifacts (mechanical, enforced by the server test suite):**

- `web/src/api/openapi.json` regen + `pnpm gen-types` (new field, new route).
- Offline shim mirrors byte-identically: counts in
  `web/src/replica/localApi/pages.ts` and `journal.ts`; the new route in
  `router.ts`; `shared/fixtures/shim_parity.json` regen.

## Frontend

**Badge** (in `EditableBlockTree`):

- `<button class="block-ref-badge">` rendered only when count ≥ 1. Row
  order: `[bullet] [text] [badge] [stamp-cell]`.
- Layout interaction with the timestamp column (pkm-4ler): the stamp column
  stays the fixed rightmost `flex: 0 0 56px` cell; the badge sits just
  inside it, borrowing width from the flexible text column only on rows
  where it appears. Stamp alignment is unaffected; the stamp's existing
  `margin-left: 10px` separates the two. With stamps off, the badge is the
  rightmost element.
- Not hidden in the phone media query (unlike `.block-stamp`) — it is the
  only route to the popup on touch devices.
- Low-ink styling from existing tokens (`--color-text-muted`,
  `--color-bg-subtle`, `--radius-control`): a muted pill showing the number.
  Title attribute "N references". The stamp's freshness tint stays the
  louder signal on rows with both.
- Click stops propagation (must not focus/edit the block) and opens the
  popover; real button, keyboard-reachable.

**Popover:**

- Anchored by the badge, following the existing `BlockMenu` popover pattern
  (outside-click / Escape dismiss). Mind the portal-bubbling gotcha
  (interactive islands).
- Content reuses the `BacklinksSection` group renderer — same precedent as
  `JournalDayReferences`; no second renderer. Entries navigate to the source
  page and close the popover.
- Fetches `GET /api/block/{uid}/backlinks` lazily on open via `typedClient`;
  offline the shim serves it identically.
- Fetch failure shows a verbose inline error in the popover (fail-verbose
  posture); reopening retries.

**Data flow:** `PageView` / `Journal` thread `block_ref_counts` down the
tree like the existing `stamps` / `nowMs` props. Badge count is
payload-fresh; the popup is live truth; no reconciliation between them.

**FCIS:** count/grouping logic in Functional Core files; routes, applier and
fetch in Imperative Shells. New files carry pattern headers.

## Docs to update in the same branch

- `docs/architecture/backend.md` — API table: new route, new payload field.
- `docs/architecture/frontend.md` — module map: popover component; badge in
  the outline description.
- `docs/architecture/styling.md` — badge class if it earns a control class.
- `docs/architecture/sync-and-offline.md` — short note: `block_refs` is
  client-derived from text, never synced.

## Testing

- **Server** (`cd server && uv run pytest -q`, coverage enforced):
  `ops_apply` maintains rows on create/update/delete (and cascade on block
  delete); backfill fills historical rows, is guarded, runs once; count
  query shape; endpoint 422/404/empty-groups/group shape. Parity tests force
  the artifact regens.
- **Web unit** (`cd web && pnpm test:unit`): applier derivation on sync
  apply; `localOps` maintenance; badge renders only when count ≥ 1 and stops
  propagation; popover open → fetch → render with a fake client; count-map
  threading through page and journal views.
- **E2E** (one Playwright spec in `web/e2e/`): page B references a block on
  page A → badge "1" on A → click → popover lists B's block with page title
  → click navigates to B. Respect the established gotchas (build before
  e2e, never write today's journal, `waitForServerText`).
- Full gates before done: server pytest + pyrefly + ruff; `pnpm verify`.
