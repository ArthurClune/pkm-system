---
# pkm-aa5q
title: pyrefly lets a plain str reach a branded pydantic field at construction
status: todo
type: task
priority: normal
created_at: 2026-10-19T17:40:04Z
updated_at: 2026-10-20T12:18:47Z
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

- [x] confirm the gap with a minimal probe and check pyrefly options
- [ ] decide the enforcement point
- [ ] implement with teeth tests

## Probe results (2026-10-20, pyrefly 1.1.1)

- The gap is deliberate pyrefly behaviour, not a bug: pyrefly models
  pydantic **lax mode**, where a field accepts anything pydantic would coerce
  at runtime. So `RawTitle` accepts any `str`, and `int` accepts
  `Decimal | bool | bytes | float | int | str`. Only types pydantic cannot
  coerce (e.g. a `list[int]` for an `int`) are errors.
- Under **strict** mode pyrefly checks the declared type. `str` for
  `RawTitle`, `int` for `PageId`, `str` for `RawTitle | None` and
  `list[str]` for `list[BlockUid]` are all errors. It works with
  `model_config = ConfigDict(strict=True)`, inherited from a shared base
  class, and with per-field `Field(strict=True)`. It does not work with
  `Annotated[RawTitle, Strict()]`, which pyrefly ignores.
- Wrinkle: `Field(strict=True, gt=0)` on a `PageId` field makes pyrefly
  reject the constraint itself (`Literal[0]` is not `PageId`). Constrained
  int-brand fields need a workaround.
- Runtime cost of strict mode. Pydantic strict rejects coercions:
  - JSON `"1"`, `1.0` and `true` for an int;
  - a Python list for a `tuple` field, which matters because FastAPI
    validates decoded JSON in Python mode;
  - SQLite `0`/`1` for a `bool`.

  Model-wide strict therefore changes runtime behaviour across about 89
  models. Field-level strict on branded fields only is nearly
  runtime-neutral:
  - a `str` brand already gets a `str`;
  - an int brand stops accepting bool, float and numeric-string input.

Recommended direction: per-field `Field(strict=True)` on every branded
pydantic field, plus a brandlint rule that reports a model field annotated
with a brand (directly, optional, or in a list) and lacking `strict=True`,
so the protection cannot be forgotten. Typed factory functions are not
needed once strict fields work.
