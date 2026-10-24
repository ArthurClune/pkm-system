---
# pkm-2kwd
title: Outline depth >= 255 makes page, block and journal routes 500
status: completed
type: bug
priority: normal
created_at: 2026-10-23T18:15:37Z
updated_at: 2026-10-24T14:59:19Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Split from pkm-qd81. Needs Arthur's call: cap outline depth at write time (a product limit, enforced in ops and sync) or serialise iteratively. Then opus designs: either path touches ops/sync/proptests. Probes: docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p3_deep_tree.py, p3b_threshold.py, p3c_threshold.py, p3d_journal.py.

- [x] Arthur decides: write-time cap or iterative serialisation (cap 100, reject the batch; spec docs/superpowers/specs/2026-10-24-outline-depth-cap-design.md)
- [x] Red tests from the probes
- [x] Fix; proptest/check.sh; perf/check.sh
- [x] troubleshooting.md row

## Summary of Changes

Outline depth is capped at 100 levels at write time (spec docs/superpowers/specs/2026-10-24-outline-depth-cap-design.md, plan docs/superpowers/plans/2026-10-24-outline-depth-cap.md).

- Server: /api/ops refuses (400) a client create/move that would put any block past level 100 (ops_core.plan_op; depths read in ops_apply._context_for with no added query). Server-made landings are never refused but bounded: a conflict header at the cap or deeper is not reused, and diverged-delete copies past the cap are flattened at level 100 in document order (an adversarial review showed unbounded stacking otherwise).
- Importer refuses an export with a block past the cap.
- Web: useOutline.run() and undo/redo replay refuse with a notice (draft text still ships; a refused undo keeps its entry); the drop zone clamps by the dragged subtree's height. shared/fixtures/outline_depth.json pins the constant both sides.
- E2E (Tab at the cap), docs (backend.md, sync-recovery.md, frontend-editor.md, import-export-and-backup.md), two troubleshooting rows.
- Gates: server pytest/pyrefly/ruff, pnpm verify, proptest/check.sh green; perf backend paste-50 +0.6% VM steps accepted by Arthur, baseline re-recorded.
- Follow-ups: pkm-n01x, pkm-hrzs, pkm-w6pc, pkm-pgod.
