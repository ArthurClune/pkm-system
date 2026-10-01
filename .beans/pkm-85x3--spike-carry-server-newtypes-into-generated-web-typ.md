---
# pkm-85x3
title: 'Spike: carry server NewTypes into generated web types as brands (x-brand gen-types transform)'
status: completed
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T12:06:43Z
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

- [x] Brainstorm/spec when picked up (it changes the codegen pipeline)
- [x] Prove on `Sha256Hex` end to end: replace the `api/ops.ts` hand alias with the generated brand
- [x] Check that pydantic validation is unchanged and `openapi.json` still diffs cleanly
- [x] Update the regen instructions wherever gen-types is documented

## Summary of Changes

A server NewType tagged with `brand()` now reaches the web's generated types
as a branded type. The spec is
`docs/superpowers/specs/2026-10-01-x-brand-gen-types-design.md` and the plan
is `docs/superpowers/plans/2026-10-01-x-brand-gen-types.md`.

- **Server.** `contracts/brands.py` provides `brand(nt)`, which attaches
  pydantic hooks. Validation stays exactly the supertype's, and the JSON
  schema gains `"x-brand": "<Name>"` beside the existing constraints. Call it
  in its own statement after the `NewType`, because pyrefly loses the type if
  the call is wrapped. Subtypes are branded explicitly, and a test covers the
  NewType-of-NewType case.
- **Generator.** `pnpm gen-types` now runs `web/tooling/genTypes.mjs`, the
  shell, with `genTypes-core.mjs` as the pure core. Before generating,
  `checkBrandMarkers` rejects any malformed marker anywhere in the spec: one
  that isn't an identifier, sits on a schema that isn't string or integer, or
  appears beside `nullable`, `enum` or `const`. The `transform` hook then
  emits `Brands.<Name>`, and `inject` adds the
  `import type * as Brands from "./brands"` line.
- **Web.** `api/brands.ts` is the one place each brand is defined, and its
  header documents the subtype pattern (a second brand key).
  `replica/sha256.ts` re-exports `Sha256Hex` from it. The two `Omit<…> & {…}`
  aliases in `api/ops.ts` are gone.
- **Guards added during implementation and review:**
  - `tsconfig.apitypes.json` adds a second tsc pass, because `skipLibCheck`
    meant a `Brands.<Name>` with no definition silently became `any`.
    `pnpm typecheck` and `build` both run it.
  - `genTypes.drift.test.ts` checks that the committed `types.d.ts` equals the
    generator's output, so a regen with the stock CLI fails.
  - `@ts-expect-error` probes in `api/ops.test.ts` show a plain string can't
    stand in for a hash.
- **Proof.** `brand(Sha256Hex)` adds 2 marker lines to `openapi.json`.
  `types.d.ts` gains the import, and two fields change to
  `Brands.Sha256Hex | null`. Nothing else in the generated output changed.
- **Checks.** pytest: 2263 passed. pyrefly: 0 errors, with suppressions and
  warnings unchanged from main. ruff and tsc are clean. `pnpm verify` is green,
  including 72 e2e tests. `perf/check.sh`: no changes against the baseline,
  backend and frontend. An Opus whole-branch review found nothing serious, and
  its five low findings are fixed.
