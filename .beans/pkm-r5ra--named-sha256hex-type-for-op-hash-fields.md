---
# pkm-r5ra
title: Named Sha256Hex type for op hash fields
status: completed
type: task
priority: low
created_at: 2026-09-30T10:50:05Z
updated_at: 2026-09-30T11:37:48Z
parent: pkm-a4t2
---

Op hash fields are bare strings: `UpdateTextOp.base_text_hash` is `str` with a 64-length check (`server/src/pkm/contracts/ops.py`), and the web side is a plain `string`. A hash and a text are both `str`, so passing a text where a hash belongs (`base_text_hash=text`) type-checks on both sides. `DeleteOp.base_subtree_hash` (pkm-nny8) adds a second such field.

Agreed shape (2026-09-30, while brainstorming pkm-nny8), no wire change:

- Python: a `Sha256Hex` type in `contracts/ops.py` (`NewType` over `str`, carried with the existing length-64 `Field` constraint) for both hash fields; `text_hash()` and `subtree_hash()` are its only producers. OpenAPI output unchanged, so the generated web types do not move.
- Web: a branded `type Sha256Hex = string & { readonly __brand: "Sha256Hex" }` returned only by `sha256Hex()` / `subtreeHash()`; the stampers write it into ops.
- No runtime hex pattern: on an existing field a queued batch with a bad value would 422 and poison the queue; the length check already exists.

- [x] Python `Sha256Hex` on `base_text_hash`; `text_hash()` returns it (`base_subtree_hash` / `subtree_hash()` land with `DeleteOp` in Task 2, already typed against the same `Sha256Hex`)
- [x] Web branded `Sha256Hex`; `sha256Hex()` and the `UpdateTextOp` narrowing in `api/ops.ts` typed with it (`subtreeHash()` and `DeleteOp` follow in Task 2)
- [x] openapi.json / gen-types diff is empty

## Summary of Changes

Implemented as Task 1 of the hash-guarded-delete plan. `Sha256Hex` now exists
on both sides (`NewType` in `contracts/ops.py`; a branded `string` in
`web/src/replica/sha256.ts`), minted only by `text_hash` / `sha256Hex`, and
`UpdateTextOp.base_text_hash` is typed with it end to end (the Pydantic
field, the narrowed `web/src/api/ops.ts` type, and every test literal that
stood in for a hash, now `Sha256Hex(...)` / `as Sha256Hex`). The wire format
is unchanged: the `openapi.json` / `types.d.ts` diff after regen is empty,
and the full server and web suites pass. `DeleteOp.base_subtree_hash` /
`subtree_hash` / `subtreeHash` (Task 2, pkm-nny8) reuse this same type.

Spec: docs/superpowers/specs/2026-09-30-typed-op-hashes-design.md. Built as Task 1 of docs/superpowers/plans/2026-09-30-hash-guarded-delete.md (Arthur, 2026-09-30), on the pkm-nny8 branch.
