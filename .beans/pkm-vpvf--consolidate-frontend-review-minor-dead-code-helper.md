---
# pkm-vpvf
title: Consolidate frontend review minor dead code helpers and constants
status: completed
type: task
priority: low
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:25Z
updated_at: 2026-08-18T21:05:00Z
parent: pkm-wvvu
---

## Review findings

Frontend B4, small A6 twins, and correctness-adjacent documentation/constants not absorbed by larger children.

## Acceptance criteria

- [x] Delete dead local API re-exports and the unused repair epoch id/counter
- [x] Decide whether test-only `moveBlockUp`, `moveBlockDown`, and `createSyncState` belong in production exports; narrow or document them
- [x] Share `scopeContainsTitle` and simplify repeated sync reset precedence/base construction where doing so improves clarity
- [x] Add a chord predicate for repeated modifier policy in `decideEditorKey` without table-driving the priority chain
- [x] Document the distinct worker data-stamp and deadline clocks, and replace bare recovery timeout literals with the named constant where semantically identical
- [x] Make `onDragStartBlock` optional or move its real ownership so the base stub/spread override is unnecessary
- [x] Add focused tests for behavior changes and run type, lint, FCIS, and unit gates

## Summary of Changes

- **Dead re-exports**: removed `GroupItem`, `CurrentWorkSection`, `ScanPayload` from `api/payloads.ts` and `OpBatch` from `api/ops.ts` — verified zero importers anywhere in `web/src` outside the generated `api/types.d.ts`/`api/openapi.json`. The repair epoch id/counter was already fully removed by prior work (`outline/repairEpochs.ts`'s `RepairEpoch` tracks identity by object reference, no id field ever existed) — confirmed via full-repo grep, nothing to delete.
- **moveBlockUp/moveBlockDown/createSyncState**: the premise that `moveBlockUp`/`moveBlockDown` (`outline/edits.ts`) are test-only didn't hold — `moveSubtreeUp`/`moveSubtreeDown` delegate to them in production, so they stay exported; added a doc comment on each explaining why. `createSyncState` (`sync/syncState.ts`) genuinely was test-only (production code, `SyncProvider.tsx`, builds the state inline) — removed the production export and moved it into `sync/syncState.test.ts` as a local test helper with a comment explaining the split.
- **scopeContainsTitle**: was defined identically in both `outline/outlineState.ts` and `outline/outlineSessions.ts`; exported the `outlineState.ts` copy (the lower-level pure-state module) and had `outlineSessions.ts` import it instead of redefining it.
- **sync reset precedence/base construction**: extracted the repeated "a different-kind delivery problem takes precedence" guard plus the "build or reuse the replica-stalled base object" logic, common to `reset-started`/`reset-blocked`/`reset-failed` in `sync/syncState.ts`, into one `stalledBaseOrDeferred` helper.
- **decideEditorKey chord predicates**: added `isShiftMetaOnly` (Shift+Cmd, no Ctrl/Alt) — a true verbatim duplicate used at both the subtree-move and line-wise-selection chord checks — and `isMetaOrCtrlOnly` (Meta or Ctrl, no Alt/Shift), used at the Cmd/Ctrl-Enter todo-cycle check. Investigated the undo/redo 'z' check as a second candidate for `isMetaOrCtrlOnly` per the original review note, but its modifier shape genuinely differs (it doesn't exclude Shift, since Shift-Cmd-Z is redo) — left it as a direct check with a comment explaining the intentional divergence, per "decide/document is a valid outcome." The priority chain itself is unchanged, still a readable if-chain, not a table.
- **Worker clocks & recovery timeout**: documented in `replica/workerHandlers.ts`'s `WorkerDeps` that `nowMs` (data-stamp clock, timestamps written to the DB) and `clockMs` (deadline clock, checked against `prepareRecovery`'s `expiresAtMs`) are deliberately separate injection points even though both default to `Date.now()` — confirmed `workerHandlers.test.ts` fakes them independently (one test fakes only `clockMs`), so merging them would break test isolation. Replaced three bare `120_000` literals in `replica/client.ts` (`applySnapshot`, `commitRecovery`, `reset` RPC timeouts) with the existing `RECOVERY_TIMEOUT_MS` constant they were semantically duplicating, and added a comment on the constant explaining it's shared across all recovery-adjacent RPCs.
- **onDragStartBlock**: made it optional on `OutlineHandlers` (`outline/handlers.ts`) with a comment explaining why (`useOutline` has no access to the page title/dnd API a real handler needs). Removed the `onDragStartBlock: () => undefined` stub from `useOutline.ts` that existed only to satisfy the interface, and switched `EditableBlockTree.tsx`'s call site to `handlers.onDragStartBlock?.(node.uid)`. `EditablePage.tsx`'s spread + override (which supplies the real drag-start handler) is unchanged and still correct — it no longer depends on a base stub to type-check.
- **Verification**: `pnpm typecheck`, `pnpm lint`, `pnpm check:fcis` all clean; `CI=true E2E_PORT=8996 pnpm verify` (typecheck + lint + FCIS + enforced-coverage unit tests + `vite build` + Playwright e2e) passed end-to-end, exit 0 — 2245 unit tests passed, 54 e2e tests passed, coverage thresholds met.
