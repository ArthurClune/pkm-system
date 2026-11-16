---
# pkm-7c4i
title: Perf H/cold api_bytes moves by a byte or two on any server change
status: completed
type: bug
priority: normal
created_at: 2026-11-15T22:02:02Z
updated_at: 2026-11-16T14:00:45Z
---

perf frontend H/cold api_bytes sums encodedBodySize, and the sync routes gzip. The fixture cache key includes a digest of product source (perfcheck/build.py cache_key), so any server change rebuilds the fixture DB, and the schema seeds db_generation with randomblob(16), which rides in the snapshot. A new random value moves the gzip size by 1-2 bytes, read as an exact-class regression (seen as -2 then +2 on the tables branch). Fix: pin db_generation in the fixture build, or measure decoded size.

## Summary of Changes

Symptom: perf frontend H/cold `api_bytes` read as an exact-class regression of a byte or two (seen as -2 then +2) on any server change, because the fixture DB rebuilds when product source changes.

Cause: the schema seeds `db_generation` with `randomblob(16)`, the sync snapshot carries it, and the gzip size of the snapshot moves with the random hex.

Fix: `perfcheck/build.py` `build()` pins `db_generation` to `FIXTURE_DB_GENERATION` right after `init_db`; the product schema is untouched and encoded bytes are still what is measured. Covered by `test_build_pins_db_generation`. The pin shrinks the gzipped snapshot, so the next frontend check reads `api_bytes` as an improvement and ratchets it; no `--rebaseline` is needed.

Rule: docs/architecture/checks.md § Performance gate (fixture determinism).
