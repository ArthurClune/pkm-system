---
# pkm-vphw
title: Harden synthetic data generator edge cases
status: completed
type: task
priority: low
created_at: 2026-07-18T20:58:19Z
updated_at: 2026-07-19T14:11:53Z
---

Follow-ups from the pkm-2xh2 final review.

## Checklist

- [x] Add a focused success-path test for generation into a pre-existing empty output directory
- [x] Deduplicate fixture assets by SHA before inserting asset rows
- [x] Add a regression test for differently named asset files with identical bytes
- [x] Run focused generator tests, pyrefly, and Ruff


## Summary of Changes

Root cause: the synthetic data generator's asset table insert
(`server/src/pkm/test_data/generate.py`) built one row per source filename
in `assets_by_name.values()`, but the `assets` table is keyed by
`sha256 PRIMARY KEY`. Two differently named fixture files with identical
bytes (same content hash) produced two rows with the same primary key,
raising `sqlite3.IntegrityError: UNIQUE constraint failed: assets.sha256`
and crashing generation.

Fix: added `deduplicate_assets_by_sha` (pure function, Functional Core) to
`server/src/pkm/test_data/core.py`. It collapses `assets_by_name` down to
one `Asset` per distinct SHA-256, keeping the first-encountered asset's
filename for that content (deterministic because `_index_assets` iterates
`sorted(asset_dir.iterdir())`, so dict iteration order is already
alphabetical by source filename). `generate.py` (Imperative Shell) now
builds its `INSERT INTO assets` rows from `deduplicate_assets_by_sha(...)`
instead of raw `assets_by_name.values()`.

Tests added (TDD - written and confirmed failing before the fix):
- `test_test_data_generator.py::test_generate_deduplicates_assets_with_identical_content`
  - copies the committed `test-data/` fixture, adds two asset files
    (`dup-alpha.bin`, `dup-beta.bin`) with identical bytes but different
    names, runs `generate()`, and asserts the `assets` table has exactly
    one row for that content hash, with `dup-alpha.bin` as the surviving
    filename. Before the fix this failed with the IntegrityError above;
    after the fix it passes.
- `test_test_data_core.py::test_deduplicate_assets_by_sha_keeps_first_named_asset_per_content`
  - direct unit test of the new pure function: two same-content assets
    collapse to one, a third distinct-content asset is preserved.
- `test_test_data_generator.py::test_generate_succeeds_with_pre_existing_empty_output_directory`
  - success-path regression guard for generating into a pre-existing but
    empty output directory. This already passed before any code change
    (existing `_claim_output`/`_validate_claimed_output` logic in
    `generate.py` already treats a zero-entry backup directory as
    acceptable) - added as a guard against future regression, not as a
    bug fix.

Files changed:
- `server/src/pkm/test_data/core.py` - added `deduplicate_assets_by_sha`
- `server/src/pkm/test_data/generate.py` - use it when building asset insert rows
- `server/tests/test_test_data_core.py` - unit test for the new function
- `server/tests/test_test_data_generator.py` - dedupe regression test + empty-output-dir success-path test

Verification: `uv run pytest -q` -> 482 passed, coverage 95.99% (threshold
95%); `uv run pyrefly check` -> 0 errors; `uv run ruff check` -> all
checks passed.

Branch: task/pkm-vphw-generator-hardening
