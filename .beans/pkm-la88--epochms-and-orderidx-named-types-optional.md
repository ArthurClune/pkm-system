---
# pkm-la88
title: EpochMs and OrderIdx named types (optional)
status: completed
type: task
priority: deferred
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T20:55:08Z
parent: pkm-7uxw
---

These are optional and low value; do them last, if at all.

- **`EpochMs`**: a grep found no seconds-valued timestamps on either side, and the `_ms` suffix convention already does most of the work. The remaining swap shapes are `classify(created_at, since_ms, until_ms)` (`server/src/pkm/changed.py:62`, caller `server/routes_search.py:142`), `OpsAck.ts` next to `OpsAck.seq` (`contracts/responses.py:477,486`), and `elapsedLabel(sinceMs, nowMs)` (`web/src/assistant/elapsed.ts:4`). Keyword-only args on `classify` may be enough. About 45 Py and 94 TS sites.
- **`OrderIdx`**: a sparse sibling order key, as opposed to a dense array index. `shiftFrom(siblings, fromIdx)` (`web/src/outline/tree.ts:132`) is passed an `order_idx` but named like an index (`Located.index`, `outline/tree.ts:9-14`), and `idxAfter` converts between them (`outline/edits.ts:42-45`). No bug was found. It sits on every op, so the change is medium-sized.

- [x] Decide whether either is worth doing; if not, scrap this bean with reasons


## Decision (Arthur, 2026-10-01)

Keep it; do it last, after pkm-thee has landed.

## Summary of Changes

- **OrderIdx** (`contracts/ops.py`, `brand()`ed) is the block's sparse sibling order key on `CreateOp`, `MoveOp`, `BlockNode` and `SyncBlock`. `SyncSidebarEntry` stays `int`.
  - **Server:** `ShiftSiblings.from_order_idx`; `InsertBlock` / `SetParent` and the conflict-landing keys are typed. Mints are at row reads and at `descendant_copy_effects`' fresh renumber.
  - **Web:** `outline/orderIdx.ts` is the only order-key arithmetic (`FIRST_ORDER_IDX`, `orderIdxAfter`, `orderIdxAfterLast`, `orderIdxPlus`, `freshChildOrderIdx`). `idxAfter` is renamed `orderIdxAfterPosition`, the dense-position → order-key conversion. `shiftFrom` / `shiftSiblings` take `fromOrderIdx: OrderIdx`. Dense positions stay unbranded, by decision.
- **Bug fixed (reproduced first):** CLI/MCP appends (save/`plan_save`, batch create/todo/outline/move, a new `## Heading`) used the child count as the append key. With gapped keys (386 of 20,454 sibling groups in prod) they landed mid-list. `next_child_order_idx` now returns last + 1. A troubleshooting row covers it.
- **Time, no brand:**
  - `classify(created_at, *, since_ms, until_ms)` is keyword-only;
  - `elapsedLabel({ sinceMs, nowMs })` takes a named object;
  - the login throttle's monotonic clock is named `mono_ms` / `blocked_until_mono_ms`, so every remaining `now_ms` is epoch.
- **Docs:** OrderIdx added to the brand tables; an order-key note in `frontend-editor.md`; a `backend.md` note that pyrefly doesn't check pydantic constructor arguments, so server brand guarantees rest on the effect dataclasses and helper signatures.
- **Verification:**
  - server: pytest 2293 passed; pyrefly 0 errors, 11 suppressed, 7 warnings; ruff clean;
  - web: `pnpm verify` green;
  - perf: no changes on backend or frontend;
  - Opus final review: merge after minors, which are fixed.
- **Follow-up:** pkm-78fk. Batch `index` is a raw `order_idx` that MCP callers can't know; its meaning (position recommended) needs a decision, and it also covers the mixed indexed/append ordering quirk.
