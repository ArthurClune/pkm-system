---
# pkm-7c4i
title: Perf H/cold api_bytes moves by a byte or two on any server change
status: todo
type: bug
priority: normal
created_at: 2026-11-15T22:02:02Z
updated_at: 2026-11-15T22:02:08Z
---

perf frontend H/cold api_bytes sums encodedBodySize, and the sync routes gzip. The fixture cache key includes a digest of product source (perfcheck/build.py cache_key), so any server change rebuilds the fixture DB, and the schema seeds db_generation with randomblob(16), which rides in the snapshot. A new random value moves the gzip size by 1-2 bytes, read as an exact-class regression (seen as -2 then +2 on the tables branch). Fix: pin db_generation in the fixture build, or measure decoded size.
