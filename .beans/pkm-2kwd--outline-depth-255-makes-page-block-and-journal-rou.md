---
# pkm-2kwd
title: Outline depth >= 255 makes page, block and journal routes 500
status: todo
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-23T18:15:37Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. Needs Arthur's call: cap outline depth at write time (a product limit, enforced in ops and sync) or serialise iteratively. Then opus designs: either path touches ops/sync/proptests. Probes: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p3_deep_tree.py, p3b_threshold.py, p3c_threshold.py, p3d_journal.py.

- [ ] Arthur decides: write-time cap or iterative serialisation
- [ ] Red tests from the probes
- [ ] Fix; proptest/check.sh; perf/check.sh
- [ ] troubleshooting.md row
