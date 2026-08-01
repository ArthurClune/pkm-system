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

Added tests to `server/tests/test_assets_core.py`:
- `test_zip_arcnames_generated_looking_name_still_gets_disambiguated`
- `test_zip_arcnames_shared_sha_prefix_still_gets_disambiguated`
- `test_zip_arcnames_one_duplicate_resolves_by_prefix_extension`
- `test_zip_arcnames_mass_duplicates_fall_back_to_numeric_suffix`

All reproduced the bug (duplicate arcnames) against the old
implementation (RED) and pass against the fix (GREEN), asserting
every returned arcname is unique modulo case.

Shell callers unchanged: `routes_export.py` doesn't call
`zip_arcnames`; `routes_assets.py:222` calls it with the same
`list[tuple[str, str]] -> list[tuple[str, str]]` signature, so no
route/contract changes and no OpenAPI/gen-types regen needed.

Verification: `uv run pytest -q` (1053 passed, 96.31% coverage),
`uv run pyrefly check` (0 errors), `uv run ruff check` (all checks
passed) — all from `server/`.

## Fix Round 1 (review finding)

Review flagged that `test_zip_arcnames_identical_sha_and_name_still_gets_disambiguated`
claimed to exercise the numeric-suffix fallback (`assets_core.py:116-119`)
but didn't: with only two colliding duplicates of the same
`(sha, name)` pair, the collision resolves at `prefix_len=9` (a
longer, distinct string) well before the 64-char sha is exhausted.
`--cov-report=term-missing` confirmed lines 118-119 were never hit.

Fix: split into two honestly-named tests.
`test_zip_arcnames_one_duplicate_resolves_by_prefix_extension` keeps
the original 2-duplicate case but asserts the actual prefix-extension
outcome instead of claiming numeric fallback.
`test_zip_arcnames_mass_duplicates_fall_back_to_numeric_suffix` uses
60 duplicates of the same `(sha, name)` pair -- a 64-char hex sha only
offers 57 distinct prefix lengths (8..64 inclusive), so exhausting
those genuinely forces the numeric suffix for the remaining 3 -- and
asserts exactly 3 arcnames carry a `(<sha>-N)` suffix.

Covering command: `cd server && uv run pytest -q tests/test_assets_core.py --cov=src/pkm/assets_core --cov-report=term-missing`
Before fix: `src/pkm/assets_core.py  ... 96%  118-119` (missed).
After fix: `src/pkm/assets_core.py  ... 100%` (no missing lines).

Also fixed a pyrefly `bad-assignment` error the new test introduced
(`list[tuple[LiteralString, str]]` not assignable to
`list[tuple[str, str]]` when building the entries list via
concatenation) by building the list with `.extend(...)` on an
explicitly-typed variable instead.

Full re-verification: `uv run pytest -q` (1053 passed, 96.31%
coverage), `uv run pyrefly check` (0 errors), `uv run ruff check`
(all checks passed) — all from `server/`.
