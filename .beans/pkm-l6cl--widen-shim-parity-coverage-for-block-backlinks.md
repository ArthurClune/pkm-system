---
# pkm-l6cl
title: Widen shim parity coverage for block backlinks
status: todo
type: task
created_at: 2026-08-06T12:05:26Z
updated_at: 2026-08-06T12:05:26Z
---

pkm-d31f follow-up: shared/fixtures/shim_parity.json's block_backlinks case is one group with one item, so the route's ORDER BY (updated_at DESC NULLS LAST, title, uid) and multi-group shaping are pinned only indirectly via the page-backlinks cases. Add a second referring block on a different page with a distinct updated_at to SEED['block_refs'] (+ matching seed text) and regenerate the fixture, so shim/server drift in ordering or grouping cannot hide.
