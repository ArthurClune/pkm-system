---
# pkm-a4wf
title: applyOps deep-clones the whole outline for other-page remote batches
status: completed
type: task
priority: low
created_at: 2026-08-18T18:58:40Z
updated_at: 2026-08-18T19:35:42Z
parent: pkm-wvvu
---

Found during pkm-nvxh and endorsed by its review and the whole-branch review as its own bean.

The websocket broadcasts ops for every page. tree.ts::applyOpsWithChange clones the full tree up front (tree.ts:154), so a remote batch aimed at another title allocates a complete copy of every open outline and throws it away when no op matches. Since pkm-nvxh the wasted copy has no downstream cost (the change signal keeps the old state object), but the allocation itself remains per remote batch per open outline.

## Acceptance criteria

- [x] Skip the clone (relevance pre-check on the ops' page/uids, or a lazy/copy-on-write clone) when no op concerns the outline's page
- [x] Preserve applyOps' "returns a new tree when anything changed" contract and the exact change-signal semantics pinned by tree.test.ts's equivalence table
- [x] Keep the server-mirroring op semantics byte-comparable (ops_apply.py parity)
- [x] Add a structural test that fails if the full clone returns on the irrelevant-batch path

## Summary of Changes

**Mechanism: relevance pre-check, not copy-on-write.** `opsTouchPage(blocks, ops, pageTitle)` in `web/src/outline/tree.ts` asks the same question `applyOne` asks per op — `create` by `page_title`, `create_page` never, everything else by uid presence — of the whole batch, before `clone`. It collects the batch's non-create uids into a `Set` (bounded by batch size) and makes one short-circuiting depth-first pass over the tree via `holdsAny`. A miss returns `{ blocks, changed: false }` with the caller's own array; a hit clones exactly as before. COW would have needed a parallel node representation threaded through `locate`/`siblingsOf`/`shiftFrom` for the same win on the same one path.

**Why reading the pre-apply tree is sound.** A batch with no relevant `create` adds no uids, and delete/move only ever remove them, so uid presence measured before application can only over-report — and over-reporting just means the clone happens, which is the old behaviour. Relevance is deliberately not outcome: a `create` for this page that resolves to nothing (uid already here, unknown parent) still takes the clone path, so the change flag can never disagree with what `applyOne` would have decided.

**Change-signal contract.** `changed` is still exactly "the ops altered something": the skipped path is precisely the path on which every op returns `false` from `applyOne`, so `changed: false` there matches. The equivalence table in `tree.test.ts` (21 ops asserted against a `JSON.stringify` compare) passes **unmodified**. Downstream, `outlineState.applyBatch` feeds the result to `stampBumped`, whose `stamped !== applied.blocks` "something was stamped" signal is unaffected: a skipped batch names no uid in the tree, so nothing stamps and the reference passes through, exactly as it did through the discarded clone.

**Server parity untouched.** No per-op semantics changed; `ops_apply.py` was read to confirm the client filter mirrors it and the pre-check only short-circuits batches where every op was already a no-op here.

**Tests** (`web/src/outline/tree.test.ts`, new describe block): reference-identity of the returned array *and* of nested arrays/nodes for a nine-op all-miss batch; the same assertion per op kind individually; one nested-uid op in an otherwise-missing batch still clones and applies; a `create` for this page is never treated as a miss. Two of the four failed against the old code before the implementation landed.

**Docs.** `docs/architecture/frontend.md` gains one sentence on the skip in the `applyOpsWithChange` paragraph.

**Verification.** `cd web && CI=true pnpm verify` green: typecheck, eslint, FCIS check, 2184 unit tests in 134 files with coverage thresholds met, vite build, 54 Playwright e2e.
