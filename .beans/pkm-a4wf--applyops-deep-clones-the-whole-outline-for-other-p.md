---
# pkm-a4wf
title: applyOps deep-clones the whole outline for other-page remote batches
status: todo
type: task
priority: low
created_at: 2026-08-18T18:58:40Z
updated_at: 2026-08-18T18:58:40Z
parent: pkm-wvvu
---

Found during pkm-nvxh and endorsed by its review and the whole-branch review as its own bean.

The websocket broadcasts ops for every page. tree.ts::applyOpsWithChange clones the full tree up front (tree.ts:154), so a remote batch aimed at another title allocates a complete copy of every open outline and throws it away when no op matches. Since pkm-nvxh the wasted copy has no downstream cost (the change signal keeps the old state object), but the allocation itself remains per remote batch per open outline.

## Acceptance criteria

- [ ] Skip the clone (relevance pre-check on the ops' page/uids, or a lazy/copy-on-write clone) when no op concerns the outline's page
- [ ] Preserve applyOps' "returns a new tree when anything changed" contract and the exact change-signal semantics pinned by tree.test.ts's equivalence table
- [ ] Keep the server-mirroring op semantics byte-comparable (ops_apply.py parity)
- [ ] Add a structural test that fails if the full clone returns on the irrelevant-batch path
