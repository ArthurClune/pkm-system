---
# pkm-vcz7
title: Remove dead unregistered-source branch in DndContext.drop(); fix stale refetch doc comment
status: todo
type: task
priority: low
created_at: 2026-07-10T12:12:44Z
updated_at: 2026-07-10T12:12:44Z
---

Follow-up from pkm-auvy review. Item 1 of pkm-auvy (fallback panels fully excluded from DnD) made the unregistered-source branch in DndContext.drop() (web/src/dnd/DndContext.tsx ~91: 'if (dst && !node) dst.refetch()') production-unreachable: startDrag's only caller is the non-fallback path, and every non-fallback instance registers via registerOutline, so src can no longer be undefined at a real drop. Only its unit test exercises it. Also OutlineDndApi.refetch's doc comment (DndContext.tsx:17-19) still describes 'dragged from a panel of an unopened page', stale post-exclusion. Removal may cascade into useOutline — assess scope before deleting.

## Checklist
- [ ] Remove the unreachable branch and its unit test (or document why it must stay)
- [ ] Update the OutlineDndApi.refetch doc comment to current semantics
- [ ] pnpm test + typecheck clean
