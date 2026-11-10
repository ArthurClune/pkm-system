# W7 Outline Command Core: Task-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Implementers work under the epic's implementer brief; this plan does not restate it.

**Goal:** The outline property composes the same cores the editor runs, a draft's base has one source, the engine imports nothing from UI code, and slash picks, uploads, cross-page drops and the `/date` Escape each have one owner.

**Architecture:** Two new Functional Core modules, `outline/command.ts` (`planCommand`, `planReplay`) and `outline/draft.ts` (the draft vocabulary), called by `useOutline.run`, `undoManager`'s two dispatch paths and `props/outline/run.ts`. The shells keep timers, notices, the session, `enqueue` and focus. The remaining items are small moves and one exhaustive union each.

**Tech stack:** React 18 hooks, vitest + jsdom, fast-check (`web/src/props/gate.ts`), typescript-eslint.

**Source:** `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md` § W7 and its Global Constraints and Review Focus; evidence in the gitignored review report `05-outline.md`. Branch `refactor/outline-command-core`, stacked on W17 (`chore/gates-and-tooling`, not yet merged; its property drivers already run through `props/gate.ts`). Read at `6a98f601`; W1, W4, W6 and W16 are merged.

## Global Constraints

The epic's Global Constraints apply unchanged. The ones that bite here:

- Web verification for implementers is the web gates without Playwright: `cd web && pnpm typecheck && pnpm lint && pnpm lint:comments && pnpm check:fcis && pnpm test:coverage && pnpm build` (all with `--config.verify-deps-before-run=false`; never `pnpm add/install/update`, `node_modules` is a symlink).
- `perf/check.sh frontend` and `proptest/check.sh web` before merge (outline edit commands, undo history). Orchestrator only, serially.
- Do not re-propose: an editing-vs-selecting mode union, folding `usable` into `ReplicaState`, changing `OpsAck.applied`, removing the replay budget, splitting `styles.css`.
- A changed state machine gets a property test: the draft protocol changes in Task 2, and `outline/draft.prop.ts` already drives it through the real editor; it must stay green on recorded seeds.
- Comments: no bean ids, line numbers or plan pointers; 80 columns in comments; AGENTS.md's banned word stays out. Docs under `docs/architecture/` go through the `architecture-docs` skill.

## Review Focus

Inputs no task's tests are certain to exercise, most likely to bite first. Each line names the test that pins it.

1. Typing right after a flush whose send a remote edit overtook: the next draft must base on what the textarea shows after adopting, not on the flushed text. Task 2 test `a draft after a flush bases on the shown text, not the flushed text`.
2. Typing right after Cmd+Z or an upload into a focused block, once `settle()` is gone: the textarea shows the undone or uploaded text and the next flush hashes it. The four `EditablePage.test.tsx` tests the `settle()` fix added, plus `e2e/undo.spec.ts` in Chromium (Task 5).
3. A command refused while a draft is pending: the draft still ships, is recorded as an undo entry of its own, the notice shows, and fresh uploads are released. Task 3 `command.test.ts` and the existing `useOutline.textLimits.test.tsx` case "a refused command still ships and applies the block's draft".
4. A cross-page drop of a multi-block selection: blocks land in selection order at consecutive keys, and a repair replays the inserts. Task 6 `planCrossPageDrop` tests and the existing `DndContext.test.tsx` drop cases.
5. `/date`, then Escape while an IME composition is open: the IME keeps the key and the picker stays open. Task 9 policy test.

---

## Where the code disagrees with W7

The code wins in each case; the tasks below are written to the code.

| W7 says | The code says | Consequence |
|---|---|---|
| `PlannedCommand` is `{ refusal, next, wireOps, entry, focusAfter }` | `run()` also needs to know whether the command planned any ops: a judged command sets `editNotice` to the verdict (clearing it on success), a command with no ops leaves it alone. The entry needs `freshAssets`. The runner's `Step` reports `base`, the command's own ops, and `inverse` even when it is `null` (`checks.ts` reports a missing inverse as `undoable`) | Task 3's `PlannedCommand` carries a `verdict` union, `base`, `ops`, `inverse`; `planCommand` takes `freshAssets` |
| `planCommand(pre, pending, fn, …)` replaces `run()`'s pure part | `run()` first drops an unshown refused draft and refuses a draft whose titles the server refuses (`draftRefusal`), and taking the draft ends it (timer, `endDraft` listeners). Those stay in the shell | The shell judges and takes the draft, then passes the taken draft to `planCommand` |
| `planReplay(...) → { refusal, wireOps }` | The runner's replay step reports the re-keyed, unstamped batch and the tree it leaves; `dispatchUnmounted`'s read-failed branch ships the recorded batch unresolved and unstamped | `PlannedReplay` adds `resolved` and `next`; `live: null` returns the batch as is |
| `props/outline/run.ts` calls both cores and deletes its copies | Its teeth swap `invertOps` through the runner's `Seam`. Once `planCommand` owns the inversion the seam cannot reach it. `run.test.ts` "a batch with no inverse is not recorded" uses the same seam | Task 4 swaps `invertOps` with `vi.mock` and a hoisted switch, as `imeTeeth.prop.ts` does with `useBlockDraft`. The no-inverse case moves to `command.test.ts` (a cross-page move is the real `null`) |
| Red test: "the runner's recorded entry equals `planCommand`'s for a seeded sequence" | Once the runner calls `planCommand`, that equality holds by construction and cannot fail | Task 4's red test: every batch the runner reports is an array a core returned (identity, through a spy) |
| `command.test.ts`: "a text op for a block the command deletes is not recorded" | `run()` leaves out a text op for a block absent from `pre`, the tree before the flush (a draft whose block a remote batch removed). A block the command itself deletes is in `pre`; its text op is recorded and inverted | Task 3 tests both cases under their real names |
| `command.test.ts`: refusal ordering | The order is `editRefusal`'s, pinned by W1's `editRefusal.test.ts` | `command.test.ts` pins what `planCommand` adds around the verdict |
| Draft base: `onDraftStart` opens the draft; `onDraftChange` only updates `text` | Both call `flushOtherDraft` and ignore its `false` (a refused draft on another block). Nothing says what `onDraftChange` does when no draft is open | `onDraftStart` returns without opening when the other draft stays; `onDraftChange` does nothing without an open draft for its block (Task 2) |
| Tests use `typeInto(handlers, uid, text)` | The handlers cannot say what a clean textarea shows. `BlockInput` reports the textarea's text, which for a clean one is the tree's | `typeInto` takes the outline (`handlers` and `blocks`) and reports the tree's text as shown when no draft is pending |
| Move `PendingDraft`, `captureDraft`, `pendingTextOps` | `ShownText` and `captureDraft` are deleted by the base change | Task 1 moves all four unchanged (a pure move); Task 2 deletes two |
| `BlockDraft.settle()`: run `draftOwner`, `BlockInput`, `useOutline.undo` tests and `proptest/check.sh --file outline` | The tests the `settle()` fix added are in `views/EditablePage.test.tsx`, which the list misses. `--file outline` runs the whole directory: the outline suite, which never mounts `BlockInput`, and the draft suite, which does | Measured below; Task 5 names the evidence |
| `planCrossPageDrop(uids, nodes, target)` | The ops must be planned and judged (`editRefusal`, added by W1) before `flushDraft` and before any `removeSubtreeLocal`, which yields the nodes | Two functions: `planCrossPageDrop(uids, target)` before removal, `crossPageReplays(slots, removed)` after |
| `UNAUTHORIZED_DETAIL` moves to `outline/goodlinks.ts` | `components/goodlinksReaderDoc.ts` reads it too. Its 503 branch words "not running" differently, so it is not a duplicate of `goodlinksNotice` | The reader imports from `outline/goodlinks.ts` (UI to engine, the allowed direction); its wording stays |
| `useConfirm` is passed into `useOutline` | 17 test harnesses, `draftHarness.tsx` and `EditablePage` call `useOutline`; `confirm` is a dependency of the `handlers` memo | Task 7 takes `confirm` as its own argument, never inside an object rebuilt each render |
| "the engine never imports a type from UI code" becomes true | Nothing keeps it true after this branch | Task 7 adds an import ban for `src/outline/**` (see Questions 2) |
| `planPick(command: SlashCommandName, …)` | W6 already corrected the `SlashCommandName` comment to say the compiler does not check the cases. `CommandAcRow.command` (`AutocompletePopup.tsx`) and `resolveHeading` take `string` | Task 8 narrows both to `SlashCommandName` and rewrites the comment again |
| Drop `AuthoritativeReadSource` from the session API | `draftHarness.tsx` (W17) calls `beginAuthoritativeRead("resync")`. `Journal.tsx` passes its `source` only to the session | Task 11 updates the harness; `Journal` drops the parameter where nothing reads it |
| `/date` Escape becomes a `close-date-picker` decision | Today's branch runs before the policy, for Escape with any modifiers, unless composing. `KeyboardBar` sends no Escape | The decision sits right after the `composing` check in `decideEditorKey`, so the IME still owns its Escape |
| Docs: module map, the `pendingTextOps` table, the dirty-owner and settle rows | W6 already corrected the `revealBlock` row, the module map's `droppedDrafts`/`depthCap` and the text-limit row; W1 the `MAX_OPS_PER_BATCH` row. The Drag and drop section still says "`DndProvider` moves it without `run()`" | Task 12's list is what remains |

## Measured fallout

Measured in this worktree by trying each change and reverting it.

**`settle()` deleted** (the field, the hook's `settle`, and the three `BlockInput` call sites): every file below stays green.

| File | Tests |
|---|---|
| `components/EditableBlockTree.draftOwner.test.tsx`, `EditableBlockTree.test.tsx`, `EditableBlockTree.upload.test.tsx` | 3, 68, 1 |
| `components/BlockInput.test.tsx` | 113 |
| `outline/useOutline.undo.test.tsx`, `useOutline.upload.test.tsx` | 19, 13 |
| `views/EditablePage.test.tsx` (holds the four tests commit `05f79747` added with `settle()`) | 79 |
| `sync/connectionAware.test.tsx`, `components/AutocompletePopup.test.tsx` | 8 together |

The draft suite and Playwright were not run (a measurement job holds the machine). `settle()` predates the pending draft becoming the only dirty record; the draft-end subscription (`subscribeDraftEnd`) bumps the same counter.

**Call sites a signature change touches** (`git grep`):

| Change | Production | Tests |
|---|---|---|
| `onDraftChange` stops starting drafts | `BlockInput` | 26 calls in 8 files (`useOutline.{draftHold,undo,depth,reconciliation,textLimits,unmountFlush,upload}.test.tsx`, `sync/connectionAware.test.tsx`); 4 `onDraftStart` calls already exist; `outlineState.test.ts`'s `captureDraft` block and its `base: null` `pendingTextOps` case |
| `useOutline` takes `confirm` | `EditablePage`, `draftHarness.tsx` | 17 harnesses |
| `beginAuthoritativeRead` loses its argument | `useOutline`, `useOutlinePageLoad`, `Journal` | 20 calls in `outlineSessions.test.ts`, `useOutline.{reconciliation,selection}.test.tsx`, `SyncProvider.test.tsx`; `draftHarness.tsx` |
| `onFiles` loses `cursor`; `onRequestUpload` loses `at` | `BlockInput`, `EditableBlockTree` | 19 `onFiles(` calls in 4 files; 2 `toHaveBeenCalledWith(uid, 0, files)` in `EditableBlockTree.test.tsx`; 4 `onRequestUpload` props in `BlockInput.test.tsx` |

**Registry and FCIS:** no moved symbol mints a brand. `RequestId` and `Revision` stay in `outlineState.ts`, and `GoodlinksId` stays in `components/goodlinks.ts`, so `brand_registry.py` does not change. Every module the new cores import is already Functional Core.

## Tasks

Each task is one reviewable commit series in its own worktree off `refactor/outline-command-core`, merged back with `--no-ff`. "Web gates" means the list in Global Constraints. A "direct property run" means `cd web && PROPTEST_SEED=<n> pnpm --config.verify-deps-before-run=false exec vitest run --config vitest.props.config.ts <file>`, which needs no server and leaves port 8978 alone. The outline suite takes about 50 s, the draft suite about 16 s.

### Task 1: The draft vocabulary leaves `outlineState.ts`

**Implementer:** sonnet (pure moves).

**Files:** `web/src/outline/draft.ts` (new, `// pattern: Functional Core`), `draft.test.ts` (new), `outlineState.ts`, `outlineState.test.ts`, `edits.ts`, `edits.test.ts`, and the importers: `useOutline.ts`, `props/outline/run.ts`, `surrogatePairs.props.test.ts`, `validateOutlineFocus.props.test.ts`.

- Move `PendingDraft`, `ShownText`, `captureDraft` and `pendingTextOps` to `draft.ts` unchanged, with their `describe` blocks to `draft.test.ts`. Move `validateOutlineFocus` and `spliceUploadedMarkdown` to `edits.ts`, their tests to `edits.test.ts`. `outlineState.ts` keeps the session reducer and its header is unchanged; drop the imports it no longer needs.
- No re-export from `outlineState.ts`: importers name the new module.
- `edits.ts` already imports `keyEdits.ts`; `keyEdits.ts` imports nothing from `edits.ts`, so no cycle forms.
- **Check:** `git diff --no-ext-diff -M --stat` shows moves; the test count before and after is the same.
- **Done:** web gates green. One commit per destination module.

### Task 2: A draft's base has one source

**Implementer:** opus (the draft protocol; refused-draft guard; test churn that must keep each test's meaning).

**Files:** `outline/draft.ts`, `draft.test.ts`, `useOutline.ts`, `handlers.ts` (the two doc comments), `test-helpers.ts`, `props/outline/run.ts` (`type()` only), the 8 test files in Measured fallout, `outlineState.test.ts` leftovers.

**Interfaces:**
- Produces, in `draft.ts`:
  ```ts
  export interface PendingDraft { uid: BlockUid; text: string; base: string }
  /** A draft opened on the text its textarea showed: `base` and `text` both. */
  export function openDraft(uid: BlockUid, shown: string): PendingDraft;
  export function pendingTextOps(pending: PendingDraft | null, blocks: BlockNode[],
                                 pageTitle: CanonicalTitle): UpdateTextOp[]; // always hashes base
  ```
- Produces, in `test-helpers.ts`:
  ```ts
  /** Type `text` into `uid` as BlockInput does: a block with no pending
   * draft first reports the text it showed, the tree's. */
  export function typeInto(outline: Pick<Outline, "handlers" | "blocks">,
                           uid: BlockUid, text: string, holdFlush?: boolean): void;
  ```
  It throws when `uid` has no pending draft and is not in `outline.blocks`: no textarea can show a block the tree lacks.
- Deleted: `ShownText`, `captureDraft`, `shownRef` and its three writes, `base: null`.

- [ ] **Red tests** in `useOutline.draftHold.test.tsx` (or a new `useOutline.draftStart.test.tsx`):
  1. `a change with no open draft records nothing`: `onDraftChange(a, "x")` alone, run timers; `pendingDraft(a)` is null and `sync.sent` is empty. Today it fails: `captureDraft` opens a draft on the tree's text.
  2. `a new draft does not replace another block's draft that may not be saved`: `typeInto(a, "see [[a#b]]")`, then `onDraftStart(b, "b text")` and `onDraftChange(b, "b text!")`. `pendingDraft(a)` still holds `"see [[a#b]]"`, `pendingDraft(b)` is null, nothing is sent. Today it fails: `captureDraft` replaces the draft on `a`.
  3. `a draft after a flush bases on the shown text, not the flushed text`: type and flush on `a`, land a remote `update_text` on `a`, then `onDraftStart(a, <remote text>)` and change it. The flush hashes the remote text. Green before and after; it pins Review Focus 1.
- [ ] **Run them; expect 1 and 2 to fail.**
- [ ] **Implement.** `onDraftStart(uid, shown)`: `if (!flushOtherDraft(uid)) return;` then `pendingRef.current = openDraft(uid, shown)` and `markRefusedPending()`. `onDraftChange(uid, text, holdFlush)`: return unless `pendingRef.current?.uid === uid`; set `{ ...pending, text }`; then the timer logic as now. `takePendingTextOps` and `onBlurBlock` lose their `shownRef` lines.
- [ ] **Convert the tests** to `typeInto`. A call that tested the tree fallback itself is deleted with the fallback, named in the commit message.
- [ ] **Runner:** `run.ts`'s `type()` opens with `openDraft(uid, <displayed text of uid>)` when `draft?.uid !== uid`, then sets `text`. The displayed text equals the tree's there, since a draft on another block was flushed first, so a seed replays the same example.
- **Property check:** direct property runs of `outline/draft.prop.ts` and `outline/outline.prop.ts` with three fixed seeds each, before and after. Each reports the same `numRuns` and passes. Record the seeds in the commit message.
- **Done:** web gates green; the property checks above.

### Task 3: `planCommand` and `planReplay`

**Implementer:** opus (the hottest editor path; verdict and notice ordering; undo entries).

**Files:** `outline/command.ts` (new, `// pattern: Functional Core`), `command.test.ts` (new), `useOutline.ts` (`run`, `takePendingTextOps`), `undoManager.ts` (`dispatchWithSession`, `dispatchUnmounted`).

**Interfaces:**
- Consumes: `openDraft`, `pendingTextOps` (Task 2); `editRefusal` (W1).
- Produces:
  ```ts
  export type CommandVerdict =
    | { kind: "none" }                       // the command planned no ops; not judged
    | { kind: "applied" }                    // judged and passed
    | { kind: "refused"; notice: string };   // judged; its ops dropped
  export interface PlannedCommand {
    verdict: CommandVerdict;
    base: BlockNode[];             // pre with the draft's text ops applied
    ops: BlockOp[];                // the command's own ops; [] when refused
    next: BlockNode[];             // the tree to show
    wireOps: BlockOp[];            // stamped against pre, text ops first; [] when nothing ships
    inverse: BlockOp[] | null;     // of the recorded batch against pre; [] when nothing ships
    entry: HistoryEntry | null;    // set only when inverse is non-empty
    focus: FocusTarget | null;     // the command's own focus; null when refused
  }
  export function planCommand(pre: BlockNode[], pending: PendingDraft | null,
    fn: (base: BlockNode[]) => EditResult, pageTitle: CanonicalTitle,
    focusBefore: FocusTarget | null, freshAssets: readonly Sha256Hex[]): PlannedCommand;

  export interface PlannedReplay {
    refusal: string | null;
    resolved: BlockOp[];           // re-keyed against live; the batch itself when live is null
    next: BlockNode[] | null;      // applyOps(live, resolved); null when live is null
    wireOps: BlockOp[];            // stamped against live; unstamped when live is null; [] when refused
  }
  export function planReplay(live: BlockNode[] | null, batch: readonly BlockOp[],
    anchors: BatchAnchors, pageTitle: CanonicalTitle): PlannedReplay;
  ```
- The bodies are today's code moved: `run()` from `pendingTextOps` to the `recordHistory` argument, and the two dispatch paths from `resolveAnchors` to `stampBaseTextHashes`. Keep the early return when nothing ships before any stamping or inversion, and the comments that explain each step (they move with the code). `entry.focusAfter` is `result.focus ?? focusBefore`.

- [ ] **Red tests** in `command.test.ts`, each against a small literal tree:
  - `a draft and a command ship as one batch, text ops first, stamped against pre`
  - `a refused command still ships and records the draft's text ops` (verdict `refused`, `ops` empty, `next` is `base`, `entry.ops` is the text op)
  - `the draft's text ops count toward a refused batch's size` (`alsoShipping`)
  - `a draft whose block is not in pre ships but is not recorded`
  - `a draft on a block the command deletes is recorded and inverted`
  - `a command with no ops is not judged` (verdict `none`)
  - `nothing ships: no wire ops, an empty inverse and no entry`
  - `a batch whose inverse is null records no entry` (a `move` with another `page_title`)
  - `the entry's focusAfter falls back to focusBefore`
  - `freshAssets ride on the entry`
  - `planReplay re-keys against the live tree before stamping`; `planReplay with no tree ships the batch unstamped and judges no depth`; `a refused replay has no wire ops`
- [ ] **Run; expect FAIL** (module missing).
- [ ] **Implement `command.ts`; rewire the shells.** `run()` keeps `releaseUnshownDraft`, the `draftRefusal` branch and `markRefusedPending`, takes the draft, calls `planCommand`, then: `setEditNotice` from the verdict unless it is `none`; `releaseUnusedAssets` on `refused`; `enqueue` and `applyLocal` (or `setBlocks(plan.next)`) when `wireOps` is non-empty; `recordHistory(plan.entry)`; selection and focus from `plan.focus`. Its `useCallback` dependencies stay what they are now.
- **Property check:** as in Task 2, same seeds: the property still runs the runner's own copy, so this shows only that nothing else moved.
- **Done:** web gates green; `command.ts` is covered by `command.test.ts` alone (props are excluded from coverage). `git grep -n 'stampBaseTextHashes\|invertOps\|historyAnchors\|resolveAnchors' web/src/outline/useOutline.ts web/src/outline/undoManager.ts` finds nothing.

### Task 4: The outline property drives the cores

**Implementer:** opus (seed replay; teeth through `vi.mock`; the runner's refusal stance).

**Files:** `props/outline/run.ts`, `run.test.ts`, `teeth.prop.ts`; `checks.ts` only if `Step`'s shape forces it.

- `runSequence`'s `run` calls `planCommand(tree, draft, fn, PAGE_TITLE, focus, [])` and its `replay` calls `planReplay(base, …)`. Delete `replayEntry`, the inline stamping, inversion and anchoring, and the header's "the way useOutline.run and undoManager do": it now runs them.
- A non-`none`, non-`applied` verdict or a non-null replay refusal throws `Error("runner: refused (<notice>); the model knows no refusals")`. The generator cannot reach one (30 blocks, depth 5, short texts, accepted titles); the throw keeps that true loudly. See Questions 3.
- `Seam` loses `invertOps`. `teeth.prop.ts` swaps it with `vi.mock("../../outline/history", …)` and a `vi.hoisted` switch armed and disarmed per mutant (`MutantCase.arm`/`disarm`), as `imeTeeth.prop.ts` does. The four command mutants keep the seam.
- Keep every `mint()` call in its current order, so `Resolved` uids and a recorded counterexample are unchanged.
- [ ] **Red test** in `run.test.ts`: `every batch the runner reports is one a core returned`. `vi.mock("../../outline/command")` wrapping the real functions and recording each returned `wireOps` array; run a sequence with a typed draft, a split, an undo and a redo; assert every `run.batches[i].ops` is one of the recorded arrays (`toBe`, identity) and that both functions were called. It fails before the change (the runner builds its own arrays).
- [ ] Move "a batch with no inverse is not recorded" out of `run.test.ts` (Task 3 holds it).
- **Replay and teeth check:** direct property runs of `outline/outline.prop.ts` with the Task 2 seeds: same `numRuns`, pass. `outline/teeth.prop.ts` with two seeds: each mutant still caught by the same property. Note the examples per second the outline run reports before and after (Traps: budget).
- **Done:** web gates green; the checks above recorded in the commit message.

### Task 5: The `settle()` experiment

**Implementer:** sonnet (the deletion and the evidence runs); escalate to opus if any evidence is red.

**Files:** `outline/useBlockDraft.ts` (`settle` and its doc; the comment above `settled` names only the draft end), `components/BlockInput.tsx` (three call sites: `undo`, `redo`, `uploadFiles`).

- Delete `settle()` and its three calls. `uploadFiles` becomes a plain `void handlers.onFiles(...)` (Task 10 then drops its offset).
- **Evidence that decides it** (Questions 1): the unit files in Measured fallout; direct property runs of `outline/draft.prop.ts`, `draftTeeth.prop.ts` and `imeTeeth.prop.ts` with three seeds each; then the orchestrator's full Playwright run, where `e2e/undo.spec.ts` and the upload specs cover the real browser.
- **Green:** it stays deleted. Task 12 points the docs row and the troubleshooting row at `subscribeDraftEnd`.
- **Red:** restore `settle()` and its calls, add the failing case as a unit test in `views/EditablePage.test.tsx` (or `BlockInput.test.tsx` when it needs no outline), and have Task 12 state both mechanisms with the case that needs `settle()`.
- **Done:** web gates green, and the evidence recorded in the commit message.

### Task 6: Cross-page drops are planned in the core

**Implementer:** sonnet (move plus a small core).

**Files:** `outline/dnd.ts`, `dnd.test.ts`, `dnd/DndContext.tsx`, `useOutline.ts` (one import), `DndContext.test.tsx`.

**Interfaces:**
```ts
// outline/dnd.ts
export interface OutlineDndApi { /* moved unchanged from DndContext.tsx */ }
export interface DropSlot { uid: BlockUid; target: DropTarget }
export function planCrossPageDrop(uids: readonly BlockUid[], target: DropTarget):
  { ops: BlockOp[]; slots: DropSlot[] };       // block k at orderIdxPlus(target.order_idx, k)
export function crossPageReplays(slots: readonly DropSlot[],
                                 removed: ReadonlyMap<BlockUid, BlockNode>): OutlineReplayAction[];
```
- First commit: move `OutlineDndApi` (pure move; `DndContext.tsx` and `useOutline.ts` import it from `outline/dnd.ts`).
- Second: the core. `drop`'s cross-page branch becomes plan, judge (`editRefusal(null, plan.ops, [])` as now), `flushDraft`, remove, insert, `enqueue`, `attachOutlineReplay(ticket, target.page_title, crossPageReplays(...))`. Order unchanged.
- **Red:** `dnd.test.ts`: `planCrossPageDrop gives each block the next key, in order`; `crossPageReplays skips a block the source did not hold`. The existing `DndContext.test.tsx` drop cases stay green unedited.
- **Done:** web gates green.

### Task 7: The engine imports no UI code

**Implementer:** sonnet (each item is named). After Tasks 3 and 6.

**Files:** `outline/useOutline.ts`, `outline/goodlinks.ts`, `components/goodlinks.ts`, `components/goodlinksReaderDoc.ts`, `views/EditablePage.tsx`, `props/outline/draftHarness.tsx`, the 17 test harnesses, `test-helpers.ts`, `web/eslint.config.js`, `web/tooling/lintConfig.test.ts`.

- `useOutline(pageTitle, initial, confirm: (message: string) => Promise<boolean>, editorOwner?: symbol)`. `Outline` loses `dialog`; `EditablePage` calls `useConfirm()` and renders its own `dialog`. `confirm` stays a direct `handlers` dependency. `test-helpers.ts` gains `export const confirmYes = (): Promise<boolean> => Promise.resolve(true)` for the harnesses; a harness that tests the large-delete prompt passes its own.
- `UNAUTHORIZED_DETAIL` moves to `outline/goodlinks.ts` (pure move commit); `goodlinksReaderDoc.ts` imports it from there.
- Import ban (Questions 2): an eslint block for `src/outline/**/*.{ts,tsx}`, placed before the `testFileGlobs` block so tests keep their own rules, whose `no-restricted-imports` repeats the base patterns (`apiFetchBan`, `testHelpersBan`, `testFixturesBan`; a later block replaces the rule's options, it does not merge them) and adds `{ group: ["**/components/*", "**/views/*", "**/dnd/*"], message: "the outline engine imports no UI code; put the type in outline/" }`.
- **Red:** `lintConfig.test.ts`, inline `lintText` cases: an import of `../components/ConfirmDialog` linted as `src/outline/probe.ts` reports `no-restricted-imports`; the same text as `src/outline/probe.test.tsx` does not. Before the change the first case reports nothing.
- **Done:** web gates green; `git grep -n 'from "\.\./\(components\|views\|dnd\)/' web/src/outline -- ':!*.test.*'` finds nothing.

### Task 8: A slash pick is one exhaustive plan

**Implementer:** sonnet (fully specified).

**Files:** `outline/slashCommands.ts`, `slashCommands.test.ts`, `components/BlockInput.tsx` (`pick`), `components/AutocompletePopup.tsx` (`CommandAcRow.command: SlashCommandName`), `outline/surrogatePairs.props.test.ts` if a signature it calls narrows.

**Interfaces:**
```ts
export type SlashPick =
  | { kind: "text"; text: string; cursor: number; heading: HeadingLevel | null | undefined }
  | { kind: "date-picker"; text: string; at: number }
  | { kind: "hand-off"; text: string; at: number; to: "upload" | "goodlinks" | "local-file" };
export function planPick(command: SlashCommandName, text: string, caret: number,
                         ctx: AcContext, heading: HeadingLevel | null, now: Date): SlashPick;
```
- `heading` in the `text` arm is `resolveHeading`'s answer (`undefined`: not a heading command). `applySlashCommand` and `resolveHeading` take `SlashCommandName`; `applySlashCommand`'s `switch` ends in a `never` default. The heading and plain commands list their cases explicitly.
- `BlockInput.pick`: a completion row keeps `applyCompletion`; a command row executes `planPick`'s union in an exhaustive `switch`. The three hand-offs keep today's order: `setText`, `onBlurBlock`, then the picker or `onGoodlinks`.
- Rewrite the `SlashCommandName` comment and the `SLASH_COMMANDS` "no text transform" comments: the union says it now.
- **Red:** `slashCommands.test.ts`: one `planPick` row per kind (`upload`, `goodlinks`, `link-local-file` → `hand-off` with its `to`; `date` → `date-picker`; `h2` on a heading-2 block → `text` with `heading: null`; `todo` → `text` with `heading: undefined`). A `typeProbe` with `// @ts-expect-error -- not a command` on `planPick("nope", …)`.
- **Done:** web gates green; `BlockInput.test.tsx` and `help/slashCommandsDocumented.test.ts` unedited and green.

### Task 9: The `/date` picker's Escape is a key decision

**Implementer:** sonnet.

**Files:** `outline/keyboardPolicy.ts` (`EditorKeyInput.datePickerOpen: boolean`; `KeyDecision` gains `{ type: "close-date-picker" }`), `keyboardPolicy.test.ts` (its `input()` default `datePickerOpen: false`), `components/BlockInput.tsx` (`decideKey` passes `datePickerAt !== null`; `runDecision` case `close-date-picker`: `preventDefault`, close; the pre-policy branch is deleted).

- In `decideEditorKey`, right after `if (i.composing) return NONE;`: Escape with the picker open decides `close-date-picker`, whatever the modifiers (today's branch ignores them).
- **Red:** `keyboardPolicy.test.ts`: `Escape with the date picker open closes it`; `Escape with the picker open while composing is the IME's` (Review Focus 5); `Escape with the picker open beats the autocomplete popup`. The existing `/date picker` tests in `BlockInput.test.tsx` stay green.
- **Done:** web gates green. `docs/keyboard.md` needs no change: the key does what it did.

### Task 10: One upload loop, and no upload offset

**Implementer:** sonnet. After Tasks 3, 5 and 8 (same files).

**Files:** `outline/useOutline.ts`, `outline/handlers.ts`, `components/BlockInput.tsx`, `components/EditableBlockTree.tsx`, and the tests in Measured fallout.

- `onFiles(uid: BlockUid, files: File[]): Promise<boolean>`; `onRequestUpload(uid: BlockUid): void`; `uploadTargetRef` holds a uid; `BlockInput.uploadFiles(files)`.
- In `useOutline`, one local `uploadAndPlace(files: readonly File[], rejected: readonly string[], plan: (b: BlockNode[], texts: string[], uids: BlockUid[]) => FileDropPlan): Promise<boolean>` holds the upload, collection, notice, uid minting, `run` with `freshAssets` and the scroll fallback. Both planners already return `FileDropPlan`, and `fileDropNotice(failures, [])` is word for word `onFiles`' inline notice, which goes. `onFiles` passes no rejected names and `planUploadBlocks`; `onDropFiles` partitions first, then passes the rejected names and `planFileDropBlocks`.
- **Red:** none new; this is a refactor. `useOutline.upload.test.tsx`, `useOutline.dropFiles.test.tsx`, `useOutline.freshAssets.test.tsx` and `EditableBlockTree.upload.test.tsx` stay green with only the offset removed from their calls.
- **Done:** web gates green; `git grep -n "_cursor\|is unused" web/src` finds nothing (the `handlers.ts` and `EditableBlockTree` comments about the unused offset go with it).

### Task 11: Sessions take no read source

**Implementer:** sonnet.

**Files:** `outline/outlineSessions.ts` (`beginAuthoritativeRead(): ReadToken`; `captureActiveOutlineReads()`; delete `AuthoritativeReadSource`), `outline/useOutlinePageLoad.ts` (`export type PageReadSource = "parent" | "resync"`, used by `load` and `reload`), `views/Journal.tsx`, `outline/useOutline.ts` (one call), `props/outline/draftHarness.tsx` (one call), and the tests in Measured fallout.

- `Journal` drops the `source` parameter from each function that only passed it on; if one still reads it, it takes `PageReadSource`.
- **Done:** web gates green; `git grep -n 'AuthoritativeReadSource\|"cross-page-move"' web/src` finds nothing (`"write-settled"` remains as `outlineState.ts`'s own event and effect names).

### Task 12: Docs say what W7 made true

**Implementer:** sonnet (`architecture-docs` skill). Last.

**Files:** `docs/architecture/frontend-editor.md`, `docs/architecture/checks.md` (the `outline/` row), `docs/troubleshooting.md` (the `settle()` row).

- Module map: `outlineState.ts` is the session reducer only; add `command.ts` (Core: `planCommand`, `planReplay`, what `run()` and undo replays compose) and `draft.ts` (Core: `PendingDraft`, `openDraft`, `pendingTextOps`).
- § Which way the editor's dependencies point: the sentence stays and names the import ban that keeps it true (Task 7), and that the large-delete confirm is passed in.
- § Drafts and commit points: `PendingDraft` lives in `outline/draft.ts`; the first row becomes "`onDraftStart` opens the draft on the shown text, its `base`; `onDraftChange` only changes `text`, and with no draft open records nothing"; the `settle()` row per Task 5's outcome; the `pendingTextOps` table loses the `base` is `null` row.
- § Drag and drop: "`DndProvider` moves it without `run()`" becomes: the cross-page drop is planned by `planCrossPageDrop`, judged by `editRefusal`, and not recorded in history.
- `checks.md`'s `outline/` row: the runner composes the commands through `command.ts`, the code `useOutline.run` and `undoManager` run, and refuses nothing the generator draws.
- Troubleshooting row "After Cmd+Z, or an image pasted while typing…": the cause names `subscribeDraftEnd` (green) or keeps `settle()` with the new case (red).
- **Done:** `node .claude/skills/architecture-docs/check-docs.mjs` passes; `lint:comments` green.

## Order and parallel lanes

```
Lane A (engine core):   T1 -> T2 -> T3 -> T4
Lane B (BlockInput):    T5 -> T8 -> T9
Lane C (ports):         T11 ; T6                          start any time
Then:                   T7 after T3 and T6;  T10 after T3, T5, T8
Last:                   T12
```

Lanes A, B and C are disjoint apart from one-line import or call edits in `useOutline.ts` (T6, T11), which rebase cleanly.

| File | Tasks | Rule |
|---|---|---|
| `outline/useOutline.ts` | T1 (imports), T2, T3, T6 (import), T7, T10, T11 (one call) | T1 → T2 → T3 serial; T7 and T10 after T3 |
| `components/BlockInput.tsx` | T5, T8, T9, T10 | serial in that order |
| `props/outline/run.ts` | T1 (imports), T2 (`type()`), T4 | serial |
| `outline/handlers.ts` | T2 (draft docs), T10 (`onFiles`) | T10 after T2 |
| the 8 `useOutline.*.test.tsx` / `connectionAware` files | T2 (`typeInto`), T7 (harness line), T10 (`onFiles`), T11 (`beginAuthoritativeRead`) | distinct lines; T7, T10 after T2 |
| `props/outline/draftHarness.tsx` | T7, T11 | one line each |
| `docs/architecture/*.md`, `troubleshooting.md` | T12 only | implementers leave docs to T12 and say in their commit what became true |

Machine-wide serial resources: the full Playwright suite, `perf/check.sh` and `proptest/check.sh web` (port 8978). Direct property runs need no port but load the machine: keep them off a perf run.

## Traps

- **Seed replay of the outline suite.** `sequenceArb` is unchanged, so a seed draws the same example only if the runner turns it into the same steps. Keep `mint()` calls in their order (Task 4), and do not add or reorder anything that draws. Detect: Task 2's recorded seeds report the same `numRuns` and pass after Tasks 2, 3 and 4; a teeth seed fails on the same mutant.
- **The outline suite's budget.** The runner now also runs `editRefusal` per command (depth walk, text-limit and title scans), which the copy skipped. `outline.prop.ts` sizes `NUM_RUNS` to about 50 s with `PROPERTY_LIMIT_MS` at 90 s, and an interrupted run fails as a budget problem (`gate.ts`). Detect: compare the examples per second of the direct runs before and after Task 4. If the slow-gate rate in the constant's comment no longer fits the limit, re-size `NUM_RUNS` by that comment's recipe in the same commit.
- **Seed replay of the draft suite.** `draftHarness.tsx` drives the real `BlockInput`, so it replays only if the draft protocol behaves as before for every reachable sequence. Opening the draft in `onDraftStart` holds a draft with `text === base` only inside one synchronous `typed` or `replace` call. Detect: Task 2's draft seeds; the `erase-to-base` and `flush-sends-nothing` labels still appear in the tally.
- **Reach floors.** If W17's floor measurement lands floors on the draft or outline suite before W7 merges, a W7 change that lowers a label's rate fails the gate. Detect: rebase on W17's final state before the orchestrator's property run and read the tally.
- **Notice ordering.** `run()` sets `editNotice` from the verdict only when the command had ops: an applied command clears a stale notice, a no-op leaves it. A verdict union that collapses `none` into `applied` clears notices a flush should keep. Detect: `useOutline.textLimits.test.tsx` "the next command that applies clears the notice" and the refused-draft notice tests.
- **Undo entries.** The entry records unstamped ops (`withoutStamps`) and anchors read off `pre`; a stamped entry lands a spurious conflict on replay. Detect: `command.test.ts` asserts `entry.ops` carry no `base_text_hash`; `useOutline.undo.test.tsx`.
- **Draft flush ordering.** The shell must take the draft (clearing the timer, firing `endDraft` listeners) before `planCommand` and after `draftRefusal`; a draft taken before a refusal check is lost. The unmount flush stays a layout cleanup declared before the session effect. Detect: `useOutline.unmountFlush.test.tsx`, `useOutline.draftHold.test.tsx`.
- **Caret and focus after commands.** `plan.focus` is the command's own focus; the entry's `focusAfter` falls back to `focusBefore`. Using the fallback for `setFocus` moves the caret on every command. Detect: `useOutline.selection.test.tsx`, the outline property's focus checks.
- **Memo dependencies and render counts.** `run`, `handlers` and `dnd` must keep their dependency lists: `confirm` is a stable `useCallback` from `useConfirm`; an options object built in `EditablePage`'s render would rebuild `handlers` every render and re-render every row. Detect: `perf/check.sh frontend` scenarios `F/typing`, `J/journal-typing` and `K/drag-*` (render counts are gated).
- **Coverage.** `src/props/**` is excluded from coverage, so code moved out of `run.ts`'s reach into `command.ts` counts only through `command.test.ts` and the hook tests. Detect: `pnpm test:coverage` thresholds; aim for every branch of `planCommand` and `planReplay` in `command.test.ts`.
- **FCIS headers.** `draft.ts` and `command.ts` are Functional Core and may import only Core; `outline/dnd.ts` stays Core with `OutlineDndApi` as a type. Detect: `pnpm check:fcis`.
- **Brand rules on moved code.** `name-carries-brand` judges every parameter: `uid`, `title`, `pageTitle` in the new signatures must carry their brands (`BlockUid`, `CanonicalTitle`). No moved symbol mints a brand, so the registry does not change; if one does, regenerate `brandRegistry.gen.json` with `uv run python -m pkm.rows_dump`. Detect: `pnpm lint`.
- **`no-restricted-imports` override.** A later eslint block replaces the rule's options rather than merging them, so the outline block must repeat the base bans, and must sit before the `testFileGlobs` block. Detect: Task 7's two `lintText` cases plus an `apiFetch` import linted as `src/outline/probe.ts`, which must still report.
- **Teeth through `vi.mock`.** A mocked `history.ts` applies to the whole teeth file. Disarm in `disarm`, or a later mutant runs with the earlier swap. Detect: each mutant's test is caught by its own named property.
- **The comment lint judges whole files.** Moving code into a new module re-judges every comment it carries. Detect: `pnpm lint:comments`.

## Final gates

| Gate | Who |
|---|---|
| Web gates without Playwright | each implementer, per task |
| Direct property runs with recorded seeds (Tasks 2, 3, 4, 5) | the implementer of that task |
| `pnpm verify` including the full Playwright suite | orchestrator, after Tasks 5 and 10 merge and on the final branch |
| `proptest/check.sh web` (whole side) | orchestrator, serially, on the final branch |
| `perf/check.sh frontend` | orchestrator, serially, on a quiet machine, on the final branch before merge |

## Questions for Arthur

1. **`BlockDraft.settle()`.** Delete it if the evidence in Task 5 is green: the unit files already are (measured above); the draft suite and the Chromium undo and upload specs remain. Red on any of them restores it with the failing case as its test. Recommendation: delete. The plan defaults to the experiment as written.
2. **Enforce "the engine imports no UI code".** W7 makes the sentence true; an eslint import ban on `src/outline/**` keeps it true. Recommendation: add it (Task 7). Default: add it.
3. **Refused commands in the outline property.** The generator cannot draw a refusal, so the runner throws if one ever appears rather than modelling it; refusals stay covered by W1's unit tests. Recommendation: keep it that way in W7. Default: throw.
