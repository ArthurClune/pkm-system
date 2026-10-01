---
# pkm-la88
title: EpochMs and OrderIdx named types (optional)
status: todo
type: task
priority: deferred
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T10:42:35Z
parent: pkm-7uxw
---

These are optional and low value; do them last, if at all.

- **`EpochMs`**: a grep found no seconds-valued timestamps on either side, and the `_ms` suffix convention already does most of the work. The remaining swap shapes are `classify(created_at, since_ms, until_ms)` (`server/src/pkm/changed.py:62`, caller `server/routes_search.py:142`), `OpsAck.ts` next to `OpsAck.seq` (`contracts/responses.py:477,486`), and `elapsedLabel(sinceMs, nowMs)` (`web/src/assistant/elapsed.ts:4`). Keyword-only args on `classify` may be enough. About 45 Py and 94 TS sites.
- **`OrderIdx`**: a sparse sibling order key, as opposed to a dense array index. `shiftFrom(siblings, fromIdx)` (`web/src/outline/tree.ts:132`) is passed an `order_idx` but named like an index (`Located.index`, `outline/tree.ts:9-14`), and `idxAfter` converts between them (`outline/edits.ts:42-45`). No bug was found. It sits on every op, so the change is medium-sized.

- [ ] Decide whether either is worth doing; if not, scrap this bean with reasons


## Decision (Arthur, 2026-10-01)

Keep it; do it last, after pkm-thee has landed.
