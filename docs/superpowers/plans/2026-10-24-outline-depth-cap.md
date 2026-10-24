# Outline Depth Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No block can be placed deeper than 100 outline levels: the server
refuses the batch, the web refuses the edit with a notice, the importer
refuses the export.

**Architecture:** The server judges each client `create`/`move` in
`ops_core.plan_op` from depths the shell reads into `CreateContext` and
`MoveContext` (no new queries). The web judges every outline command in
`useOutline.run()` and every undo/redo dispatch against the page tree it
holds, and the drop zone never offers a too-deep position. One constant per
side, pinned by `shared/fixtures/outline_depth.json`.

**Tech Stack:** Python 3.12 / FastAPI / SQLite (server), React + TS /
vitest / Playwright (web).

**Spec:** `docs/superpowers/specs/2026-10-24-outline-depth-cap-design.md`

**Bean:** pkm-2kwd (commit the bean file with the work; tick its items).

## Global Constraints

- The cap is 100. A top-level block is depth 1; depth 100 is allowed, 101
  is not.
- Server-made landings (conflict entries, a diverged delete's copies) are
  never judged.
- Skipped ops (missing parent or block, cycle, stale page) are never judged.
- Rows already past the cap stay readable and editable; only where an op
  places blocks is judged.
- Web refusal copy, exactly: `Blocks can't nest more than 100 levels deep.`
- Server refusal reason, exactly: `block <uid> would sit <n> levels deep;
  the limit is 100` (`<n>` is the deepest level the op would put any block
  at; for a move that is the moved subtree's deepest block).
- Importer refusal line, exactly: `error: import refused: block <uid> on
  <page title repr> sits <n> levels deep; the limit is 100`.
- AGENTS.md FCIS rules: pattern headers, no bean ids or line numbers in
  comments, comment lines ≤ 80 columns.

## Review Focus

1. A pending text draft when Tab is refused: the typed text must still ship
   (run() takes the draft before planning). Test in Task 3.
2. A shallow block with a tall subtree moved under a deep parent: the
   subtree's height counts, not the root's depth. Tests in Tasks 1 and 3.
3. Legacy rows past 100: editing their text and deleting them works; moving
   them anywhere that still leaves a block past 100 is refused. Test in
   Task 1.
4. Undo of an outdent after another device indented the ancestors: refused,
   notice shown, the entry still undoable later. Test in Task 5.
5. A multi-block selection indent where one root would go too deep: nothing
   applies. Test in Task 3.

---

### Task 1: Server depth rule (implementer: opus)

**Files:**
- Create: `shared/fixtures/outline_depth.json` → `{"max_outline_depth": 100}`
- Modify: `server/src/pkm/contracts/ops.py` (constant)
- Modify: `server/src/pkm/server/ops_core.py` (`CreateContext`,
  `MoveContext`, `plan_op`)
- Modify: `server/src/pkm/server/ops_apply.py` (`_context_for` and the
  query helpers it calls)
- Test: `server/tests/test_outline_depth.py` (new),
  `server/tests/test_hostile_requests.py`

**Interfaces:**
- Produces: `pkm.contracts.ops.MAX_OUTLINE_DEPTH: Final = 100`;
  `CreateContext.depth: int` (the level the new block lands at, 1 for top
  level); `MoveContext.deepest: int` (the level the moved subtree's deepest
  block lands at).

- [ ] **Step 1: Red tests** in `server/tests/test_outline_depth.py`, using
  the `client` fixture and `/api/ops` (see the probes
  `docs/superpowers/handoffs/security-review-2026-10-23-probes/sec-pages/p3*.py`
  in the MAIN checkout for the chain shape: one `create` per level, each
  `parent_uid` the previous uid, `order_idx` 0, on a page made with
  `POST /api/pages`):
  - `test_a_create_chain_reaching_100_is_accepted_and_readable`: 100 creates
    → 200; `GET /api/page/<p>`, `GET /api/block/<root>` and, with the chain
    on today's daily page, `GET /api/journal` all 200.
  - `test_a_create_at_level_101_refuses_the_batch`: 101 creates in one batch
    → 400, `detail == {"index": 100, "reason": "block <uid> would sit 101
    levels deep; the limit is 100"}`, and none of the 101 blocks exists.
  - `test_a_batch_that_overflows_after_building_refuses_whole`: batch 1
    builds 100 levels (200); batch 2 = an `update_text` on level 1 then a
    create under level 100 → 400 with index 1, and the text is unchanged.
  - `test_a_move_counts_the_subtree_height`: a 60-level chain A and a
    40-level chain B on one page; moving A's root under B's level-40 block
    → 200 (deepest 100); under B's level-41 block in a 41-level B → 400
    naming A's root uid and 101.
  - `test_top_level_move_of_a_legacy_overdeep_subtree_is_refused`: insert a
    120-level chain directly with SQL (helper in the test, mirroring the
    probe's direct insert); `update_text` on level 120 → 200; `move` of
    level 10 to top level (levels 10..120 become 1..111) → 400 naming 111;
    `move` of level 105 to top level (16 tall) → 200; `delete` of level 3
    → 200.
  - `test_server_landings_are_not_judged`: a 100-level chain whose root is
    top level on today's daily page; a `delete` of the root with a stale
    `base_subtree_hash` → 200, and the copies exist (deepest copy at 101).
    And a conflict note under a header the test has moved to level 100 (a
    hashed `update_text` conflict) → 200.
  - `test_skipped_ops_are_not_judged`: a create under a missing parent in a
    batch with a 100-level parent chain elsewhere → 200, reported skipped.
  - `test_the_cap_matches_the_shared_fixture`: `MAX_OUTLINE_DEPTH ==
    json.load(shared/fixtures/outline_depth.json)["max_outline_depth"]`.
  - In `test_hostile_requests.py`: `test_ops_refuse_an_outline_past_the_depth_cap`
    (a 101-create batch is a 400, never 500).

- [ ] **Step 2: Run, confirm red**
  Run: `cd server && uv run pytest -q tests/test_outline_depth.py tests/test_hostile_requests.py -k "depth or level or landings or skipped or cap"`
  Expected: the 101/overflow/move/legacy tests FAIL (200 instead of 400);
  readable-at-100, landings and skipped PASS already. Note in your report
  which failed and why.

- [ ] **Step 3: Implement**
  - `MAX_OUTLINE_DEPTH` in `contracts/ops.py`.
  - `plan_op`: for `CreateContext`, after the `uid_taken` check (a taken
    uid outranks depth), `ctx.depth > MAX_OUTLINE_DEPTH` → `OpError(index,
    <reason>)`. For `MoveContext`, `ctx.deepest > MAX_OUTLINE_DEPTH` → same
    shape. Nothing else in `plan_op` changes; skip and conflict contexts
    never reach this check.
  - `_context_for` fills the fields **without adding a query per op** (the
    perf gate counts queries):
    - Create under a live parent: replace that parent's `_block_info` read
      with one query that also returns the parent's depth (a recursive
      ancestor CTE with `_parent_chain`'s visited-path guard). `depth =
      parent_depth + 1`; top-level create → 1.
    - Move: `_parent_chain(db, parent.uid)` is already read for a move with
      a parent; `len(chain)` is the parent's depth. Top-level → 0.
      `_subtree_deepest_first`'s CTE already carries `depth`; add a sibling
      `_subtree_with_height(db, uid) -> tuple[tuple[BlockUid, ...], int]`
      (height 0 for a leaf) used by the move path, and make
      `_subtree_deepest_first` return its first element. `deepest =
      parent_depth + 1 + height`.

- [ ] **Step 4: Green.** Same command → all PASS.

- [ ] **Step 5: Full server gates**
  Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
  Expected: all pass. Any `web/src/api/openapi.json` drift test failing
  means a route docstring changed; regenerate per backend.md § Generated
  artifacts (it should not: no route changes).

- [ ] **Step 6: Commit** the fixture, server files and tests.

### Task 2: Importer refuses an over-deep export (implementer: sonnet)

**Files:**
- Modify: `server/src/pkm/importer/preflight.py`,
  `server/src/pkm/importer/run.py`
- Test: `server/tests/test_import_preflight.py`

**Interfaces:**
- Consumes: `MAX_OUTLINE_DEPTH` (Task 1).
- Produces: `class ImportDepthError(ValueError)` with `uid: BlockUid`,
  `page_title: RawTitle`, `depth: int`; `validate_export_depth(export:
  Export, max_depth: int = MAX_OUTLINE_DEPTH) -> None`.

- [ ] **Step 1: Red tests** in `test_import_preflight.py`, building
  `Export`/`Page`/`Block` values the way the file's existing tests do:
  - `test_an_export_at_the_depth_cap_passes` (100 levels).
  - `test_an_export_past_the_cap_is_refused_naming_the_block`: 101 levels →
    `ImportDepthError` with the level-101 uid, the page title, depth 101.
  - `test_an_orphan_subtree_counts_from_the_recovery_page_top_level`:
    orphan chain of 101 → refused with `RECOVERY_PAGE_TITLE`.
  - `test_depth_check_is_iterative`: a 5,000-level chain is refused without
    `RecursionError` at the default recursion limit.
- [ ] **Step 2: Run, confirm red** (`ImportError`/`AttributeError` on the
  missing names).
- [ ] **Step 3: Implement** `validate_export_depth` with an explicit stack
  (not recursion), refusing the first block in document order past the cap.
  In `run.main`, call it right after `validate_export_uids`, printing the
  Global Constraints line and returning 2. Leave
  `sys.setrecursionlimit(20000)` (parse and `to_rows` still recurse).
- [ ] **Step 4: Green;** full server gates as Task 1 Step 5.
- [ ] **Step 5: Commit.**

### Task 3: Web depth check in `run()` with a notice (implementer: opus)

**Files:**
- Create: `web/src/outline/depthCap.ts` (Functional Core),
  `web/src/outline/depthCap.test.ts`
- Modify: `web/src/outline/useOutline.ts` (`run`, the `Outline` interface),
  `web/src/views/EditablePage.tsx` (notice)
- Test: `web/src/outline/useOutline.depth.test.tsx` (new; follow the
  harness of the nearest existing `useOutline`/`EditablePage` tests)

**Interfaces:**
- Produces (`depthCap.ts`):
  - `export const MAX_OUTLINE_DEPTH = 100;`
  - `export const DEPTH_NOTICE = "Blocks can't nest more than 100 levels deep.";`
  - `export function findDepthViolation(after: BlockNode[], ops: readonly
    BlockOp[], max?: number): BlockUid | null` — for each `create`/`move`
    in `ops` whose uid is in `after`, the level of the deepest block of its
    subtree in `after` (top level = 1); returns the first op uid past
    `max`, else null. Iterative or bounded recursion is fine: trees here
    are ≤ ~101 deep.
  - `export function subtreeHeight(node: BlockNode): number` (leaf 0).
- Produces (`useOutline`): `Outline.depthNotice: string | null` and
  `Outline.dismissDepthNotice(): void`.

- [ ] **Step 1: Red tests.**
  - `depthCap.test.ts`: the cap equals
    `shared/fixtures/outline_depth.json`'s `max_outline_depth` (import the
    JSON as `EditablePage.draftFlush.test.tsx` does); a create at level 100
    → null, 101 → its uid; a move whose root lands at 50 with height 51 →
    its uid, height 50 → null; an op whose uid left `after` → null;
    `update_text`/`delete` ops never judged.
  - `useOutline.depth.test.tsx` (a page tree built 100 deep in memory):
    - Indent at the cap: no op enqueued, tree unchanged, `depthNotice ===
      DEPTH_NOTICE`, no history entry recorded.
    - With a dirty draft on the block, indent at the cap still enqueues the
      draft's `update_text` (alone) and applies it.
    - Multi-select indent where one of two roots would reach 101: nothing
      but the (absent) draft is enqueued.
    - Paste of a 3-level outline at level 99 → refused with the notice;
      at level 98 → applied.
    - Indent one level shallower → applied, notice stays null; the next
      successful command clears a shown notice.
- [ ] **Step 2: Run, confirm red** (`cd web && pnpm test:unit -- depthCap useOutline.depth`).
- [ ] **Step 3: Implement.**
  - In `run()`, after `const result = fn(base)`: when `result.ops` is
    non-empty and `findDepthViolation(result.blocks, result.ops)` is not
    null, treat it as `{ blocks: base, ops: [], focus: null }` (the text
    ops still ship exactly as today) and set the notice. A command that
    applies clears the notice. Keep `run`'s dependency list correct.
  - `EditablePage` renders `outline.depthNotice` in the existing top
    notice slot with the same markup and dismiss button as
    `goodlinksNotice` (`<p className="editor-notice" role="status">`),
    under `ownsEditor`.
- [ ] **Step 4: Green;** then `cd web && pnpm verify` (E2E_PORT given by
  the orchestrator). Expected: exit 0.
- [ ] **Step 5: Commit.**

### Task 4: The drop zone never offers a too-deep position (implementer: sonnet)

**Files:**
- Modify: `web/src/outline/dnd.ts` (`BlockDragSource`, `allowedDepths`),
  `web/src/dnd/useDropZone.ts`, `web/src/views/EditablePage.tsx` (the
  `dnd.startDrag` call), any other `BlockDragSource` literal the compiler
  finds
- Test: `web/src/outline/dnd.test.ts` (existing file; add cases)

**Interfaces:**
- Consumes: `MAX_OUTLINE_DEPTH`, `subtreeHeight` (Task 3).
- Produces: `BlockDragSource.height: number` (the tallest dragged root's
  `subtreeHeight`, set at drag start from the source tree);
  `allowedDepths(rows, boundary, height = 0, max = MAX_OUTLINE_DEPTH)`.

- [ ] **Step 1: Red tests:** `allowedDepths` with rows reaching depth 99
  (0-based, i.e. level 100) and height 0 never offers 100 (level 101);
  with height 5 the deepest offered is 94; with the cap above every row
  the result equals today's (call without the new args in an existing
  test to pin that). A drag whose `height` exceeds the cap still returns a
  non-empty list (the shallowest legal depth), so the indicator never
  breaks.
- [ ] **Step 2: Run, confirm red.**
- [ ] **Step 3: Implement:** clamp `max` to `maxLevel - 1 - height`
  (0-based depth) before building the list; `useDropZone` passes the
  drag's height (0 for a files drag). `props/outline/run.ts` calls
  `allowedDepths` with two args and must stay valid unchanged.
- [ ] **Step 4: Green;** `cd web && pnpm verify`.
- [ ] **Step 5: Commit.**

### Task 5: Undo/redo refuse a too-deep replay and keep the entry (implementer: opus)

**Files:**
- Modify: `web/src/outline/history.ts` (`restoreEntry`),
  `web/src/outline/undoManager.ts` (`dispatch`, `dispatchWithSession`,
  `dispatchUnmounted`, `OutlineHistoryHooks`, `registerOutlineHistory`),
  `web/src/outline/useOutline.ts` (register `showNotice`)
- Test: `web/src/outline/history.test.ts`,
  `web/src/outline/undoManager.test.ts` (existing files)

**Interfaces:**
- Consumes: `findDepthViolation`, `DEPTH_NOTICE` (Task 3); `useOutline`'s
  depth notice setter.
- Produces: `restoreEntry(state: HistoryState, entry: HistoryEntry, kind:
  "undo" | "redo"): HistoryState` — removes `entry` (by identity) from the
  other stack and pushes it back on top of its own; `OutlineHistoryHooks.showNotice(text: string): void`.

- [ ] **Step 1: Red tests.**
  - `history.test.ts`: `restoreEntry` after `takeUndo` gives back the
    pre-take state; after `takeRedo` likewise; an entry no longer on the
    other stack (a new record cleared redo) is still pushed back.
  - `undoManager.test.ts`: record an outdent; then make the live session
    tree 100 deep around it (as a remote change would); `performUndo` →
    nothing enqueued, `showNotice(DEPTH_NOTICE)` called on the registered
    hooks, and a second `performUndo` after the tree is made shallow again
    applies the same entry. Same for redo. The unmounted path (no session,
    `setHistoryPageLoader` returning the deep tree): nothing enqueued, the
    notice is delivered to the outline that registers for that title next,
    and the entry is restored. The returned delivery for a refused
    dispatch resolves `"failed"`, so an upload's `freshAssets` are not
    released (check `releaser.release` semantics and assert it).
- [ ] **Step 2: Run, confirm red.**
- [ ] **Step 3: Implement.** In both dispatch paths, after
  `resolveAnchors`, judge `findDepthViolation(applyOps(live, wireOps,
  title), wireOps)`; on a violation do not enqueue or `applyLocal`, call
  the title's hooks' `showNotice` (or hold one pending notice per title in
  module state, handed to the next `registerOutlineHistory` for it), run
  `settle` as today, restore the entry via an `onRefused` callback passed
  from `performUndo`/`performRedo`, and resolve the delivery `"failed"`
  with an `Error("depth cap")`. `resetHistory` clears pending notices.
  When the page read fails in `dispatchUnmounted`, the batch ships as
  today (unknown depth sends).
- [ ] **Step 4: Green;** `cd web && pnpm verify`.
- [ ] **Step 5: Commit.**

### Task 6: E2E, docs, gates (implementer: opus; docs with the `architecture-docs` skill)

**Files:**
- Create: `web/e2e/outline-depth-cap.spec.ts`
- Modify: `docs/architecture/backend.md`, `docs/architecture/sync-recovery.md`,
  `docs/architecture/frontend-editor.md`, `docs/troubleshooting.md`

- [ ] **Step 1: E2E.** The spec creates its own page (`POST /api/pages`),
  builds 99 nested levels plus two siblings at level 100 with one
  `/api/ops` batch, opens the page, focuses the second level-100 sibling
  (real key presses), presses Tab: the block stays at level 100, the
  notice text `Blocks can't nest more than 100 levels deep.` is visible,
  and no `/api/ops` request is sent after the key press (route
  interception). Shift+Tab then Tab on a level-99 block still works.
  `afterEach` deletes the page. Run it alone, then the full `pnpm verify`.
- [ ] **Step 2: Docs.**
  - `backend.md` § Missing targets, "Other planning errors stay 400s": the
    depth rule, why it rejects rather than skips (Arthur's call; the
    stacked-depth loss accepted), and that server landings are exempt and
    stay under 255.
  - `sync-recovery.md` § A batch the server rejects: the stacked-depth case
    as a known way a web batch is rejected.
  - `frontend-editor.md`: where the web judges depth (`run()`, undo
    dispatch, `allowedDepths`) and that unknown depth sends.
  - `troubleshooting.md`: one row (symptom: page/block/journal 500 on an
    outline ≥ 255 deep; cause; owning section; pkm-2kwd).
- [ ] **Step 3: Gates (orchestrator runs serially):** server pytest,
  pyrefly, ruff; `pnpm verify`; `proptest/check.sh`; `perf/check.sh`
  (both sides). Perf counts must not move (Task 1 adds no query).
- [ ] **Step 4: Commit;** tick and complete pkm-2kwd with a Summary of
  Changes.
