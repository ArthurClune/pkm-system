---
# pkm-hzt3
title: Importer refuses an export whose orphan subtree claims a block a page already holds
status: in-progress
type: bug
priority: normal
created_at: 2026-10-22T08:51:18Z
updated_at: 2026-10-22T08:53:09Z
parent: pkm-a1xk
---

Found running the importer on the original Roam export (arthurclune-2026-07-08-15-34-39.edn): exit 2, 'block with multiple parents'. 39 blocks sit on a page (AI Chips, Reproducibility in AI/ML) and are also listed in :block/children of an unreached block. parse_export.build() returns the cached Block for a child a page already reached, so the orphan subtree holds the same Block object again and validate_export_structure refuses it as multi_parent. The export has been unimportable since that check landed.

Ruling (Arthur, 2026-10-22): the page keeps the block; the orphan's claim is dropped and reported in the ImportReport.

## Checklist

- [x] Orphan passes in parse_export never re-attach a block already built; record each dropped claim
- [x] Report the dropped claims in the import report
- [ ] The original Roam export imports end to end
