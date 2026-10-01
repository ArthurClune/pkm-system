---
# pkm-9km9
title: Server BlockUid / PageId / SidebarEntryId NewTypes, one ref-token regex, importer uid validation
status: completed
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T13:43:58Z
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

- [x] NewTypes `BlockUid`, `PageId`, `SidebarEntryId` (beside `Sha256Hex` in `contracts/ops.py` or a shared module), applied through contracts, store, ops and routes
- [x] `InsertBlock(kw_only=True)`; `dedupe_window` NamedTuple
- [x] Export one ref-token regex from `refs.py`; `render.py`, `export/markdown.py` and `export/resolve.py` use it. They then fall under the parity coverage `refs_parity_dump.py` already gives `refs.extract` against `scan.ts`.
- [x] Decide the length rule: bound ref tokens at 32 to match `UID_RE` on both sides (keep the parity dump agreeing), or record the difference as deliberate
- [x] Importer: check imported uids against `UID_RE` explicitly (a NewType is only a cast). Decide whether a bad uid rejects the import, or is reported and re-minted with its `((uid))` refs rewritten. Test with a short uid in a fixture export.
- [x] pyrefly + pytest clean


## Decisions (Arthur, 2026-10-01)

- Bad imported uid: **reject the whole import**, listing every offending uid with its page. No re-minting.
- Length rule: **bound ref tokens at 32 on both sides** (`{6,32}`, matching `UID_RE`). This changes ref-grammar parity: regenerate all three surfaces (see the regen checklist).

## Summary of Changes

- **Types.** `BlockUid`, `PageId` and `SidebarEntryId` are NewTypes in
  `contracts/ops.py`. They are not tagged with `brand()`; the web side is
  pkm-thee. They are threaded through `contracts/responses.py`, `store.py`,
  `ops_core.py`, `ops_apply.py`, `client/api.py`, `routes_pages.py`,
  `routes_sidebar.py` and `sync_core.py`.
  - Mint points: the uid minters, the SQLite row mappers, `lastrowid`, and
    the UID_RE validation sites.
  - `SidebarEntryId` is kept separate from `PageId`.
  - `InsertBlock` is `kw_only=True`. `dedupe_window` takes a `ChangeRow`
    NamedTuple, built with keyword arguments.
- **One ref-token shape.** `refs.BLOCK_REF_TOKEN = [a-zA-Z0-9_-]{6,32}` is
  shared by `refs.extract`, `render.py` (which was `[\w-]+`, Unicode-aware,
  with no minimum length), `export/markdown.py` and `export/resolve.py`.
  `contracts.ops.UID_RE` is built from it as `^…\Z`. On the web,
  `grammar/scan.ts` exports `UID_TOKEN`, which `replica/localApi/router.ts`
  and `assistant/normalizeRefs.ts` build from. That narrows `normalizeRefs`
  from `{6,}` to `{6,32}`. The `((^` rejection is unchanged.
  - Fixtures: `ref_grammar.json` and `refs_parity.json` were regenerated with
    32- and 33-character cases. `shim_parity.json` was regenerated with no
    diff.
  - A prod check showed every one of the 56,527 uids already fits `{6,32}`,
    and no block text has a token longer than 32 characters.
- **Importer.** `preflight.validate_export_uids` refuses the whole import
  before anything is written, and lists every offending uid with its page.
  That covers page children, orphan subtrees, and a uid that isn't a string.
  No uid is re-minted.
- **Pre-existing bug fixed** (found by the Opus review). `UID_RE` ended in
  `$` and three `ops_core.py` sites used `.match`, so a uid of `"abcdef\n"`
  passed, and a create stored a block nothing could reference. The pattern
  now ends in `\Z` and every site uses `fullmatch`. Failing tests came first,
  and there is a troubleshooting row.
- **Docs.** `backend.md`, `import-export-and-backup.md`, `frontend.md`
  (scan.ts) and `troubleshooting.md`.
- **Checks.** pytest: 2287 passed. pyrefly: 0 errors, unchanged from main.
  ruff and tsc are clean. `pnpm verify` is green, with 3065 unit tests and
  72 e2e tests. `perf/check.sh`: no changes against the baseline, backend and
  frontend. `openapi.json` is unchanged.
