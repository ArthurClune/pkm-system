---
# pkm-l6cl
title: Widen shim parity coverage for block backlinks
status: completed
type: task
created_at: 2026-08-06T12:05:26Z
updated_at: 2026-08-06T12:05:26Z
---

pkm-d31f follow-up: shared/fixtures/shim_parity.json's block_backlinks case is one group with one item, so the route's ORDER BY (updated_at DESC NULLS LAST, title, uid) and multi-group shaping are pinned only indirectly via the page-backlinks cases. Add a second referring block on a different page with a distinct updated_at to SEED['block_refs'] (+ matching seed text) and regenerate the fixture, so shim/server drift in ordering or grouping cannot hide.

## Summary of Changes

Added `uid_b10` to `SEED["blocks"]` (page 5 "Attention Is All You Need", top-level, text "Follow-up to ((uid_b3)) findings") and `["uid_b10", "uid_b3"]` to `SEED["block_refs"]` in `shim_parity_dump.py`, then regenerated `shared/fixtures/shim_parity.json`.

The `block_backlinks` case now returns two groups — page 5 (updated_at 8000) before page 3 (3000) — pinning the route's `ORDER BY p.updated_at DESC NULLS LAST` and multi-group shaping directly. As a side effect `page_with_backlinks` now pins `block_ref_counts` at a value above 1 (uid_b3: 2). Only those two cases changed in the fixture; the new text avoids every search/unlinked term so no other case moved.

No shim drift found: `parity.test.ts` replayed the widened fixture byte-identically with no TS changes — the shim was already correct, the coverage gap is now closed. Verified: full server pytest (1443, 97% cov), pyrefly, ruff, full web verify (2039 unit + 52 e2e).
