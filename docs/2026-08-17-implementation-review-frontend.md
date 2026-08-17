# Frontend implementation review

**Date:** 2026-08-17
**Reviewer:** pi (Zed)
**Scope:** Frontend code quality only (`web/src/`, 18.2k lines of production
TS/TSX): over-complexity / over-abstraction, duplicated code / missing
abstractions, and file & function complexity. Companion to
[2026-08-17-implementation-review.md](2026-08-17-implementation-review.md)
(backend); same methodology — architecture docs for orientation,
quantitative scans (function lengths, normalized cross-file clone windows),
then per-module deep reads with every key claim verified against the code.
**Status:** Review complete; no code fixes were made as part of this review.

## Executive assessment

High execution quality, and the failure modes are the mirror image of the
backend's. Where the backend's risks were *invariant rituals* re-typed per
call site, the frontend's are **React idioms** re-typed per component
(popover chrome, dismissal effects, stale-response guards, localStorage
preferences) — plus one genuinely large structural finding: ~22% of the
biggest file is a parallel queue implementation that never runs in a
browser.

Quantitatively:

- Components and hooks run larger than backend functions (several 100-190
  lines), but nearly all hold one job; the exceptions are itemized below.
- A normalized cross-file clone scan (8-line windows, identifiers erased)
  found 37 duplicate groups — versus the backend's zero. Almost all are the
  React-idiom patterns in A2/A6, not business logic.
- **Over-abstraction is nearly absent** — the strongest finding of the
  whole review: no needless memoization, no speculative components, no
  forwarding layers, zero `eslint-disable` comments, bundle budgets
  enforced in CI.
- Dead code is minor but real: one dead re-export, one dead state field,
  one dead event-variant, one test-only factory (B4).

## A. Missing abstractions (duplication)

### A1. `createLegacyQueue` — 210 lines of production code that only runs in jsdom — HIGH

`sync/opQueue.ts:730-941` is selected only when `replica === null`, which
`defaultReplica()` (`SyncProvider.tsx:118`) returns only where
`Worker === undefined` — i.e. never in a real browser (its own comment at
:930 admits this). It exists so `opQueue.test.ts`'s 24
`createOpQueue(null, …)` tests can run without the worker. Cost: a second
full queue — own batching via `MAX_BATCH` (:17), frozen-batch replay
(:826), `deliverOps`/`rejectBatchDeliveries` (:752-782) — that must track
every queue policy change, and `runEffects` + `dispatch` are **duplicated
verbatim** (:259-281 vs :785-807; verified). The real queue is tested
separately in `opQueue.replica.test.ts` (1,546 lines), which already has a
`memReplica()` fake.

**Fix:** point `opQueue.test.ts` at a fake `Replica`, delete the legacy
queue and `MAX_BATCH`; short of that, extract the shared dispatcher.

### A2. Popover chrome implemented twice; dismissal effect ×5 — MEDIUM

`views/FileCardPopovers.tsx:26-69` (`CardPopover`) re-implements
`components/BlockRefBacklinksPopover.tsx:25-83` near-verbatim — measure via
`useLayoutEffect` + `clampPopoverPosition`, outside-mousedown dismiss,
Escape dismiss, same `role="dialog"` class — with a comment admitting
"same trick as BlockRefBacklinksPopover." Separately, the
outside-click+Escape dismissal effect is hand-rolled in **five components**
(SearchBar :96-111, TopBar :60-75, BlockMenu :21-40, and both popovers).

**Fix:** a shared `Popover` shell next to `popoverPosition.ts` (the
`remeasure` prop is the only delta), plus a
`useDismiss(ref, {onOutside, onEscape})` hook; BlockMenu keeps its extra
roving-focus key handling.

### A3. The "single" missing-page policy is duplicated — MEDIUM

`outline/missingPage.ts` is documented as *the* statement of "404 on a
daily = empty page," but `outline/useOutline.ts:110-113` re-inlines the
exact predicate (`e.status === 404 && dateForTitle(pageTitle) !== null`)
in its registered loader (verified). A policy tweak must now be made twice
— and this loader, not the view-level guard, is what repair epochs and
remote-ops catch-up actually hit once mounted.

**Fix:** route the loader's catch through `substituteMissingDaily`.

### A4. `BacklinksSection` duplicates its pagination loop — MEDIUM

`components/BacklinksSection.tsx`: `loadAll` (:83-112) and `refresh`'s
inner loop (:118-142) are the same "fetch batches of 100, `mergeGroups`,
epoch-guard, bail on no-growth" algorithm, already drifting subtly.
`groups`/`totalPages`/`extraRefTexts` are also set in lockstep as three
separate `useState`s in 4 places — a partial update can't be caught by the
type system.

**Fix:** extract the batch-walk used by both; collapse the triple into one
`useState<{groups, totalPages, refTexts}>`.

### A5. Parity-critical SQL and lease lifecycles re-typed within the replica — MEDIUM

- `replica/apply.ts:63-67` vs `replica/localOps.ts:100-107`: identical
  `block_refs` delete+insert reindex loop. (The Python side has the same
  ritual in two files — backend finding A2 — so sharing it *within* each
  side makes the "must change together" literal on both.)
- `sync/replicaSync.ts`: `resetLocalData` (:397-445) re-implements
  `runRecovery`'s (:193-231) prepare→flush→snapshot→commit→resume lease
  lifecycle with three deltas (`ResetBlockedError`, `started = true`,
  forced ready). A lease-handling change must now be made twice.

**Fix:** extract `reindexBlockRefs(db, uid, text)` in the replica; extend
`runRecovery`'s options to cover `resetLocalData` or extract the lease
try/finally.

### A6. Systematic small React-idiom duplication — LOW, but the clearest pattern in the review

- **localStorage pref triplet**: `useTheme.ts`, `useSidebarCollapsed.ts`,
  `useBlockStampsPref.ts` each hand-roll read-with-guard-and-default +
  catch → fallback. One `useStoredPref(key, guard, fallback)` finishes the
  set.
- **Stale-response token ×5**: `SearchBar`/`CurrentWork` (`seqRef`),
  `QueryBlock` (`requestIdRef`), `AutocompletePopup` (`useTitleOptions`),
  `Files` (`generation` + `bumpGeneration`). The subtle bump-on-cancel
  discipline has already diverged between them. A `useLatestToken()` hook
  returning `{token, isStale}` would pin it in one place.
- **Scroll-and-flash effect ×2**: `views/PageView.tsx:29-39` vs
  `views/EditableSidebarPanel.tsx:26-37` — `querySelector(data-uid)` →
  `scrollIntoView` → flash class → 1600ms timeout. A
  `useFlashTarget(uid, rootRef)` hook.
- Small pure twins: `scopeContainsTitle` identical in
  `outlineSessions.ts:312` and `outlineState.ts:77`; `syncState.ts`
  reset-\* branches (:193-233) repeat the same precedence+base
  construction 3×; `map(() => "?").join(",")` SQL boilerplate ×4 in the
  replica (mirrors the server's inline style — fine to leave).

## B. Over-complexity / over-abstraction

Rare — rarer than the backend. The full list:

### B1. Test-double compat machinery in production paths — HIGH (paired with A1)

- `sync/opQueue.ts:184-190, 249-257, 612-618`: `unidentifiedDeliveries`
  is ~30 lines of FIFO-position bookkeeping for `batchId === undefined`,
  justified as serving "older workers" — but worker and main bundle ship
  from one hashed build; no skew is possible, and the real handler always
  sends a batchId. Only test doubles hit the fallback lane.
  **Fix:** make `enqueue`'s `batchId` non-optional in the `Replica`
  interface (`replica/client.ts:65`); delete the fallback accounting.
- `replica/workerHandlers.ts:172` accepts a bare-array enqueue payload
  "for older bundles and tests" — impossible skew again; only tests use
  it. Accept only the object shape.
- `replica/localApi/router.ts:46,113`: `deps?: LocalApiDeps` is optional
  only so tests can omit it. A future caller forgetting it gets no error —
  `POST /api/pages` falls through to `NOT_HANDLED` and offline page
  creation silently degrades to "online only". Make it required or
  default `newBatchId` to `crypto.randomUUID()`.

### B2. `write-started` carries a dead variant plus a fragile default — MEDIUM

`outline/outlineState.ts:43-44` gives `write-started` both `replay?` and
`ops?`; **no caller ever sends `ops`** (verified — the only dispatch site
sends `replay`). Worse, `trackWrite`'s `replay = []` default
(`outlineSessions.ts:433`) means `applyLocal`'s call (:701) would
*overwrite* the real replay recorded moments earlier by its own
`local-ops` transition — it is harmless today only because
`SyncProvider.tsx:630-633` pre-tracks every write via
`trackActiveOutlineWrite`, making that call a guarded no-op. That safety
is a cross-module ordering invariant spanning three modules that nothing
asserts.

**Fix:** delete the `ops?` variant, make `replay` required, drop the
default — a missing replay becomes a compile error instead of silent
rebase-data loss.

### B3. Loader election by registration order — MEDIUM

Three `setAuthoritativeLoader` sites (`useOutline.ts:99`,
`useOutlinePageLoad.ts:165`, `Journal.tsx:67`); selection is
`[...loaders.values()].at(-1)` — "last mounted wins", an implicit temporal
contract documented only in a comment inside useOutline. A remount-order
change silently swaps fetch behavior.

**Fix:** named loader kinds (`"page"`, `"day"`) with explicit precedence.

### B4. Dead code, minor but real

- `replica/localApi/router.ts:148` re-exports `escapeFtsQuery` /
`titleForDate` with zero importers (verified; everything imports from
`./fts` / `../daily` directly) — the imports at :9/:15 exist solely to
feed it. Delete all three lines.
- `RepairEpoch.id` / `nextRepairEpoch` (`outlineSessions.ts:124, 867`)
  are written and never read — dead state.
- `moveBlockUp`/`moveBlockDown` are exported with no non-test callers;
  `syncState.createSyncState` is test-only.

## C. File and function complexity

| Location | Size | Assessment |
|---|---|---|
| `sync/opQueue.ts` | 950 L | The replica queue's ~470 lines are **earned** — fallback-lane ordering, poison-intent retention, `missedKick` each encode incident-referenced invariants. The bloat is A1/B1 and `runDrain` (:369-522, ~154 L) interleaving four jobs — lane-head delivery, unavailable policy, durable delivery, and a 35-line 4xx poison protocol whose ordering invariants (pause → poisonPending → rememberPoisonMark → finishDelivery → durableBatchSettled → markRetainedPoison) live only in comments. Extract `rejectDurableBatch`/`deliverLaneHead`; also `laneOnly` (:394) is a side-effecting predicate with a misleading name — rename `clearDurablePrecedence()`. Fixing A1/B1/runDrain lands ~650 defensible lines. |
| `outline/outlineSessions.ts` | 882 L | The intricacy is mostly *essential* (ReadToken supersession, reservations, repair epochs are genuinely hard), but the colocation is accidental: (a) registry/refcount/lease (~150 L, clean), (b) parent-read election (~200 L; 8 of ~24 `Session` fields plus `scheduleParentElection`/`publishParentPayload`/`abandonManualRead`), (c) repair epochs (~120 L). Extracting (b) as a `ParentReadElector` and (c) as its own module leaves ~350 readable lines each and makes the election machine testable in isolation. |
| `sync/SyncProvider.tsx` | 646 L | Honest density — refs-assigned-per-render are consistent and every race workaround documents its cause. But the mount effect (:456-528) carries five concerns (initial pending read, `finishReconnect` single-flight, drain-observer wiring, socket connect with a 35-line `onStatus`, StrictMode cleanup); `retryProblem` (:566-601) is a 35-line kind×repair dispatch inline in a `useMemo` with two duplicated `replicaSync?.start()` calls; and `statusRef` (:243) is declared *after* the memo (:421) that closes over it — legal (called post-render) but TDZ-fragile. |
| `outline/keyboardPolicy.ts::decideEditorKey` | ~157 L | The linear priority chain *is* the spec — do not table-drive it away. But the modifier guards (`i.shiftKey && i.metaKey && !i.ctrlKey && !i.altKey` and kin) repeat ~8×; a `chord(i, {shift, meta})` predicate helper would make the "which modifiers are excluded" policy checkable at a glance. |
| `components/OfflineIndicator.tsx` | 164 L | One 110-line nested ternary: 5 problem kinds × up to 4 repair states, three deep, with the `role` ternary repeated per kind and pluralization copy repeated 6×. Correct but unreadable. Per-kind banner components (or a `Record<kind, () => JSX>`) fix the shape. |
| `App.tsx` (193), `PdfViewer` (173), `SearchBar` (169), `EditableBlockTree` (142), `BlockInput.onKeyDown` (136) | — | All fine — the policy-decides/component-executes split is holding; guards and generation counters are load-bearing, not ceremonial. |
| `outline/outlineState.ts::transitionOutline` | ~112 L | Flat and well-commented, but the tail after the authoritative branch assumes `write-settled` by fallthrough — a `switch` would give compiler-enforced exhaustiveness so a new event type can't silently fall into settlement handling. |
| `replica/localOps.ts::applyOne` | ~86 L | *Not* a problem: a discriminated-union switch mirroring server op semantics with timestamp rules commented inline (`set_collapsed`, pkm-r7k8). Splitting it would scatter the mirroring. Right call. |

### Correctness-adjacent flags

- **`components/TopBar.tsx:46-58` — a confirmed page delete that fails is
  completely silent.** `catch { deleted = false }`, the menu closes,
  nothing is shown. Every sibling (`PageTitle`, `SidebarNav`, `Files`)
  surfaces errors. **Fix:** set an error and render it, or report through
  the confirm dialog.
- **`components/EditableBlockTree.tsx:297-302` — `focusInSubtree` is
  O(n·depth) per block per render**, and the tree re-renders on every
  keystroke batch. Compute the focused block's ancestor chain once at the
  root and pass `focusInSubtree: boolean` down.
- **`outline/outlineState.ts:81-83` — `changed()` is a full-tree
  `JSON.stringify` compare on every transition** (each keystroke batch,
  each remote batch). Correct, but a `didChange` flag out of `applyOps`
  would remove a hidden per-keystroke cost.
- **`replica/workerHandlers.ts` — `WorkerDeps` has both `nowMs` and
  `clockMs`** defaulting to `Date.now()` with no comment on why two clocks
  exist (data-stamping vs deadline measurement). One line of docs would
  prevent a bad "simplification".
- **`replica/client.ts:13` — `RECOVERY_TIMEOUT_MS` defined, but
  `applySnapshot`/`commitRecovery`/`reset` (:111, :125, :127) use bare
  `120_000`.** Are they the same timeout or coincidentally equal? Named
  constants answer that.

## What's notably good

- **`grammar/scan.ts`** — the one-scanner discipline is real and enforced
  by consumers deriving from the token stream: explicit-stack bracket
  matching (no recursion, no stack overflow on deep nesting), code blanking
  before recognition, post-hoc span validation. Exemplary.
- **`api/typedClient.ts`** — type-level work where every conditional type
  carries its justification in prose; the compile-time drift probes in
  `typedClient.test.ts` (expected-error directives that stop erroring fail
  the build) are a genuinely clever anti-rot device.
- **`sync/queueState.ts` / `syncState.ts`** — pure FSMs that make the FCIS
  split pay: real precedence/lifecycle policy, tested with zero mocks.
  queueState is exemplary.
- **`outline/tree.ts::applyOps`** — mirrors the server's op semantics in
  one pure function; the same ops drive the screen, the replica, and the
  server.
- **The `OutlineHandlers` port** stays a callback interface for the argued
  reason — every member is already a distinct, individually-typed
  operation; a command union would add a name and a switch case per member
  without removing one. Verified sound. (One wrinkle:
  `onDragStartBlock`'s base stub in `useOutline.ts:438` exists "only to
  satisfy OutlineHandlers" and forces `EditablePage.tsx:53-66` to
  spread-override it — make the member optional or consume `useDnd()` in
  the hook.)
- **Testing discipline:** coverage enforced (95/91/89/95), E2E harness
  that fails on any HTTP 5xx, server-side exceptions failing teardown,
  `waitForServerText` polling the server's copy instead of the DOM.
- **Almost zero over-abstraction** — the systematic weakness is
  react-idiom duplication (dismissal, popovers, stale-guards,
  flash-scroll), not complexity.

## Suggested order of attack

1. **A1 + B1** — delete the legacy queue and the test-double
   accommodations behind it (biggest single win; −210 lines of
   must-track-it-forever surface, plus the fallback accounting).
2. **B2** — make `replay` required and delete the dead `ops?` variant
   (type-level safety for rebase data).
3. **A2 + A3 + A4** — the popover shell + `useDismiss`, the
   missing-page-policy dedup, the BacklinksSection batch-walk.
4. **TopBar silent delete** — one-liner-adjacent UX bug.
5. **A6's `useStoredPref` / `useLatestToken`** — pins two disciplines that
   have already diverged once each.
6. **The big decompositions at leisure** — `runDrain`, `outlineSessions`
   three-way split, `SyncProvider` mount effect, `OfflineIndicator`
   per-kind banners.
