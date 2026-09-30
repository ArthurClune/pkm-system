# Typed op hashes (pkm-r5ra)

Agreed with Arthur 2026-09-30 while brainstorming pkm-nny8; built on the same
branch, as its first task, so `DeleteOp.base_subtree_hash` is typed from the
start. Spec for that work:
`docs/superpowers/specs/2026-09-30-hash-guarded-delete-design.md`.

## Problem

The op hash fields are bare strings: `UpdateTextOp.base_text_hash` is `str`
with a 64-length check (`server/src/pkm/contracts/ops.py`), and the web side
is a plain `string`. A hash and a text are both strings, so passing a text
where a hash belongs (`base_text_hash=text`) type-checks on both sides, and
the server would read it as a stale hash and land a spurious conflict.

## Outcome

A type checker rejects a non-hash value in a hash field on both sides. The
wire format, the OpenAPI schema and the generated `types.d.ts` stay
byte-identical.

## Design

| | Python (`contracts/ops.py`) | Web |
|---|---|---|
| Type | `Sha256Hex = NewType("Sha256Hex", str)` | `type Sha256Hex = string & { readonly __brand: "Sha256Hex" }` in `web/src/replica/sha256.ts` |
| Producers (the only places a hash is minted) | `text_hash`, `subtree_hash` return it | `sha256Hex`, `subtreeHash` return it |
| Fields | `UpdateTextOp.base_text_hash: Sha256Hex \| None`, `DeleteOp.base_subtree_hash: Sha256Hex \| None`, same `Field(default=None, min_length=64, max_length=64)` | `web/src/api/ops.ts` narrows the generated `UpdateTextOp` and `DeleteOp` so those two fields are `Sha256Hex \| null \| undefined`; everything else stays the generated type |

- Pydantic treats a `NewType` as its base type, so validation and the schema
  are unchanged; `tests/test_openapi_sync.py` proves the dump is identical.
- The branded web op types stay assignable to the generated wire types (a
  brand is a subtype of `string`), so the queue, lane and API layer need no
  casts. Ops parsed back from JSON (`pending_ops`, the lane) are already cast
  to `BlockOp[]` at that boundary; that cast is the only trust point.
- No runtime hex pattern: on an existing field, a queued batch with a bad
  value would 422 and poison the queue, and the length check already exists.
- Hashes read from server tables (`block_rewrites.base_hash` / `after_hash`)
  and compared as strings stay `str`: comparing `str` with `Sha256Hex` is
  fine, and typing the rewrite chain would reach well past the op contract.
- Test literals that stand in for a hash (`"deadbeef"`, `"a" * 64`) wrap
  in `Sha256Hex(...)` / `as Sha256Hex`.

## Testing

A type check is the test. Each side gets one negative check that fails to
compile when the type is removed:

- Python: `typing.assert_type(text_hash("x"), Sha256Hex)`, which pyrefly
  checks statically, and a runtime assertion that
  `UpdateTextOp.model_fields["base_text_hash"].annotation` is
  `Sha256Hex | None`.
- Web: a `// @ts-expect-error` assigning a plain `string` to
  `UpdateTextOp["base_text_hash"]`, which fails `pnpm typecheck` if the brand
  is removed.

Then `pyrefly`, `ruff`, `pnpm typecheck`, and the OpenAPI/`types.d.ts` diff
must be empty.

## Docs

`docs/architecture/backend.md` or `sync-and-offline.md`, wherever
`base_text_hash` is introduced: one clause saying both hash fields are
`Sha256Hex` and minted only by `text_hash` / `subtree_hash` (and their web
twins).
