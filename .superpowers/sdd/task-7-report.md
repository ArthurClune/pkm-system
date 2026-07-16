# Task 7 report: Extract pure editor and sync state machines (pkm-wudz)

## Status: DONE_WITH_CONCERNS

Behaviour is preserved and every suite is green; the concerns are scoping notes
(replicaSync left as a shell; some brief "table cases" were already covered by
pre-existing pure tests), not defects.

## What was implemented (each core/shell boundary)

### Editor keyboard core
- **New** `web/src/outline/keyboardPolicy.ts` (`// pattern: Functional Core`):
  `decideEditorKey(EditorKeyInput): KeyDecision`. Pure decision for a focused
  block's textarea keydown, mirroring the former inline chain exactly:
  autocomplete precedence, Escape→blur, Ctrl-O ref navigation, Shift+Arrow
  block-selection (edge/caret-only), read-only cutoff, Ctrl+Alt+digit heading
  chord, Cmd-K link, bracket auto-pair, split/indent/outdent/move/backspace,
  boundary arrows, and browser-default (`none`). It calls the existing pure
  helpers `refTitleAtCaret`, `autoPairBracket`, `wrapLink`.
- **Shell** `web/src/components/EditableBlockTree.tsx`: `BlockInput.onKeyDown`
  now reads live DOM + autocomplete state, calls `decideEditorKey`, and
  executes the returned decision (`preventDefault`, `blur`, navigation,
  `applyKeyEdit`, handler calls). Exhaustive `switch` with a `never` default.

### Outline edit/upload core
- **Extended** `web/src/outline/outlineState.ts`: added
  `pendingTextOps(pending, blocks)` (debounced-draft flush decision: none / no
  node / unchanged → `[]`) and `spliceUploadedMarkdown(text, offset, markdown):
  TextSelection` (clamped asset splice).
- **Shell** `web/src/outline/useOutline.ts`: `takePendingTextOps` and `onFiles`
  now delegate to those helpers.

### Queue core
- **New** `web/src/sync/queueState.ts` (`// pattern: Functional Core`):
  `transitionQueue(QueueState, QueueEvent): QueueTransition` and the
  `terminalReason` selector. Models the connectivity + retry-backoff policy
  shared verbatim by both queue variants: `set-online`, `pause`, `resume`,
  `dispose`, `batch-succeeded`, `delivery-failed` (terminal vs retryable
  classification + escalating `RETRY_DELAYS` backoff), `retry-fired`. Effects
  are `clear-timer` / `start-timer` / `kick`.
- **Shell** `web/src/sync/opQueue.ts`: both `createReplicaQueue` and
  `createLegacyQueue` now hold a `qstate`, dispatch events through a `dispatch`
  helper that runs effects (owning the `retryTimer` handle, `kick`, `drain`),
  and classify drain outcomes via `terminalReason(qstate)` /
  `transition.blockedReason`. Promises, deliveries, persistence, poison marking,
  and `drainRun` orchestration stay in the shell.

### Sync core
- **New** `web/src/sync/syncState.ts` (`// pattern: Functional Core`):
  `transitionSync(SyncState, SyncEvent): SyncTransition`, plus
  `computeEditability(status, mode, quota)` selector. Owns the delivery-health
  problem lifecycle (rejected-batch mark-failed/running/repaired/failed, legacy
  repair phases, poison-discovery failed/cleared, dismiss-if-repaired), the
  mode-ready resync decision, and the editability rule. Effect is `bump-resync`.
  `SyncProblem` / `SyncStatus` types moved here (re-exported from SyncProvider).
- **Shell** `web/src/sync/SyncProvider.tsx`: an `applySync(event)` helper reads
  the current problem (`problemRef.current`), calls `transitionSync`, and — under
  the existing mounted guard — applies the next problem via `setProblem` and runs
  `bump-resync` via `setResyncSeq`. Every former `setProblem` call site, the
  mode-ready `useEffect`, and `dismissProblem`'s clear now route through it;
  `canEdit`/`readOnlyReason` come from `computeEditability`. All sockets, queue
  and replica I/O, refs, single-flight, and mounted guards remain in the shell.

## TDD evidence

**RED (Step 1, editor/outline):**
`pnpm vitest run src/outline/outlineState.test.ts src/outline/keyboardPolicy.test.ts`
→ `TypeError: (0 , spliceUploadedMarkdown) is not a function` and the
keyboardPolicy module failed to import (missing file): `2 failed`. Expected —
the pure functions did not exist yet.

**RED (Step 2, queue/sync):** the new `queueState.test.ts` / `syncState.test.ts`
could not resolve their modules until the cores were written (files created
after their tests). The exhaustiveness tests assert `transitionQueue` /
`transitionSync` throw on an unknown event.

**GREEN:**
- `src/outline/outlineState.test.ts src/outline/keyboardPolicy.test.ts` → 55 passed
  (one of my own new keyboard assertions was corrected: a non-collapsed
  Shift+ArrowUp at offset 0 falls through to `arrow up`, exactly as the original
  inline code did — the implementation was right, the test expectation was
  wrong).
- `src/sync/queueState.test.ts` → 11 passed.
- `src/sync/syncState.test.ts` → 17 passed.

**Step 5 matrix** (all nine files):
`... outlineState keyboardPolicy EditableBlockTree queueState syncState opQueue.replica opQueue SyncProvider replicaSync` → **249 passed (9 files)**.

**Coverage** (`pnpm test:coverage`, exit 0): All files **97.88% stmts /
92.01% branches / 95.6% funcs / 97.88% lines** — above the 95/91/89/95
thresholds. New cores: `keyboardPolicy.ts`, `queueState.ts`, `syncState.ts` all
100%; `outlineState.ts` 97.22% (the uncovered 199-202/209-210 are the
pre-existing `write-replay` branch, untouched). Full unit suite: **905 tests /
75 files passed**, no act() warnings or unhandled rejections.

## Files changed
- Added: `web/src/outline/keyboardPolicy.ts` (+ `.test.ts`),
  `web/src/sync/queueState.ts` (+ `.test.ts`), `web/src/sync/syncState.ts`
  (+ `.test.ts`).
- Modified: `web/src/outline/outlineState.ts` (+ `.test.ts`),
  `web/src/outline/useOutline.ts`, `web/src/components/EditableBlockTree.tsx`,
  `web/src/sync/opQueue.ts`, `web/src/sync/SyncProvider.tsx`,
  `.beans/pkm-wudz--...md`.

## Commits
- `f22ab39` refactor(web): extract editor keyboard and outline cores
- `261f1fc` refactor(web): extract editor and sync state cores

## Self-review findings
- Completeness: all five brief interfaces produced; Step 1/2 table cases present
  (keyboard: ac precedence/Escape/Ctrl-O/Shift+Arrow/read-only/heading/Cmd-K/
  brackets/split/indent/move/backspace/boundary arrows/browser default; outline:
  pending-flush before structural op, no-op draft, missing target, upload clamp;
  queue: enqueue/persist/deliver/ack via opQueue suites, offline/5xx retry/4xx
  poison/pause-resume/dispose in queueState; sync: replica-unavailable
  editability, repair success/failure, resync-only-when-ready, mode-ready).
- Behaviour preservation: **no existing shell test needed a semantic change.**
  The only edited test expectation was in my own new keyboardPolicy suite.
- Discipline: no generalized framework; each union carries only shell-exercised
  behaviour; every switch is exhaustive with a `never` assert (throwing, and the
  throw is covered by a test).
- Pure tests use no React/fetch/worker/SQLite mocks.

## Concerns
1. **replicaSync.ts left as a shell (listed as "Modify" in the brief).** Its
   deterministic bits (poison-vs-normal recovery ordering, `authoritativeRepair`
   gating, pull-loop bootstrap/rebase decisions) are control flow interleaved
   with lease/snapshot/feed I/O; I could not carve out a pure sub-policy
   distinct from the queue/sync cores without inventing a speculative union
   (which the "only shell-exercised behavior / avoid frameworks" rule forbids).
   Behaviour is unchanged; its `ReplicaState` type is now consumed by syncState
   via a type-only import. Flagging rather than forcing an artificial split.
2. **Some Step 1 "table cases" were already covered by pre-existing pure tests**
   (focus invalidation, remote-move authoritative-read, the causality/repair
   cases) in `outlineState.test.ts`. I added the genuinely new pure cases
   (keyboard, upload clamp, pending flush) rather than duplicating existing
   coverage.
3. **`pnpm verify` (full, incl. Playwright e2e) not run** — left the bean's
   "pnpm verify passes" criterion unchecked per the task instructions;
   typecheck + coverage were run and pass. The controller verifies e2e.
4. No behaviour bug found in the extracted Task 1-6 semantics; all preserved
   verbatim.
