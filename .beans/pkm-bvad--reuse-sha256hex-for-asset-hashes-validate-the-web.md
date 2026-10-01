---
# pkm-bvad
title: Reuse Sha256Hex for asset hashes; validate the web asset sha
status: completed
type: task
priority: low
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T14:18:56Z
parent: pkm-7uxw
---

Asset content hashes have the same format as the existing `Sha256Hex` type, but reuse neither it nor its validation.

- Server: `_SHA_RE` is re-declared at `server/src/pkm/server/routes_assets.py:39` and checked at `:178,236,276`; minted at `:308-323`. `assets_core.py:68` returns plain `str`. Wire fields: `AssetUploadResponse.sha256` and `AssetSearchItem.sha256` (`contracts/responses.py:217,231`), plus the title-migration `digest`/`audit_digest` (`:422,428,432`, already regex-pinned to 64 hex).
- Web: no validation at all. `sha: parts[1]` is sliced from the URL (`web/src/grammar/tokenize.ts:189`) and feeds both a URL and an FTS query (`components/AssetLink.tsx:6-26`); also `views/Files.tsx:42-51`.
- The importer returns a confusable pair, `(used: frozenset[str], missing: frozenset[str])` (hashes vs URLs) (`importer/assets.py:33-56`, `importer/run.py:129-133`).

## Plan

- [x] Server: `Sha256Hex` on asset hash fields and `assets_core` returns; one shared hex regex
- [x] Web: validate `sha` at `grammar/tokenize.ts:189` and mint `Sha256Hex` there; test with a non-hex asset URL
- [x] Importer: name the two sets (a NamedTuple, or `Sha256Hex` vs a URL type)

## Summary of Changes

- **Server.** One shared `SHA256_HEX_RE` (`^[0-9a-f]{64}\Z`) in
  `contracts/ops.py` replaces the private `_SHA_RE` in `routes_assets.py`.
  - Body fields keep a `$`-anchored `Field(pattern=…)`, because pydantic's
    regex engine rejects `\Z`.
  - Five wire fields are now `Sha256Hex`: `AssetUploadResponse.sha256`,
    `AssetSearchItem.sha256`, and the title-migration `digest` and
    `audit_digest` fields. All of them carry the `x-brand` marker.
  - Mint points: `assets_core.sha256_hex`, `title_migration._plan_digest`,
    rows read from `assets.sha256`, and validated route params.
- **Web.** The existing 64-hex capture in `grammar/tokenize.ts` mints
  `Sha256Hex` for the `asset-link` segment's `sha`, which `AssetLink.tsx` and
  `views/Files.tsx` now carry. A non-hex segment stays plain text, and an
  external URL that merely contains `/assets/` still tokenizes as a plain
  link (a new test).
  - A prod check showed every app `/assets/<sha>/` link (1,666) and every
    stored `assets.sha256` (1,653) is valid hex. The only non-hex `/assets/`
    segments are three external URLs.
- **Importer.** `rewrite_asset_urls` returns an
  `AssetUrlRewrite(used: frozenset[Sha256Hex], missing: frozenset[str])`
  NamedTuple instead of a confusable 2-tuple.
- **Docs.** `files-and-assets.md`.
- **Checks.** pytest: 2287 passed. pyrefly: 0 errors, unchanged from main.
  ruff and tsc are clean. `pnpm verify` is green, with 3067 unit tests and
  72 e2e tests. `perf/check.sh`: no changes against the baseline, backend and
  frontend (run after main was merged in).
