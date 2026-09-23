# Frontend implementation review

**Date:** 2026-08-17
**Reviewer:** pi (Zed)
**Scope:** Frontend code quality only (`web/src/`, 18.2k lines of production
TS/TSX): over-complexity and over-abstraction, duplicated code and missing
abstractions, file and function complexity. Companion to
[2026-08-17-implementation-review-backend.md](2026-08-17-implementation-review-backend.md).
Method: architecture docs for orientation, function-length and clone scans,
then per-module reads checked against the code.
**Status:** Review complete; no code fixes were made as part of this review.

## Executive assessment

Execution quality is high. The backend's weak spot was invariant rituals
re-typed per call site; the frontend's is **React idioms** re-typed per
component (popover chrome, dismissal effects, stale-response guards,
localStorage preferences). The one large structural finding: ~22% of the
biggest file is a parallel queue implementation that never runs in a browser.

- Components and hooks run longer than backend functions (several 100-190
  lines), but nearly all do one job; the exceptions are listed below.
- A normalized cross-file clone scan (8-line windows, identifiers erased)
  found 37 duplicate groups, against the backend's zero. Almost all are the
  React-idiom patterns in A2/A6, not business logic.
- **Over-abstraction is nearly absent**: no needless memoization, no
  speculative components, no forwarding layers, zero `eslint-disable`
  comments, bundle budgets enforced in CI.
- Dead code is minor: one dead re-export, one dead state field, one dead
  event variant, one test-only factory (B4).

## A. Missing abstractions (duplication)

### A1. `createLegacyQueue` — 210 lines of production code that only runs in jsdom — HIGH

`sync/opQueue.ts:730-941` is selected only when `replica === null`, which
`defaultReplica()` (`SyncProvider.tsx:118`) returns only where
`Worker === undefined`, so never in a real browser (its own comment at :930
says so). It exists so the 24 `createOpQueue(null, …)` tests in
`opQueue.test.ts` can run without the worker. The cost is a second full queue
that must track every queue policy change: its own batching via `MAX_BATCH`
(:17), frozen-batch replay (:826), `deliverOps`/`rejectBatchDeliveries`
(:752-782). `runEffects` + `dispatch` are **duplicated verbatim** (:259-281 vs
:785-807; verified). The real queue is tested separately in
`opQueue.replica.test.ts` (1,546 lines), which already has a `memReplica()`
fake.

**Fix:** point `opQueue.test.ts` at a fake `Replica` and delete the legacy
queue and `MAX_BATCH`; failing that, extract the shared dispatcher.

### A2. Popover chrome implemented twice; dismissal effect ×5 — MEDIUM

`views/FileCardPopovers.tsx:26-69` (`CardPopover`) re-implements
`components/BlockRefBacklinksPopover.tsx:25-83` almost verbatim: measure via
`useLayoutEffect` + `clampPopoverPosition`, outside-mousedown dismiss, Escape
dismiss, same `role="dialog"` class. Its comment says "same trick as
BlockRefBacklinksPopover." Separately, the outside-click+Escape dismissal
effect is hand-rolled in **five components** (SearchBar :96-111, TopBar
:60-75, BlockMenu :21-40, and both popovers).

**Fix:** a shared `Popover` shell next to `popoverPosition.ts` (the
`remeasure` prop is the only difference), plus a
`useDismiss(ref, {onOutside, onEscape})` hook; BlockMenu keeps its extra
roving-focus key handling.

### A3. The "single" missing-page policy is duplicated — MEDIUM

`outline/missingPage.ts` is documented as *the* statement of "404 on a daily =
empty page," but `outline/useOutline.ts:110-113` re-inlines the same predicate
(`e.status === 404 && dateForTitle(pageTitle) !== null`) in its registered
loader (verified). A policy change must be made twice, and once mounted it is
this loader, not the view-level guard, that repair epochs and remote-ops
catch-up hit.

**Fix:** route the loader's catch through `substituteMissingDaily`.

### A4. `BacklinksSection` duplicates its pagination loop — MEDIUM

In `components/BacklinksSection.tsx`, `loadAll` (:83-112) and `refresh`'s
inner loop (:118-142) are the same algorithm (fetch batches of 100,
`mergeGroups`, epoch-guard, stop on no growth) and have started to drift.
`groups`/`totalPages`/`extraRefTexts` are also set together as three separate
`useState`s in 4 places, so the type system cannot catch a partial update.

**Fix:** extract the batch walk both use; collapse the three into one
`useState<{groups, totalPages, refTexts}>`.

### A5. Parity-critical SQL and lease lifecycles re-typed within the replica — MEDIUM

- `replica/apply.ts:63-67` vs `replica/localOps.ts:100-107`: identical
  `block_refs` delete+insert reindex loop. The Python side has the same ritual
  in two files (backend finding A2), so sharing it within each side makes
  "must change together" hold literally on both.
- `sync/replicaSync.ts`: `resetLocalData` (:397-445) re-implements the
  prepare→flush→snapshot→commit→resume lease lifecycle of `runRecovery`
  (:193-231) with three differences (`ResetBlockedError`, `started = true`,
  forced ready). A lease-handling change must be made twice.

**Fix:** extract `reindexBlockRefs(db, uid, text)` in the replica; extend
`runRecovery`'s options to cover `resetLocalData`, or extract the lease
try/finally.

### A6. Systematic small React-idiom duplication — LOW, but the clearest pattern in the review

- **localStorage pref triplet**: `useTheme.ts`, `useSidebarCollapsed.ts`,
  `useBlockStampsPref.ts` each hand-roll read-with-guard-and-default +
  catch → fallback. One `useStoredPref(key, guard, fallback)` would cover all
  three.
- **Stale-response token ×5**: `SearchBar`/`CurrentWork` (`seqRef`),
  `QueryBlock` (`requestIdRef`), `AutocompletePopup` (`useTitleOptions`),
  `Files` (`generation` + `bumpGeneration`). The bump-on-cancel discipline has
  already diverged between them. A `useLatestToken()` hook returning
  `{token, isStale}` would pin it in one place.
- **Scroll-and-flash effect ×2**: `views/PageView.tsx:29-39` vs
  `views/EditableSidebarPanel.tsx:26-37`: `querySelector(data-uid)` →
  `scrollIntoView` → flash class → 1600ms timeout. Candidate for a
  `useFlashTarget(uid, rootRef)` hook.
- Small pure twins: `scopeContainsTitle` identical in
  `outlineSessions.ts:312` and `outlineState.ts:77`; `syncState.ts`
  reset-\* branches (:193-233) repeat the same precedence+base construction
  3×; `map(() => "?").join(",")` SQL boilerplate ×4 in the replica (matches
  the server's inline style; fine to leave).

## B. Over-complexity / over-abstraction

Rarer than in the backend. The full list:

### B1. Test-double compat machinery in production paths — HIGH (paired with A1)

- `sync/opQueue.ts:184-190, 249-257, 612-618`: `unidentifiedDeliveries` is
  ~30 lines of FIFO-position bookkeeping for `batchId === undefined`,
  justified as serving "older workers". Worker and main bundle ship from one
  hashed build, so no skew is possible, and the real handler always sends a
  batchId. Only test doubles reach the fallback lane.
  **Fix:** make `enqueue`'s `batchId` non-optional in the `Replica` interface
  (`replica/client.ts:65`); delete the fallback accounting.
- `replica/workerHandlers.ts:172` accepts a bare-array enqueue payload "for
  older bundles and tests". The same skew is impossible here, and only tests
  use it. Accept only the object shape.
- `replica/localApi/router.ts:46,113`: `deps?: LocalApiDeps` is optional only
  so tests can omit it. A future caller that forgets it gets no error:
  `POST /api/pages` falls through to `NOT_HANDLED` and offline page creation
  quietly degrades to "online only". Make it required, or default
  `newBatchId` to `crypto.randomUUID()`.

### B2. `write-started` carries a dead variant plus a fragile default — MEDIUM

`outline/outlineState.ts:43-44` gives `write-started` both `replay?` and
`ops?`; **no caller sends `ops`** (verified; the only dispatch site sends
`replay`). And `trackWrite`'s `replay = []` default (`outlineSessions.ts:433`)
means `applyLocal`'s call (:701) would *overwrite* the replay its own
`local-ops` transition recorded moments earlier. It is harmless today only
because `SyncProvider.tsx:630-633` pre-tracks every write via
`trackActiveOutlineWrite`, which makes that call a guarded no-op. Nothing
asserts that ordering, and it spans three modules.

**Fix:** delete the `ops?` variant, make `replay` required, drop the default.
A missing replay then becomes a compile error instead of silent rebase-data
loss.

### B3. Loader election by registration order — MEDIUM

There are three `setAuthoritativeLoader` sites (`useOutline.ts:99`,
`useOutlinePageLoad.ts:165`, `Journal.tsx:67`), and selection is
`[...loaders.values()].at(-1)`: last mounted wins. That temporal contract is
documented only in a comment inside useOutline. A change in remount order
silently swaps fetch behavior.

**Fix:** named loader kinds (`"page"`, `"day"`) with explicit precedence.

### B4. Dead code, minor

- `replica/localApi/router.ts:148` re-exports `escapeFtsQuery` /
  `titleForDate` with zero importers (verified; everything imports from
  `./fts` / `../daily` directly), and the imports at :9/:15 exist only to feed
  it. Delete all three lines.
- `RepairEpoch.id` / `nextRepairEpoch` (`outlineSessions.ts:124, 867`) are
  written and never read.
- `moveBlockUp`/`moveBlockDown` are exported with no non-test callers;
  `syncState.createSyncState` is test-only.

## C. File and function complexity

| Location | Size | Assessment |
|---|---|---|
| `sync/opQueue.ts` | 950 L | The replica queue's ~470 lines are **justified**: fallback-lane ordering, poison-intent retention, and `missedKick` each encode invariants tied to incidents. The excess is A1/B1 plus `runDrain` (:369-522, ~154 L), which interleaves four jobs: lane-head delivery, unavailable policy, durable delivery, and a 35-line 4xx poison protocol whose ordering (pause → poisonPending → rememberPoisonMark → finishDelivery → durableBatchSettled → markRetainedPoison) is recorded only in comments. Extract `rejectDurableBatch`/`deliverLaneHead`. `laneOnly` (:394) is a side-effecting predicate with a misleading name; rename it `clearDurablePrecedence()`. Fixing A1/B1/runDrain leaves ~650 defensible lines. |
| `outline/outlineSessions.ts` | 882 L | Most of the intricacy is *essential* (ReadToken supersession, reservations, and repair epochs are hard problems), but the colocation is accidental: (a) registry/refcount/lease (~150 L, clean), (b) parent-read election (~200 L; 8 of ~24 `Session` fields plus `scheduleParentElection`/`publishParentPayload`/`abandonManualRead`), (c) repair epochs (~120 L). Extracting (b) as a `ParentReadElector` and (c) as its own module leaves ~350 readable lines each and makes the election machine testable alone. |
| `sync/SyncProvider.tsx` | 646 L | Dense for good reason: refs assigned per render are consistent, and every race workaround documents its cause. But the mount effect (:456-528) carries five concerns (initial pending read, `finishReconnect` single-flight, drain-observer wiring, socket connect with a 35-line `onStatus`, StrictMode cleanup); `retryProblem` (:566-601) is a 35-line kind×repair dispatch inline in a `useMemo` with two duplicated `replicaSync?.start()` calls; and `statusRef` (:243) is declared *after* the memo (:421) that closes over it, which is legal (called post-render) but TDZ-fragile. |
| `outline/keyboardPolicy.ts::decideEditorKey` | ~157 L | The linear priority chain *is* the spec; do not table-drive it away. But the modifier guards (`i.shiftKey && i.metaKey && !i.ctrlKey && !i.altKey` and kin) repeat ~8×; a `chord(i, {shift, meta})` predicate helper would make the excluded-modifiers policy checkable at a glance. |
| `components/OfflineIndicator.tsx` | 164 L | One 110-line nested ternary: 5 problem kinds × up to 4 repair states, three deep, with the `role` ternary repeated per kind and pluralization copy repeated 6×. Correct but unreadable. Per-kind banner components (or a `Record<kind, () => JSX>`) fix the shape. |
| `App.tsx` (193), `PdfViewer` (173), `SearchBar` (169), `EditableBlockTree` (142), `BlockInput.onKeyDown` (136) | — | All fine. The policy-decides/component-executes split is holding, and the guards and generation counters each prevent a real failure. |
| `outline/outlineState.ts::transitionOutline` | ~112 L | Flat and well commented, but the tail after the authoritative branch assumes `write-settled` by fallthrough. A `switch` would give compiler-enforced exhaustiveness, so a new event type cannot silently fall into settlement handling. |
| `replica/localOps.ts::applyOne` | ~86 L | *Not* a problem: a discriminated-union switch mirroring server op semantics, with timestamp rules commented inline (`set_collapsed`, pkm-r7k8). Splitting it would scatter the mirroring. Right call. |

### Correctness-adjacent flags

- **`components/TopBar.tsx:46-58`: a confirmed page delete that fails is
  completely silent.** `catch { deleted = false }`, the menu closes, nothing
  is shown. Every sibling (`PageTitle`, `SidebarNav`, `Files`) surfaces
  errors. **Fix:** set an error and render it, or report through the confirm
  dialog.
- **`components/EditableBlockTree.tsx:297-302`: `focusInSubtree` is
  O(n·depth) per block per render**, and the tree re-renders on every
  keystroke batch. Compute the focused block's ancestor chain once at the root
  and pass `focusInSubtree: boolean` down.
- **`outline/outlineState.ts:81-83`: `changed()` is a full-tree
  `JSON.stringify` compare on every transition** (each keystroke batch, each
  remote batch). Correct, but a `didChange` flag out of `applyOps` would
  remove a hidden per-keystroke cost.
- **`replica/workerHandlers.ts`: `WorkerDeps` has both `nowMs` and
  `clockMs`**, both defaulting to `Date.now()`, with no comment on why two
  clocks exist (data stamping vs deadline measurement). One line of docs would
  prevent a bad "simplification".
- **`replica/client.ts:13`: `RECOVERY_TIMEOUT_MS` is defined, but
  `applySnapshot`/`commitRecovery`/`reset` (:111, :125, :127) use bare
  `120_000`.** Named constants would say whether these are the same timeout or
  coincidentally equal.

## What's good

- **`grammar/scan.ts`**: the one-scanner discipline is real and enforced by
  consumers deriving from the token stream: explicit-stack bracket matching
  (no recursion, no stack overflow on deep nesting), code blanking before
  recognition, post-hoc span validation.
- **`api/typedClient.ts`**: every conditional type carries its justification
  in prose, and the compile-time drift probes in `typedClient.test.ts`
  (expected-error directives that fail the build once they stop erroring) are
  an effective anti-rot device.
- **`sync/queueState.ts` / `syncState.ts`**: pure FSMs that make the FCIS
  split pay off, with real precedence/lifecycle policy tested with zero mocks.
  queueState is the better of the two.
- **`outline/tree.ts::applyOps`** mirrors the server's op semantics in one
  pure function; the same ops drive the screen, the replica, and the server.
- **The `OutlineHandlers` port** stays a callback interface: every member is
  already a distinct typed operation, so a command union would add a name and
  a switch case per member and remove nothing. Verified. One wrinkle: `onDragStartBlock`'s base stub in
  `useOutline.ts:438` exists "only to satisfy OutlineHandlers" and forces
  `EditablePage.tsx:53-66` to spread-override it. Make the member optional or
  consume `useDnd()` in the hook.
- **Testing discipline:** coverage enforced (95/91/89/95), an E2E harness that
  fails on any HTTP 5xx, server-side exceptions failing teardown, and
  `waitForServerText` polling the server's copy instead of the DOM.

## Suggested order of attack

1. **A1 + B1**: delete the legacy queue and the test-double accommodations
   behind it. Biggest single win: −210 lines that would otherwise need to
   track every queue change, plus the fallback accounting.
2. **B2**: make `replay` required and delete the dead `ops?` variant
   (type-level safety for rebase data).
3. **A2 + A3 + A4**: the popover shell + `useDismiss`, the missing-page-policy
   dedup, the BacklinksSection batch walk.
4. **TopBar silent delete**: a near-one-line UX bug fix.
5. **A6's `useStoredPref` / `useLatestToken`**: each pins a discipline that
   has already diverged once.
6. **The big decompositions, when convenient**: `runDrain`, the
   `outlineSessions` three-way split, the `SyncProvider` mount effect,
   `OfflineIndicator` per-kind banners.
