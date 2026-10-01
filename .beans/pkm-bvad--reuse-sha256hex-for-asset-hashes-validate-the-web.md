---
# pkm-bvad
title: Reuse Sha256Hex for asset hashes; validate the web asset sha
status: todo
type: task
priority: low
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T07:44:38Z
parent: pkm-7uxw
---

Asset content hashes have the same format as the existing `Sha256Hex` type, but reuse neither it nor its validation.

- Server: `_SHA_RE` is re-declared at `server/src/pkm/server/routes_assets.py:39` and checked at `:178,236,276`; minted at `:308-323`. `assets_core.py:68` returns plain `str`. Wire fields: `AssetUploadResponse.sha256` and `AssetSearchItem.sha256` (`contracts/responses.py:217,231`), plus the title-migration `digest`/`audit_digest` (`:422,428,432`, already regex-pinned to 64 hex).
- Web: no validation at all. `sha: parts[1]` is sliced from the URL (`web/src/grammar/tokenize.ts:189`) and feeds both a URL and an FTS query (`components/AssetLink.tsx:6-26`); also `views/Files.tsx:42-51`.
- The importer returns a confusable pair, `(used: frozenset[str], missing: frozenset[str])` (hashes vs URLs) (`importer/assets.py:33-56`, `importer/run.py:129-133`).

## Plan

- [ ] Server: `Sha256Hex` on asset hash fields and `assets_core` returns; one shared hex regex
- [ ] Web: validate `sha` at `grammar/tokenize.ts:189` and mint `Sha256Hex` there; test with a non-hex asset URL
- [ ] Importer: name the two sets (a NamedTuple, or `Sha256Hex` vs a URL type)
