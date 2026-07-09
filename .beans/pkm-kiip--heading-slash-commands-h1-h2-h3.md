---
# pkm-kiip
title: Heading slash commands (/h1 /h2 /h3)
status: completed
type: feature
priority: normal
created_at: 2026-07-09T21:25:53Z
updated_at: 2026-07-09T21:55:56Z
---

Deferred from pkm-j5n6 (slash commands). /h1 /h2 /h3 would set a block's `heading` field, but there is currently no writable op path for heading on an existing block:

- Server: CreateOp (server/src/pkm/server/ops_core.py:23) carries `heading` and is only applied at insert time (ops_apply.py:78-81). UpdateTextOp (routes_ops.py / ops_core.py) has no heading field, and there is no SetHeadingOp.
- Client: web/src/api/types.d.ts's UpdateTextOp mirrors this — no heading field to send.

Per pkm-j5n6's scope, no new server op was added to keep that change out of this feature's blast radius. To implement /h1-/h3:
1. Add a server-side op (e.g. SetHeadingOp or extend UpdateTextOp) + handler in ops_apply.py/ops_core.py that can change heading on an existing block.
2. Regenerate the OpenAPI client types (web/src/api/types.d.ts).
3. Wire a client-side op-queue helper (mirroring how UpdateTextOp is sent) and extend web/src/outline/slashCommands.ts (see SLASH_COMMANDS in that file, already scaffolded with /text /todo /python /bash /javascript) with h1/h2/h3 entries that call the new op instead of a text transform.
4. detectAutocomplete's slash context (web/src/outline/autocomplete.ts) already fires for any /<letters> prefix, so /h1 etc. will show up once added to the command list — no detection changes needed.

## Summary of Changes

Point 4 above turned out to be wrong: `SLASH_QUERY_RE` was letters-only (`/^[A-Za-z]*$/`), so the digit in "h1" closed the menu before the command list was ever consulted. Fixed that first, then added the op.

**Server** (`server/src/pkm/server/ops_core.py`, `ops_apply.py`):
- New `SetHeadingOp` (`op: "set_heading"`, `uid`, `heading: int | None` with `ge=1, le=3`), following the `SetCollapsedOp` pattern exactly rather than widening `UpdateTextOp`.
- New `SetHeading` effect dataclass; `plan_op` returns `(SetHeading(uid, heading), TouchPage(page_id))`.
- `ops_apply._execute` handles `SetHeading` with `UPDATE blocks SET heading = ?, updated_at = ? WHERE uid = ?`.
- `routes_ops.py` needed no changes — it's already generic over `OpBatch`.
- Regenerated `web/src/api/openapi.json` and `web/src/api/types.d.ts` (`openapi_dump` + `pnpm gen-types`); `test_openapi_sync.py` confirms they're in sync.

**Client — detection** (`web/src/outline/autocomplete.ts`):
- `SLASH_QUERY_RE` changed from `/^[A-Za-z]*$/` to `/^([A-Za-z][A-Za-z0-9]*)?$/`: still must start with a letter (so "/2020 budget" stays quiet — a leading digit never opens the menu), but digits are now allowed after the first letter, so "/h1", "/h2", "/h3" keep it open.

**Client — command list & op dispatch**:
- `web/src/outline/slashCommands.ts`: added `h1`/`h2`/`h3`/`normal` to `SLASH_COMMANDS`, plus a new pure `resolveHeading(command, currentHeading)` that returns the heading to set, or `undefined` for non-heading commands. `applySlashCommand` needed no new case — heading commands fall through to the existing `default` (strip the trigger, no other text transform), since the heading write is a separate op.
- `web/src/outline/edits.ts`: new `setHeading(blocks, pageTitle, uid, heading)`, mirroring `setCollapsed`.
- `web/src/outline/tree.ts`: `applyOne` now handles `set_heading` (mirrors `set_collapsed`) so both local optimistic apply and remote websocket batches update `node.heading` the same way.
- `web/src/outline/useOutline.ts`: added `onSetHeading` alongside the existing handlers (additive only, per the DnD-branch conflict-containment note — no restructuring).
- `web/src/api/ops.ts`: added `SetHeadingOp` to the `BlockOp` union.
- `web/src/components/EditableBlockTree.tsx`: `OutlineHandlers` gained `onSetHeading`; `pick()` now calls `setText()` for the trigger-stripped text (as before) and then, if `row.command` resolves through `resolveHeading` to something other than `undefined`, also calls `handlers.onSetHeading`. Because `setText` sets the pending-draft ref synchronously before `onSetHeading`'s `run()` executes, `useOutline`'s existing pending-flush logic bundles the `update_text` and `set_heading` ops into one batch/network round-trip automatically — no restructuring of `run()` was needed.

**UX decision — toggle behaviour**: picking `/h1` on a block that is already heading 1 clears it back to plain text (toggle off) rather than being a no-op; this is exactly what `resolveHeading` implements (`current === target ? null : target`). Added a `/normal` command as the explicit "always clear, never toggle" escape hatch, since it was cheap given `resolveHeading` already distinguishes "not a heading command" (`undefined`) from "clear the heading" (`null`).

**Tests**: server — `test_ops_core.py` (plan + validation of out-of-range heading), `test_ops_apply.py` (DB roundtrip, set then clear), `test_ops_endpoint.py` (200 roundtrip + 422 on `heading=5`). Web — `autocomplete.test.ts` (digit-after-letter triggers, leading-digit doesn't), `slashCommands.test.ts` (list membership, prefix match, `applySlashCommand` strip-only behavior, `resolveHeading` set/toggle/clear), `tree.test.ts` (`set_heading` applies and is skipped for foreign uids — the remote-batch path), `edits.test.ts` (`setHeading` emits + applies, no-op for unknown uid), `EditableBlockTree.test.tsx` (end-to-end: typing `/h1` and pressing Enter strips the trigger and calls `onSetHeading`; toggle-off on an already-h1 block; `/normal` always clears; non-heading commands never call `onSetHeading`).

**Verification**: `cd server && uv run pytest` — 206 passed. `cd web && pnpm vitest run` — 220 passed (33 files). `cd web && pnpm typecheck` — clean.

**Deferred / not done**: no e2e/Playwright run (out of scope per instructions). No visual/CSS work — `EditableBlockTree.tsx`'s `Tag` selection (`h1`/`h2`/`h3`/`div` based on `node.heading`) already existed and needed no changes.
