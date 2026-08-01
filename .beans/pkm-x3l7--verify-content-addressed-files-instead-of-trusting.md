---
# pkm-x3l7
title: Verify content-addressed files instead of trusting existence
status: completed
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T08:28:05Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 17).

## Context

**References:** `server/src/pkm/importer/run.py:101-107`; `server/src/pkm/export/writer.py:64-72`

Importer and backup export skip copying whenever the destination exists; they do not verify that bytes match the SHA in the path. Truncated or corrupted files can survive every later import/export.

**Direction:** Verify size and SHA-256 and atomically repair mismatches from the known source.

## Tasks

- [x] Add same-size and truncated corruption repair tests
- [x] Validate and repair existing content-addressed files

## Summary of Changes

Both callsites that previously trusted a content-addressed path's mere
existence now verify it against the assets row's known sha256/size, and
repair in place from the known-good source if it doesn't match:

- `server/src/pkm/assets_core.py`: two new pure functions, `sha256_hex`
  (hash bytes) and `asset_needs_repair(expected_sha256, expected_size,
  actual_size, actual_sha256)` (the repair decision). The decision takes
  `actual_sha256` as optional so callers can skip hashing outright when a
  stat-only size check already proves corruption.
- `server/src/pkm/importer/run.py`: the asset-copy loop now checks an
  existing destination's size (cheap stat), only computing/comparing its
  sha256 if the size matches, and falls through to the existing
  temp-file-then-`os.replace` atomic write whenever verification fails
  (missing or corrupt) instead of only when the file was absent.
- `server/src/pkm/export/writer.py`: same size-then-hash verification
  before hardlinking a previously-exported asset forward. A corrupted
  "existing" asset is never hardlinked; the loop falls through to the
  same branch used for a brand-new hash and re-copies correct bytes from
  `live_assets_dir`, so the repair rides the same atomic stage-then-swap
  publish this task's predecessor (pkm-n8eq) already built — no separate
  repair-specific I/O path was needed on the export side.

**Cost choice:** hash-always (not sampling), justified by corpus scale
(~1e3 images) making a full read of the previously-present set a
low-single-digit-second nightly tax. The stat-based size check is kept
as a cheap first gate purely because it's free and catches truncation
without a read at all, not as a sampling strategy to skip verification
of most files.

**Test fixture fix:** `tests/test_export_writer.py`'s `graph` fixture
used a placeholder sha256 (`"ab" * 32`) that didn't match its own fixture
bytes (`b"png"`). That was harmless before this task (existence was
never checked against content) but became a false "always corrupt" once
sha verification was added, since every second call to `export_graph`
would now find genuine mismatch — fixed to `hashlib.sha256(b"png")
.hexdigest()`, which the four tests that call `export_graph` twice
already depend on.

Verification: `cd server && uv run pytest -q` (1047 passed, 96.28%
coverage, gate is 95%), `uv run pyrefly check` (0 errors), `uv run ruff
check` (all checks passed). TDD evidence: RED confirmed by running the
new tests before each implementation (ImportError for the pure-function
tests; explicit assertion failures for the importer/export repair
tests), GREEN after each corresponding implementation.
