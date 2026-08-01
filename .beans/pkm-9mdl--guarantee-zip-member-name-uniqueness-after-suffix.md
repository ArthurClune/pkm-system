---
# pkm-9mdl
title: Guarantee ZIP member-name uniqueness after suffix generation
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:46:44Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 18).

## Context

**References:** `server/src/pkm/assets_core.py:64-76`

zip_arcnames() checks whether the original filename is used but does not recheck the generated name (<sha8>).ext. Generated-looking input names or shared eight-character SHA prefixes can still produce duplicate ZIP members.

**Direction:** Loop until the candidate is unused, using a longer SHA or incrementing suffix when necessary.

## Tasks

- [x] Test generated-looking names, shared SHA prefixes, and case-insensitive collisions
- [x] Assert every archive name is unique

## Summary of Changes

`zip_arcnames()` in `server/src/pkm/assets_core.py` now rechecks each
generated candidate against the set of already-used (lowercased)
arcnames instead of only checking the original filename once. When a
generated `<stem> (<sha8>)<suffix>` candidate is itself already taken
(a real filename that happens to look generated, or two different
assets whose sha256 shares the same 8-char prefix), the sha prefix is
extended one character at a time up to its full 64-char length. In the
residual case where two entries share both filename and full sha256
(same asset referenced twice under the same name), even the full
digest can't disambiguate, so an incrementing numeric suffix
(`-2`, `-3`, ...) is appended as the final fallback. Existing
case-insensitive first-collision behaviour is unchanged.

Added three tests to `server/tests/test_assets_core.py`:
- `test_zip_arcnames_generated_looking_name_still_gets_disambiguated`
- `test_zip_arcnames_shared_sha_prefix_still_gets_disambiguated`
- `test_zip_arcnames_identical_sha_and_name_still_gets_disambiguated`

All three reproduced the bug (duplicate arcnames) against the old
implementation (RED) and pass against the fix (GREEN), asserting
every returned arcname is unique modulo case.

Shell callers unchanged: `routes_export.py` doesn't call
`zip_arcnames`; `routes_assets.py:222` calls it with the same
`list[tuple[str, str]] -> list[tuple[str, str]]` signature, so no
route/contract changes and no OpenAPI/gen-types regen needed.

Verification: `uv run pytest -q` (1052 passed, 96.26% coverage),
`uv run pyrefly check` (0 errors), `uv run ruff check` (all checks
passed) — all from `server/`.
