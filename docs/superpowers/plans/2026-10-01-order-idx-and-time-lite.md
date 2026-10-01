# OrderIdx brand and time-lite (pkm-la88)

> **For agentic workers:** execute task by task, subagent-driven. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a block's sparse sibling order key (`blocks.order_idx`) becomes `OrderIdx` on both sides. A dense array position used as an order key then fails tsc or pyrefly. Separately, three timestamp call shapes are made swap-proof without a brand.

**Decisions (Arthur, 2026-10-01):**
- **OrderIdx is branded end to end.** EpochMs is NOT branded: keyword-only and named args plus one rename stand in for it.
- **Dense positions get no brand of their own.** No `SiblingPos`; `Located.index` stays `number`. A brand catches only position→order-key, never order-key→position, and we accept that.
- **`sidebar_entries.order_idx` stays a plain `int`.** The server assigns it and the web reorders by array position, so it never meets block order code.

The two tasks touch disjoint files and run in parallel, in separate worktrees:

| Task | Branch | Worktree |
|---|---|---|
| 1 | `feat/pkm-la88-order-idx` | `.claude/worktrees/pkm-la88` |
| 2 | `feat/pkm-la88-time-lite` | `.claude/worktrees/pkm-la88-time` |

## Global constraints

- **Every commit is green.**
  - Server: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`. pyrefly must show 0 errors, with 11 suppressed and 7 warnings, the same as main.
  - Web: `cd web && pnpm typecheck && pnpm test:unit`.
- **No suppressions:** no `# pyrefly: ignore`, `# type: ignore`, `@ts-ignore` or `eslint-disable`.
- **Casts and `OrderIdx(...)` only at mint points:**
  - pydantic op parsing;
  - SQLite row reads/mappers;
  - the order-key arithmetic module (Task 1);
  - `descendant_copy_effects`'s `enumerate()` renumber;
  - test fixture helpers.

  Never at a call site.
- **Regen** after any server schema change:
  ```
  cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
  cd web && pnpm gen-types
  ```
  The openapi diff must be `x-brand` additions only.
- **No bean ids in code or test comments.**
- **No new DB statements** (the perf gate counts them).

---

### Task 1: OrderIdx

**Server:**
- `contracts/ops.py`: add `OrderIdx = NewType("OrderIdx", int)` and `brand(OrderIdx)`. Comment it as a sparse sibling order key, not a position, with gaps after deletes.
- Typed as `OrderIdx`:
  - `CreateOp.order_idx` and `MoveOp.order_idx` (ops.py);
  - `BlockNode.order_idx` and `SyncBlock.order_idx` (responses.py).
- `SyncSidebarEntry.order_idx` stays `int`.
- `server/ops_core.py`:
  - `ShiftSiblings.from_idx` is renamed `from_order_idx: OrderIdx`, and its consumers in `ops_apply.py` follow;
  - `InsertBlock.order_idx` and `SetParent.order_idx` become `OrderIdx`;
  - conflict-landing `next_idx` / `append_idx` (around ops_core.py:577–588) are minted where they're read or computed;
  - `descendant_copy_effects`' `order_idx=idx` mints with a one-line comment that this is the deliberate dense→order-key renumber.
- Server row reads of `blocks.order_idx` that build any of these become typed. pyrefly lists them.

**Web:**
- `api/brands.ts`: `OrderIdx = number & { readonly __brand: "OrderIdx" }`, with a comment in the file's style.
- **New** `outline/orderIdx.ts` (Functional Core) is the one web module that does order-key arithmetic:
  - `FIRST_ORDER_IDX: OrderIdx` (0);
  - `orderIdxAfter(o: OrderIdx): OrderIdx` (o + 1);
  - `orderIdxAfterLast(siblings: readonly { order_idx: OrderIdx }[]): OrderIdx` (last + 1, or `FIRST_ORDER_IDX` when empty).

  Every `last ? last.order_idx + 1 : 0` site (`outline/edits.ts` ×4, `outline/dnd.ts`) and `shiftFrom`'s `s.order_idx += 1` go through these.
- `outline/edits.ts`: `idxAfter(siblings, index)` is renamed `orderIdxAfterPosition(siblings, position: number): OrderIdx`. It's the named dense→order-key conversion point. Update its doc comment and all callers.
- `outline/tree.ts`: `shiftFrom(siblings, fromOrderIdx: OrderIdx, except?)`. The header comment ("keys on order_idx VALUES, never array positions") stays.
- `replica/localOps.ts`: `shiftSiblings(db, pageId, parentUid, fromOrderIdx: OrderIdx)`, with `order_idx` row reads typed `OrderIdx`.
- `replica/placement.ts`: `orderIdx` fields become `OrderIdx`.
- Row mappers for `blocks.order_idx`: `replica/localApi/tree.ts` `BlockRow`, plus any others tsc flags.
- `test-helpers.ts`: add an `ord(n: number): OrderIdx` fixture helper. `block()` casts its order internally, so its call sites don't change. Fix the remaining test literals with `ord()`, or with a per-file factory that casts once, following the pkm-thee approach.

**Steps:**
- [x] **1. Probes first.**
  - In `outline/tree.test.ts` (or `edits.test.ts`): `// @ts-expect-error a dense position is not an OrderIdx` on a `shiftFrom(siblings, found.index)` call, made reachable by exporting `shiftFrom` or probing via `Parameters<typeof …>`.
  - A `MoveOp` literal with `order_idx: someLocated.index` under `@ts-expect-error`.
  - `orderIdx.test.ts` unit tests for the three helpers.
  - Run `pnpm typecheck` and record the red output (unused directives, missing module).
- [x] **2.** Server NewType, `brand()`, annotations and mints. Then regen, and confirm the openapi diff is `x-brand` only.
- [x] **3.** Web: the arithmetic module, the renames and the narrowing. Go replica → outline → dnd → components, with tsc after each directory. Fix the tests.
- [x] **4.** Full server and web checks. Commit `feat(pkm-la88): OrderIdx brands the sparse sibling order key`.

### Task 2: time-lite (no brand)

- `server/src/pkm/changed.py`: `classify(created_at, *, since_ms, until_ms)`, keyword-only. Update its caller in `routes_search.py` and the tests.
- `web/src/assistant/elapsed.ts`: `elapsedLabel({ sinceMs, nowMs }: { sinceMs: number; nowMs: number })`. Update the caller in `AssistantPanel.tsx` and the tests.
- `server/src/pkm/server/auth.py` `login()`:
  - the monotonic `now_ms` is renamed `mono_ms`;
  - the login throttle's own parameters (`LoginThrottle.is_throttled` / `record_failure`, and `throttle_core.py`'s `is_throttled` / `after_failure` / `prune_expired`, plus their state field names if they hold that clock) are renamed to say monotonic, **if** that clock is the only one fed to them. Check every caller first; if an epoch value is ever passed in, stop and report.
  - After the change, nothing named `now_ms` holds a non-epoch value.
- Tests first where behaviour exists. The renames are type and name only.
- [x] **1.** Make the changes and run the full server and web checks.
- [x] **2.** Commit `refactor(pkm-la88): keyword/named timestamp args; monotonic login clock named as such`.

### Task 3: docs, verification, perf (orchestrator)

- **Docs** (via the `architecture-docs` skill):
  - add `OrderIdx` to the brand tables in `backend.md` and `frontend.md`;
  - add a short note in `frontend-editor.md` (wherever the outline tree's `order_idx` handling lives) that `orderIdx.ts` is the only order-key arithmetic, and that `orderIdxAfterPosition` is the dense→order-key conversion;
  - grep for brand counts.
- **Verification:** merge Task 2 into Task 1's branch, then run `pnpm verify`, the server checks and `perf/check.sh`. Then an Opus whole-branch review with mutation probes.
- **Close:** close pkm-la88, then the epic pkm-7uxw.
