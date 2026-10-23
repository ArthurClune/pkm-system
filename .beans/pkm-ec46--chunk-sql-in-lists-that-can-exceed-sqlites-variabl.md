---
# pkm-ec46
title: Chunk SQL IN-lists that can exceed SQLite's variable limit
status: todo
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. _block_ref_counts, _fetch_ancestors and _gather_resolution_data bind one variable per id; past 32,766 the query raises and the route answers 500. Probes: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p4_placeholders.py, docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-exports/p7_varlimit.py.

- [ ] Red test from each probe
- [ ] Chunk every IN-list built from an unbounded id set
- [ ] perf/check.sh backend before merge
- [ ] troubleshooting.md row
