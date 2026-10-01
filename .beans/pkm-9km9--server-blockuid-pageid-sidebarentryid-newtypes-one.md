---
# pkm-9km9
title: Server BlockUid / PageId / SidebarEntryId NewTypes, one ref-token regex, importer uid validation
status: todo
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T07:44:38Z
parent: pkm-7uxw
---

Server-side NewTypes for the main identifiers, plus the explicit fixes for the ref-token regex divergence. That divergence is a latent risk that a `BlockUid` NewType alone doesn't touch.

Paths are relative to `server/src/pkm/`.

## Types

- **`BlockUid`** (`str`). Validated by `UID_RE` `{6,32}` (`contracts/ops.py:20`). Minted at `server/ops_apply.py:48-55` and `client/api.py:81-88`, and taken from the import at `importer/parse_export.py:93` (unchecked). About 96 sites, e.g. `contracts/ops.py:33,38,66,76`, `contracts/responses.py:31,327`, `server/routes_pages.py:53-112`.
- **`PageId`** (`int`). `pages.id`; minted by SQLite (`server/store.py:66-73`) and hand-assigned by the importer (`importer/rows.py:121-126`). Swap shapes: `InsertBlock(uid, page_id, parent_uid, order_idx, text, heading)` (`server/ops_core.py:469-477`, built positionally at `:368,571,577,580,697`), `_backlinks(db, page_id, offset, limit)` (`server/routes_pages.py:115`).
- **`SidebarEntryId`** (`int`), distinct from `PageId`: `sidebar_entries` has its own `INTEGER PRIMARY KEY` (`schema.py:117-121`); see `server/routes_sidebar.py:63` and `SyncSidebarEntry.id`.
- **`InsertBlock(kw_only=True)`**, and a `NamedTuple` for the `dedupe_window` `(seq, kind, entity_id, deleted)` 4-tuple (`server/sync_core.py:79`). Both fix positional construction that NewTypes can't (two `str` uids, three ints).

## Ref-token regex and imported uids (latent)

Five definitions of a block-uid token disagree:
- `refs.py:34` and web `grammar/scan.ts:57`: `[a-zA-Z0-9_-]{6,}`
- `render.py:26`: `[\w-]+` (Unicode `\w`, no minimum)
- `export/markdown.py:16` and `export/resolve.py:34`: `[A-Za-z0-9_-]+` (no minimum)
- `UID_RE` (`contracts/ops.py:20`, web `replica/localApi/router.ts:31`): `{6,32}`

This is safe today only because every substituter leaves a map miss untouched and every uid has at least 6 characters. The importer never checks `UID_RE`, so a short or odd imported uid would resolve in render and export while the app and backlinks ignore it.

## Plan

- [ ] NewTypes `BlockUid`, `PageId`, `SidebarEntryId` (beside `Sha256Hex` in `contracts/ops.py` or a shared module), applied through contracts, store, ops and routes
- [ ] `InsertBlock(kw_only=True)`; `dedupe_window` NamedTuple
- [ ] Export one ref-token regex from `refs.py`; `render.py`, `export/markdown.py` and `export/resolve.py` use it. They then fall under the parity coverage `refs_parity_dump.py` already gives `refs.extract` against `scan.ts`.
- [ ] Decide the length rule: bound ref tokens at 32 to match `UID_RE` on both sides (keep the parity dump agreeing), or record the difference as deliberate
- [ ] Importer: check imported uids against `UID_RE` explicitly (a NewType is only a cast). Decide whether a bad uid rejects the import, or is reported and re-minted with its `((uid))` refs rewritten. Test with a short uid in a fixture export.
- [ ] pyrefly + pytest clean
