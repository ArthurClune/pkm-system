---
# pkm-aa5q
title: pyrefly lets a plain str reach a branded pydantic field at construction
status: todo
type: task
priority: normal
created_at: 2026-10-19T17:40:04Z
updated_at: 2026-10-19T17:40:04Z
---

pyrefly accepts a plain `str` (or `int`) for a pydantic model field typed
with a branded NewType at construction: `CreateOp(page_title=some_str)`
type-checks even though `page_title: RawTitle`. Pydantic `__init__` is
checked loosely, so a brand on a model field protects readers of the field
but not its producers. Found during pkm-hc95 (a reviewer probe in
server/src gave 0 pyrefly errors); it applies to every server brand
(BlockUid, PageId, ...), not only titles. backend.md documents the gap.

Options to weigh: pyrefly's pydantic support/strictness settings; a
brandlint rule that flags a model constructor keyword named like a brand
(NAMES) whose argument is not that brand (the AST lint can't see types, so
probably only literals/untyped names); or constructing models through typed
factory functions.

- [ ] confirm the gap with a minimal probe and check pyrefly options
- [ ] decide the enforcement point
- [ ] implement with teeth tests
