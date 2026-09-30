---
# pkm-r5ra
title: Named Sha256Hex type for op hash fields
status: todo
type: task
priority: low
created_at: 2026-09-30T10:50:05Z
updated_at: 2026-09-30T10:50:05Z
---

Op hash fields are bare strings: `UpdateTextOp.base_text_hash` is `str` with a 64-length check (`server/src/pkm/contracts/ops.py`), and the web side is a plain `string`. A hash and a text are both `str`, so passing a text where a hash belongs (`base_text_hash=text`) type-checks on both sides. `DeleteOp.base_subtree_hash` (pkm-nny8) adds a second such field.

Agreed shape (2026-09-30, while brainstorming pkm-nny8), no wire change:

- Python: a `Sha256Hex` type in `contracts/ops.py` (`NewType` over `str`, carried with the existing length-64 `Field` constraint) for both hash fields; `text_hash()` and `subtree_hash()` are its only producers. OpenAPI output unchanged, so the generated web types do not move.
- Web: a branded `type Sha256Hex = string & { readonly __brand: "Sha256Hex" }` returned only by `sha256Hex()` / `subtreeHash()`; the stampers write it into ops.
- No runtime hex pattern: on an existing field a queued batch with a bad value would 422 and poison the queue; the length check already exists.

- [ ] Python `Sha256Hex` on both hash fields; producers return it
- [ ] Web branded `Sha256Hex`; stampers and hash helpers typed with it
- [ ] openapi.json / gen-types diff is empty
