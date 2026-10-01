---
# pkm-7uxw
title: Named types for bare primitives (2026-10-01 review)
status: completed
type: epic
priority: normal
created_at: 2026-10-01T07:44:26Z
updated_at: 2026-10-01T20:55:22Z
---

## Context

On 2026-10-01 a read-only review looked across `server/src` and `web/src` for bare primitives (`str`, `int`, `list[str]`, `string`, `number`, `string[]`) that carry a domain meaning and should be named types. Nine reviewers each covered one slice, and a consolidation pass checked every claimed bug against the code. No code was changed. The children of this epic are the groups of work, in roughly the order below.

Today the only named primitive is `Sha256Hex`: `NewType` in `server/src/pkm/contracts/ops.py:28`, branded in `web/src/replica/sha256.ts:26`. New types should follow that style.

## Findings that shaped the plan

- **Five real bugs share one cause:** a page title reaches an exact `title = ?` match without going through `canonicalize_title`. One is live in prod, where plain-space canonicalization is on. They are fixed directly, before any typing.
- **Typing alone fixes none of the latent risks.** The tombstone `else` fallback, the divergent ref-token regexes plus unvalidated imported uids, and the synthetic `page_id` in asset ref groups each need an explicit code change.
- **There are exactly three title forms.** Section 3 of the plan below names them.

  | form | name | minted by | used as |
  |---|---|---|---|
  | as typed: URL, request body, CLI/MCP arg | plain `str`/`string` (free text, no brand) | n/a | route path params, `RenamePageRequest.new_title`, `titleFromPathname` |
  | control whitespace collapsed | `NormalizedTitle` | `refs.normalize_title` (`server/src/pkm/refs.py:44`), `normalizeRefTitle` (`web/src/grammar/scan.ts:50`) | `Ref.title`, link label and href (`grammar/tokenize.ts:97`) |
  | normalized, plus edge U+0020 stripped iff the DB flag is on (`server/sync_meta.py:7`, `replica/meta.ts`) | `CanonicalTitle` (subtype of `NormalizedTitle`) | `canonicalize_title` (`refs.py:64`), `canonicalizeTitle` (`replica/titles.ts:52`), every `pages.title` read | `store.fetch_page`, `pages.title`, `sidebar_entries.title`, `PageMeta.title`/`SyncPage.title` |

- **The OpenAPI edge limits what reaches the web.** A Python `Literal` reaches the generated TS as a union for free, but a `NewType` arrives as plain `string`/`number`. Today the web re-brands by hand (`web/src/api/ops.ts:8-18`). Branding uids and titles across the whole web needs a gen-types transform keyed on an `x-brand` schema marker (the spike child), not hand aliases.
- **`SidebarEntryId` is distinct from `PageId`.** `sidebar_entries` has its own `INTEGER PRIMARY KEY` (`server/src/pkm/schema.py:117-121`).
- **Don't brand the local counters named `seq`/`generation`.** `SyncSeq` is the server's `changes.seq` only; `sync/outbox.ts` lane seq, `SyncProvider.tsx` `resyncSeq` and the per-view `generation` guards are different things.

## Order

1. pkm-dapm: title-lookup bug fix (no typing; A1 is live in prod)
2. pkm-38w9: closed-set Literals, plus the tombstone dispatch fix
3. pkm-izm4: asset ref-group synthetic page_id (independent)
4. pkm-1v8b: server title NewTypes (after pkm-dapm)
5. pkm-9km9: server BlockUid / PageId / SidebarEntryId, plus the ref-token regex and importer uid validation
6. pkm-he87: web worker brands (PendingRowId, SyncSeq)
7. pkm-85x3: spike, brands through gen-types
8. pkm-iskx: web BatchId / ClientId
9. pkm-thee: web titles / BlockUid / PageId (after pkm-1v8b, pkm-9km9, pkm-85x3, pkm-izm4)
10. Anytime, low priority: pkm-bvad (Sha256Hex reuse for assets), pkm-s6q3 (slice-local types), pkm-la88 (EpochMs / OrderIdx, deferred)

## Considered and rejected

`MimeType` (an open set; the closed parts are already runtime frozensets), `IsoDate`/`JournalDay` (`since`/`until` accept two formats by design), `Generation`, `RecoveryToken`, hex-secret NewTypes on `Config`, Bluesky `Did`, `HttpStatusCode`, pagination offset/limit, separate self/parent uid types (use keyword args instead), a brand on raw titles (they are free text), pixel x/y.

## Summary of Changes

All 13 children are complete.

- **Bugs fixed:**
  - title lookups that skipped canonicalisation (pkm-dapm);
  - the tombstone fallback, which no longer deletes anything for an unknown kind (pkm-38w9);
  - the synthetic `page_id` in asset ref groups (pkm-izm4);
  - importer uid validation and one ref-token regex (pkm-9km9);
  - the sidebar panel keyed by the requested title (pkm-thee);
  - CLI/MCP appends landing mid-list under gapped order keys (pkm-la88).
- **Named types:**
  - on the server: `NormalizedTitle` / `CanonicalTitle`, `BlockUid` / `PageId` / `SidebarEntryId`, `SyncSeq`, `BatchId` / `ClientId`, `Sha256Hex`, `OrderIdx` and the slice-local ids, plus Literals for closed-set strings;
  - carried to the web as brands by the x-brand gen-types pipeline (pkm-85x3), plus web-only `PendingRowId` and the typed replica worker RPC map (pkm-ke5j);
  - EpochMs was not branded: keyword-only and named arguments plus the `mono_ms` rename instead.
- **Follow-ups outside the epic:** pkm-z2qa (two outline sessions for a non-canonical title; deferred), pkm-78fk (batch `index` meaning), pkm-c1hj (perf harness under load).
