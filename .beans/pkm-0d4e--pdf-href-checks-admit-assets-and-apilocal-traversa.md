---
# pkm-0d4e
title: PDF href checks admit /assets/.. and /api/local/.. traversal
status: todo
type: bug
priority: normal
created_at: 2026-10-23T15:00:12Z
updated_at: 2026-10-23T15:00:19Z
parent: pkm-mfd0
blocking:
    - pkm-e95y
---

Adversarial review of pkm-tk9i (M2). `isPdfHref` and `isDeferredPdfHref` in web/src/components/InlineSegments.tsx are prefix tests, so `[x](/assets/../api/local/paper.pdf)` passes `isPdfHref` but not `isDeferredPdfHref`: the viewer auto-loads a local-docs file (possibly starting an iCloud download), the cost the deferral exists to avoid. Same-origin only; no external host. pkm-tk9i fixed the same shape in `isUploadedAsset` (externalMedia.ts) by refusing `..` segments, encoded slashes and backslashes; reuse that.

- [ ] Red vitest for the traversal forms (`..`, `%2e%2e`, backslash)
- [ ] Both checks refuse them (share the externalMedia.ts helper)
