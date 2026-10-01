---
# pkm-85x3
title: 'Spike: carry server NewTypes into generated web types as brands (x-brand gen-types transform)'
status: in-progress
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T11:35:00Z
parent: pkm-7uxw
---

Spike: carry server-side NewTypes into `web/src/api/types.d.ts` as branded types, so the web gets `BlockUid`, titles, `PageId` and so on without a hand alias per field.

## Problem

A Python `NewType` changes nothing in JSON Schema. `base_text_hash: Sha256Hex` (`server/src/pkm/contracts/ops.py:53`) arrives as `string`, and the web re-brands it by hand (`web/src/api/ops.ts:8-18`, `Omit<…> & { base_text_hash?: Sha256Hex | null }`). That works for a few fields but drifts as fields are added, so it doesn't scale to uids and titles.

## Candidate approach

- Each Py alias carries a schema marker, e.g. `Annotated[BlockUid, WithJsonSchema({"type": "string", "x-brand": "BlockUid"})]`, so the dump from `server/src/pkm/server/openapi_dump.py` includes it.
- Replace the CLI call in `web/package.json:17` (`openapi-typescript … -o src/api/types.d.ts`) with a small Node script that uses openapi-typescript's `transform` hook to emit `string & { readonly __brand: "BlockUid" }` for marked schemas.
- Inline brands are structurally identical to the hand-written `Sha256Hex`, so `types.d.ts` needs no imports.
- For subtype brands (`CanonicalTitle` ⊂ `NormalizedTitle`), use a second brand key: two different literal `__brand` values intersect to `never`.

Rejected alternative: a field-name mapped type in `web/src/api/typedClient.ts:25-60`. It would be name-based, and `id` means `PageId` in one place and `SidebarEntryId` in another.

## Plan

- [ ] Brainstorm/spec when picked up (it changes the codegen pipeline)
- [ ] Prove on `Sha256Hex` end to end: replace the `api/ops.ts` hand alias with the generated brand
- [ ] Check that pydantic validation is unchanged and `openapi.json` still diffs cleanly
- [ ] Update the regen instructions wherever gen-types is documented
