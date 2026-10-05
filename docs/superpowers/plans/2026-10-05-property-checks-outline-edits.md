# Outline Edit Command Properties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure fast-check suite in the web property gate that runs random sequences of outline commands, undo and redo on one page and checks each against a reading-view model of what the gesture means.

**Architecture:** A pure runner drives the real `edits`/`paste`/`dnd`/`blockSelection`/`history` code from abstract command descriptors, recording history exactly as `useOutline.run` does. An independent model in `props/outline/` predicts each command's effect on the page's reading rows (uid, depth, text, …), never touching `order_idx`. Pure check functions compare the two after every step and over the whole sequence; `outline.prop.ts` runs them under the gate's budget and `teeth.prop.ts` proves they catch seeded bugs.

**Tech Stack:** TypeScript, fast-check ^4.10, vitest ^3.2 (`vitest.props.config.ts` for `*.prop.ts`, the main config for `*.test.ts`), Python runner `server/tooling/proptest/run.py`.

**Spec:** `docs/superpowers/specs/2026-10-05-property-checks-outline-edits-design.md`

## Global Constraints

- Worktree `.claude/worktrees/pkm-f7zv`, branch `feat/pkm-f7zv-outline-props`. Run `pnpm install` in `web/` and `uv sync` in `server/` once before Task 1.
- Every new non-test file starts with `// pattern: Functional Core` (all of `props/outline/*.ts` except the two `.prop.ts` entry points and `props/env.ts`, which are `// pattern: Imperative Shell`).
- `props/outline/reading.ts` and `model.ts` import from `web/src/outline/` and `web/src/api/` **types only** (`import type`). The model must never call the code it checks.
- No bean ids in code or test comments; a comment states the rule it enforces.
- The outline suite never needs the sync server: it imports `props/env.ts`, never `props/sync/env.ts`.
- Budget: the outline suite targets about 45 s of the web gate (sync keeps its ~3 min). If the useful `NUM_RUNS` needs more than ~45 s, stop and report rather than growing it.
- Failure policy: a model/command disagreement is a finding. **Stop and report it to the orchestrator** with the shrunk counterexample; Arthur rules which side is wrong. Never weaken a model statement or property to make a run pass.
- `src/props/**` is excluded from the unit coverage measure (`web/vite.config.ts`); the `*.test.ts` files there still run under `pnpm test:unit`.
- Long commands run in the foreground with a 600000 ms timeout; never pipe a gate through a filter (write full output to a file). `git diff --no-ext-diff` on this machine.
- Commit messages: no Claude session URLs; end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Trees as real use leaves them** — gaps in `order_idx`, a non-zero first key, collapsed blocks with children, empty texts: the arbitrary must actually produce these, or every command is tested on toy trees. Pinned in Task 3 (`tree arbitrary reaches gaps, collapsed parents and empty text`).
2. **Undo with a pending draft** — the app flushes a typed draft as its own newest entry before undoing it. A runner that drops or merges the draft would make undo-all look right while the app differs. Pinned in Task 4 (`undo flushes a pending draft as its own entry first`).
3. **Paste text the parser treats specially** — a forest rendered with bullets, tabs or 4-space indents must parse back to the same forest, or the paste model predicts a forest the code never received. Pinned in Task 3 (`rendered paste forests parse back to themselves`).
4. **Selections spanning parents** — a selection whose roots form two runs under different parents (indent, outdent, move, delete). Pinned in Task 5 and Task 6 model tests named `… two runs …`.
5. **Drops next to a collapsed row and at the very end** — the boundary after a collapsed row's hidden children, and `boundary === rows.length`. Pinned in Task 6 (`drop after a collapsed row lands after its hidden children`, `drop at the end appends at the chosen depth`).

---

### Task 1: Shared props env and `--file` in the gate

**Files:**
- Create: `web/src/props/env.ts`
- Modify: `web/src/props/sync/env.ts` (keep `BASE_URL`, `PASSWORD`; re-export `SEED`, `PATH`, `REPLAY_PATH` from `../env`)
- Modify: `web/src/props/sync/sync.prop.ts:618` (replay line gains ` --file sync/sync.prop.ts`)
- Modify: `server/tooling/proptest/run.py` (`web_command`, `_run_web`, `_run_server`, `main`), `proptest/check.sh` usage comment
- Test: `server/tests/test_proptest_sides.py`

**Interfaces:**
- Produces: `web/src/props/env.ts` exports `SEED: number | undefined`, `PATH: string | undefined`, `REPLAY_PATH: string | undefined` (same reading as today's `sync/env.ts`); `web_command(seed: int | None, file: str | None = None) -> list[str]`; CLI `proptest/check.sh web --file <filter>`.

- [ ] **Step 1: Write the failing tests** in `server/tests/test_proptest_sides.py`:

```python
def test_web_command_appends_a_file_filter():
    base = ["pnpm", "exec", "vitest", "run", "--config", "vitest.props.config.ts"]
    assert web_command(None, "outline/outline.prop.ts") == [*base, "outline/outline.prop.ts"]
    assert web_command(7, None) == base


def test_file_is_web_only(capsys):
    from proptest.run import main
    assert main(["server", "--file", "x.prop.ts"]) == 2
    assert "--file is web only" in capsys.readouterr().err
```

- [ ] **Step 2: Run them** — `cd server && uv run pytest -q tests/test_proptest_sides.py` — expect the two new tests to FAIL (unexpected argument / no `--file`).
- [ ] **Step 3: Implement.** `--file` argparse option (help: "web only: a vitest file filter, to run one suite"); `main` returns 2 with `--file is web only` on stderr when `--file` is given and the side argument is not `web` (auto included). `_run_web(repo, seed, path, replay_path, file)` passes it to `web_command`; `_run_server` accepts and ignores it. Move the seed/path/replay-path reads into `web/src/props/env.ts` unchanged; `sync/env.ts` keeps `required("PROPTEST_BASE_URL")`. Update the replay line in `sync.prop.ts`'s `report()` and the `check.sh` usage comment.
- [ ] **Step 4: Verify** — `cd server && uv run pytest -q tests/test_proptest_sides.py && uv run pyrefly check && uv run ruff check` PASS; `cd web && pnpm typecheck` PASS.
- [ ] **Step 5: Commit** — `feat(proptest): --file runs one web suite; shared props env`.

### Task 2: Reading rows and tree validity

**Files:**
- Create: `web/src/props/outline/reading.ts`
- Test: `web/src/props/outline/reading.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Row {
    uid: BlockUid; depth: number; text: string;
    heading: BlockNode["heading"]; viewType: BlockNode["view_type"];
    collapsed: boolean; hidden: boolean; // hidden = under a collapsed ancestor
  }
  export function readingRows(blocks: readonly BlockNode[]): Row[];          // depth-first, children in array order
  export function structural(rows: readonly Row[]): string[];                // one line per row: depth, uid, text, heading, viewType ?? "document"; ignores collapsed/hidden
  export function treeProblems(blocks: readonly BlockNode[]): string[];      // [] when valid
  export function rowsDiff(expected: readonly Row[], actual: readonly Row[]): string | null; // null when equal, else first differing index with both rows
  ```
- `treeProblems` reports: a duplicate uid; a sibling list not strictly increasing in `order_idx`; a sibling array not sorted by `order_idx` (array order is what `readingRows` reads).

- [ ] **Step 1: Write the failing tests** — `readingRows flattens depth-first and marks collapsed descendants hidden` (a 3-level tree with a collapsed middle node: its children have `hidden: true`, its own row `hidden: false`); `structural ignores collapsed and treats a null view type as document`; `treeProblems names a duplicate uid`; `treeProblems names equal sibling order keys`; `treeProblems accepts gaps` (siblings at 0, 3, 7 → `[]`); `rowsDiff points at the first differing row`.
- [ ] **Step 2: Run** `cd web && pnpm exec vitest run src/props/outline/reading.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** the four functions in `reading.ts`.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** — `test(props): reading rows for the outline suite`.

### Task 3: Arbitraries — trees, paste forests, commands

**Files:**
- Create: `web/src/props/outline/arbitraries.ts`
- Test: `web/src/props/outline/arbitraries.test.ts`

**Interfaces:**
- Consumes: `readingRows`, `treeProblems` (Task 2); `parseOutlineForest`, `isOutlinePaste`, `PastedNode` from `outline/paste`.
- Produces:
  ```ts
  export const PAGE_TITLE: CanonicalTitle;            // "Outline Props"
  export const treeArb: fc.Arbitrary<BlockNode[]>;    // uids "b0".., ≤ 30 blocks, depth ≤ 5
  export type IndentStyle = "two" | "four" | "tab" | "bullet";
  export function renderForest(forest: PastedNode[], style: IndentStyle): string;
  export const forestArb: fc.Arbitrary<PastedNode[]>; // 1–6 nodes, depth ≤ 3, texts from PASTE_TEXT
  export type Command =
    | { kind: "type"; row: number; text: string }
    | { kind: "split"; row: number; caret: number }         // caret: 0..1 fraction of text length
    | { kind: "backspace"; row: number }
    | { kind: "indent" | "outdent" | "moveUp" | "moveDown" | "subtreeUp" | "subtreeDown"; row: number }
    | { kind: "indentSel" | "outdentSel" | "selUp" | "selDown" | "deleteSel"; row: number; span: number }
    | { kind: "drop"; row: number; span: number; boundary: number; depth: number } // span 0 = single-block drag
    | { kind: "paste"; row: number; from: number; to: number; forest: PastedNode[]; style: IndentStyle }
    | { kind: "collapse"; row: number; value: boolean }
    | { kind: "heading"; row: number; value: BlockNode["heading"] }
    | { kind: "viewType"; row: number; value: SetViewTypeOp["view_type"] }
    | { kind: "undo" } | { kind: "redo" };
  export const commandArb: fc.Arbitrary<Command>;
  export const sequenceArb: fc.Arbitrary<{ start: BlockNode[]; commands: Command[] }>; // 1–20 commands
  ```
- `row`, `span`, `boundary`, `depth`, `from`, `to` are raw `fc.nat()` choosers; Task 4 resolves them modulo what the tree offers, so shrinking keeps a sequence meaningful.
- Block texts: `fc.constantFrom("", "a", "ab", "hello", " lead", "- dash", "x y")`. Paste texts (`PASTE_TEXT`): non-empty, no leading whitespace, not starting with `-`, `*` or `+`, no newline — e.g. `fc.constantFrom("p", "q r", "[[Link]]", "z")`.
- `order_idx`: siblings start at `fc.nat(3)` and step by `1 + gap`, `gap` weighted toward 0 (`fc.oneof({arbitrary: fc.constant(0), weight: 3}, {arbitrary: fc.integer({min: 1, max: 4}), weight: 1})`). `collapsed` true ~25% (only meaningful with children; allowed on leaves too). `heading` from `[null, 1, 2, 3]`; `view_type` from `[null, "document", "numbered"]`.
- Weights: undo and redo together ~15% of commands; paste ~8%; the rest spread evenly.

- [ ] **Step 1: Write the failing tests:**
  - `generated trees are valid` — `fc.assert(fc.property(treeArb, (t) => treeProblems(t).length === 0))`.
  - `tree arbitrary reaches gaps, collapsed parents and empty text` — over `fc.sample(treeArb, 500)`, at least one tree has a sibling gap > 1, a non-zero first key, a collapsed block with children, and an empty-text block.
  - `rendered paste forests parse back to themselves` — `fc.property(forestArb, fc.constantFrom(...styles), (f, s) => deepEqual(parseOutlineForest(renderForest(f, s)), f))`.
  - `every generated forest is an outline paste` — `isOutlinePaste(renderForest(f, s))` holds whenever the forest has more than one node or a child (the arbitrary only yields such forests).
- [ ] **Step 2: Run** `cd web && pnpm exec vitest run src/props/outline/arbitraries.test.ts` — FAIL.
- [ ] **Step 3: Implement** `arbitraries.ts`. `renderForest`: one line per node, indent `depth × ("  " | "    " | "\t")`; the bullet style uses two-space indents and prefixes every line with `- `.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `test(props): outline suite arbitraries`.

### Task 4: The sequence runner

**Files:**
- Create: `web/src/props/outline/run.ts`
- Test: `web/src/props/outline/run.test.ts`

**Interfaces:**
- Consumes: `Command`, `PAGE_TITLE`, `renderForest` (Task 3); `readingRows` (Task 2); the real commands from `outline/edits`, `planOutlinePaste`/`isOutlinePaste` from `outline/paste`, `dropRows`/`allowedDepths`/`resolveDrop` from `outline/dnd`, `selectedUids`/`selectionDragUids` from `outline/blockSelection`, `invertOps`/`recordEntry`/`takeUndo`/`takeRedo`/`emptyHistory` from `outline/history`, `applyOps`/`applyOpsWithChange`/`visibleUids` from `outline/tree`.
- Produces:
  ```ts
  /** The concrete inputs a command resolved to against the tree it ran on. */
  export type Resolved =
    | { kind: "type"; uid: BlockUid; text: string }
    | { kind: "split"; uid: BlockUid; caret: number; fresh: BlockUid }
    | { kind: "backspace" | "indent" | "outdent" | "moveUp" | "moveDown" | "subtreeUp" | "subtreeDown"; uid: BlockUid }
    | { kind: "indentSel" | "outdentSel" | "selUp" | "selDown" | "deleteSel"; uids: BlockUid[] } // selectedUids order
    | { kind: "drop"; uids: BlockUid[]; position: DropPosition }  // dragged roots, document order
    | { kind: "paste"; uid: BlockUid; from: number; to: number; forest: PastedNode[]; text: string; fresh: BlockUid[] }
    | { kind: "collapse"; uid: BlockUid; value: boolean }
    | { kind: "heading"; uid: BlockUid; value: BlockNode["heading"] }
    | { kind: "viewType"; uid: BlockUid; value: SetViewTypeOp["view_type"] };
  export interface Step {
    command: Command;
    resolved: Resolved | null;      // null for undo/redo and for a command with no visible row
    base: BlockNode[];              // the tree the command ran on (after any draft flush)
    after: BlockNode[];
    ops: BlockOp[];                 // the command's ops (not the flushed text op)
    focus: FocusTarget | null;
    inverse: BlockOp[] | null;      // invertOps over the recorded batch; null = not invertible
    undo?: { expectedRows: Row[] }; // for undo/redo: the rows the entry should restore
  }
  export interface Seam {           // what teeth.prop.ts swaps; defaults are the real functions
    outdentBlock: typeof outdentBlock; moveBlockDown: typeof moveBlockDown;
    planOutlinePaste: typeof planOutlinePaste; invertOps: typeof invertOps;
    deleteSelection: typeof deleteSelection;
  }
  export const REAL: Seam;
  export interface Run { steps: Step[]; end: BlockNode[]; history: HistoryState } // end = after the final draft flush
  export function runSequence(start: BlockNode[], commands: readonly Command[], seam?: Seam): Run;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `a type command is held as a draft and flushed by the next command` — sequence `[type row0 "zz", indent row1]`: the indent step's `base` holds `"zz"` in row 0, and its recorded entry's ops begin with `update_text` for row 0.
  - `undo flushes a pending draft as its own entry first` — `[type row0 "zz", undo]`: after the undo the tree's row 0 text is the original, and history holds one redo entry whose ops are the single `update_text`.
  - `a no-op command records nothing` — `indent` on a first sibling: `ops` empty, history unchanged.
  - `a collapse-only command records nothing` — `collapse` on an expanded parent: history unchanged (empty inverse).
  - `selection commands resolve to visible-row ranges` — `selUp` with `row: 1, span: 2` on a flat 4-block tree resolves to `uids` of rows 1–3 (`span` = extra rows beyond the anchor, clamped at the last visible row).
  - `drop resolves depth from allowedDepths` — the resolved `position.depth` is always a member of `allowedDepths(dropRows(...), position.boundary)`.
  - `paste only runs when the text is an outline paste` — a resolved paste's `text` equals `renderForest(forest, style)`.
- [ ] **Step 2: Run** `cd web && pnpm exec vitest run src/props/outline/run.test.ts` — FAIL.
- [ ] **Step 3: Implement `runSequence`.** Resolution: `rows = visibleUids(tree)`; a command with a `row` and no visible rows resolves to null and is skipped (recorded as a step with `resolved: null`, `ops: []`). `row % rows.length`; selection = `selectedUids(tree, {anchor: rows[r], head: rows[min(r + span, last)]})`; caret = `Math.round(caret_fraction × text.length)` with the fraction drawn as `nat % 101 / 100`; drop: the drag is `selectionDragUids` for `span > 0`, else the single row; `boundary % (dropRows.length + 1)`; `depth` = `allowed[depth % allowed.length]`; `resolveDrop` null ⇒ no-op, otherwise `moveBlocksTo(tree, PAGE_TITLE, uids, target.parent_uid, target.order_idx)`; paste `from`/`to` = sorted, each `% (text.length + 1)`. Fresh uids from a counter `"n0", "n1", …` (pre-allocate the forest's node count for paste, depth-first order).
  History, mirroring `useOutline.run` and `undoManager`: a `type` sets `draft = {uid, text}` (latest wins for the same block; a draft for another block is flushed first). Every other command first flushes: `textOps = draft && text differs ? [update_text] : []`; `base = applyOps(pre, textOps)`; run the command on `base`; record `recordEntry` with `ops: [...textOps, ...result.ops]` and `inverse: seam.invertOps(pre, PAGE_TITLE, thatBatch)` when the inverse is non-null and non-empty. `undo`/`redo`: flush the draft as its own text-only entry first (the `flushNow` path), then `takeUndo`/`takeRedo` and `applyOps(tree, entry.inverse | entry.ops)`. Keep, alongside history, a parallel stack of `{beforeRows, afterRows}` (reading rows of `pre` and of the result) so an undo step's `undo.expectedRows` is the entry's `beforeRows` and a redo's is its `afterRows`. At the end, flush any draft as an entry.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `test(props): outline command sequence runner`.

### Task 5: Model — text, structure and field commands

**Files:**
- Create: `web/src/props/outline/model.ts`
- Test: `web/src/props/outline/model.test.ts`

**Interfaces:**
- Consumes: `Row` (Task 2), `Resolved` (Task 4).
- Produces: `export type Expected = { kind: "noop" } | { kind: "rows"; rows: Row[] };` and `export function expectedRows(before: readonly Row[], r: Resolved): Expected;` — this task implements the cases `type`, `split`, `backspace`, `indent`, `outdent`, `indentSel`, `outdentSel`, `deleteSel`, `collapse`, `heading`, `viewType`; the others throw `"model: <kind> not yet modelled"` until Task 6.
- Rules, from the spec's model table, stated over rows (`subtree(i)` = row i and the following rows deeper than it; `hidden` is recomputed from `collapsed` after every change; a new row has `heading: null`, `viewType: null`, `collapsed: false`):
  - **type** — the row's text replaced; noop when equal.
  - **split** — caret 0 and non-empty text: a new empty row inserted before it at its depth. Otherwise the row keeps `text[:c]`; a new row `text[c:]` goes right after the row as its first child (depth + 1) when it has children and is not collapsed, else right after its subtree at its depth.
  - **backspace** — row with children: noop. First sibling or previous sibling with children: delete the row when its text is empty, else noop. Otherwise the previous sibling's text becomes `prev + text` and the row is removed.
  - **indent / indentSel** — roots = selected rows with no selected ancestor; runs = consecutive roots that are adjacent siblings. Noop when any run's first root is a first sibling. Else each run's subtrees get depth + 1 (they become the last children of the previous sibling), reading order unchanged, and that previous sibling's `collapsed` becomes false.
  - **outdent / outdentSel** — noop when any run is top-level. Else each run's subtrees get depth − 1; the siblings after the run up to the next run under the same parent (or the end of the sibling list) keep their depth and become children of the run's last root, whose `collapsed` becomes false if it adopts anything; reading order unchanged.
  - **deleteSel** — every root's subtree removed.
  - **collapse / heading / viewType** — that one field of that one row; noop when equal.

- [ ] **Step 1: Write the failing tests**, each a hand-built tree via a small `t("a", t("b"), …)` helper and an expectation written from the rule above, not from running the code: `split mid-text with visible children makes the first child`, `split at caret 0 inserts an empty row above`, `split of a collapsed parent goes after its hidden subtree`, `backspace merges into a childless previous sibling`, `backspace on a first sibling deletes only when empty`, `indent of a first sibling is a noop`, `indent expands a collapsed new parent`, `indentSel with two runs under different parents`, `outdent adopts the following siblings and keeps their depth`, `outdentSel two runs adopt up to the next run`, `deleteSel of a parent and its child removes the parent's subtree once`, `heading set to its current value is a noop`.
- [ ] **Step 2: Run** `cd web && pnpm exec vitest run src/props/outline/model.test.ts` — FAIL.
- [ ] **Step 3: Implement** those cases of `expectedRows`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `test(props): reading-view model for text and structure commands`.

### Task 6: Model — moves, drop and paste

**Files:**
- Modify: `web/src/props/outline/model.ts`
- Test: `web/src/props/outline/model.test.ts`

**Interfaces:**
- Produces: the remaining cases of `expectedRows`: `moveUp`, `moveDown`, `subtreeUp`, `subtreeDown`, `selUp`, `selDown`, `drop`, `paste`. After this task nothing throws.
- Rules:
  - **moveUp / moveDown** — the row's subtree swaps with the previous / next sibling's subtree; noop with no such sibling.
  - **subtreeUp / subtreeDown** — with a sibling in that direction, as moveUp/moveDown. Otherwise, if the parent has a previous (up) / next (down) sibling P, the subtree becomes P's last (up) / first (down) child at the same depth and P's `collapsed` becomes false; else noop.
  - **selUp / selDown** — runs as in Task 5, applied in document order. A run with a sibling in that direction swaps with that sibling's subtree; otherwise it crosses into its parent's neighbour as in subtreeUp/Down (the neighbour is expanded unless it is itself a selected root). Any run with neither: the whole gesture is noop.
  - **drop** — remove the dragged roots' subtrees; in the remaining rows, the boundary `b` counts visible rows: insertion goes before the `b`-th visible row (after any hidden rows above it), or at the end when `b` equals the visible count. The dragged subtrees go there in their original order, each root at the drop depth, descendants keeping their relative depth. Noop when the result's `structural` equals the before rows' `structural`.
  - **paste** — the row's text becomes `text[:from] + forest[0].text + text[to:]`; `forest[0]`'s children (as rows with their subtrees, depth + 1) go right after the row, before its existing children, and the row's `collapsed` becomes false when there are any; `forest[1..]` follow the row's subtree at the row's depth, each with its own subtree. New rows take `fresh` uids in depth-first order (forest[0]'s children first, then the later roots).
- [ ] **Step 1: Write the failing tests:** `moveDown swaps whole subtrees`, `subtreeUp at a first child becomes the previous uncle's last child and expands it`, `subtreeDown at the last top-level row is a noop`, `selUp two runs under different parents`, `selDown blocked run makes the gesture a noop`, `drop after a collapsed row lands after its hidden children`, `drop at the end appends at the chosen depth`, `drop back where it was is a noop`, `paste splices the first root and nests its children first`, `paste later roots follow the row's subtree`.
- [ ] **Step 2: Run** the model tests — FAIL.
- [ ] **Step 3: Implement** the cases.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `test(props): reading-view model for moves, drops and paste`.

### Task 7: Checks

**Files:**
- Create: `web/src/props/outline/checks.ts`
- Test: `web/src/props/outline/checks.test.ts`

**Interfaces:**
- Consumes: `Step` (Task 4), `expectedRows` (Tasks 5–6), `readingRows`/`structural`/`treeProblems`/`rowsDiff` (Task 2), `applyOpsWithChange`/`blocksEqual` from `outline/tree`.
- Produces: `export function stepProblems(step: Step): string[];` and `export function sequenceProblems(start: BlockNode[], run: Run): string[];` — `[]` when clean, else messages prefixed with the property name (`valid:`, `meaning:`, `silent:`, `undoable:`, `focus:`, `undo-stack:`, `undo-all:`, `redo-all:`).
- `stepProblems` (properties 1–5): `treeProblems(after)`; `rowsDiff` between `expectedRows(readingRows(base), resolved)` (noop ⇒ the base rows) and `readingRows(after)`; noop ⇔ `ops.length === 0`, and `applyOpsWithChange(base, ops, PAGE_TITLE).changed === !blocksEqual(base, after)`; `inverse !== null` whenever `ops` hold anything but `set_collapsed`; a non-null `focus` names a uid in `after` whose row is not hidden, with `0 ≤ cursor ≤ text.length`. Undo/redo steps check `treeProblems` and `structural(readingRows(after))` against `structural(undo.expectedRows)`.
- `sequenceProblems` (properties 6–7): every step's problems; then from `run.end`, `takeUndo` and `applyOps` the entry's `inverse` until `run.history`'s undo stack is empty and compare `structural` with the start's; then `takeRedo` and `applyOps` the entry's `ops` until the redo stack is empty and compare with `run.end`'s. (`HISTORY_CAP` is 100 and a sequence has at most 20 commands, so nothing is evicted.)

- [ ] **Step 1: Write the failing tests:** `a clean step has no problems` (a real `indentBlock` step), `a wrong tree is reported as meaning`, `ops on a noop are reported as silent`, `a hidden focus is reported`, `undo-all that misses the start is reported` (feed a doctored `run` whose history inverse is empty-but-recorded).
- [ ] **Step 2: Run** `cd web && pnpm exec vitest run src/props/outline/checks.test.ts` — FAIL.
- [ ] **Step 3: Implement** `checks.ts`.
- [ ] **Step 4: Run** — PASS. Then `pnpm typecheck` PASS.
- [ ] **Step 5: Commit** — `test(props): outline suite checks`.

### Task 8: The property and its budget

**Files:**
- Create: `web/src/props/outline/outline.prop.ts`

**Interfaces:**
- Consumes: `sequenceArb` (Task 3), `runSequence` (Task 4), `sequenceProblems` (Task 7), `SEED`/`PATH` from `../env`.
- Produces: `export const NUM_RUNS: number;` one vitest `test("outline edit commands property", …)`.

- [ ] **Step 1: Write the property** — `fc.check(fc.property(sequenceArb, ({start, commands}) => { const run = runSequence(start, commands); const p = sequenceProblems(start, run); if (p.length) throw new Error(p.join("\n")); }), { numRuns: NUM_RUNS, seed: SEED, path: PATH, interruptAfterTimeLimit: PROPERTY_LIMIT_MS, markInterruptAsFailure: false })`, with `PROPERTY_LIMIT_MS = 75_000`. Report like `sync.prop.ts`: on failure print `outline property failed after … runs and … shrinks`, `seed`, `path`, the counterexample (start tree as reading rows plus the command list), the error, and `replay: proptest/check.sh web --seed S --path 'P' --file outline/outline.prop.ts`; on interrupt with no failure, `outline property ran out of its time budget after N of NUM_RUNS runs (no failure found): a budget problem, not a finding`. Start with `NUM_RUNS = 2000`.
- [ ] **Step 2: Run it alone** (no server needed for this file, but the gate starts one): `proptest/check.sh web --file outline/outline.prop.ts > /tmp/…/outline-run.log 2>&1; echo $?`.
- [ ] **Step 3: Triage.** Exit 0 → Step 4. A failure → **stop and report to the orchestrator** with the full failure block from the log; do not change the model, the property or product code. (The orchestrator takes the finding to Arthur; fixes come back as separate tasks.)
- [ ] **Step 4: Size the budget.** Time three clean runs at the starting count; set `NUM_RUNS` to the count that lands near 45 s, rounded down to a hundred, and record the measured rate in the comment above it (as `sync.prop.ts` does). If a clean run of a useful count would exceed ~45 s, report instead.
- [ ] **Step 5: Run the whole web side** — `proptest/check.sh web > log 2>&1; echo $?` exit 0, total near 4 minutes.
- [ ] **Step 6: Commit** — `test(props): outline edit command property in the web gate`.

### Task 9: Teeth

**Files:**
- Create: `web/src/props/outline/teeth.prop.ts`

**Interfaces:**
- Consumes: `REAL`/`Seam`/`runSequence` (Task 4), `sequenceProblems` (Task 7), `sequenceArb` (Task 3).

- [ ] **Step 1: Write five mutant seams**, each wrapping the real function and re-deriving `blocks` with `applyOps(before, mutatedOps, PAGE_TITLE)`: `outdentBlock` dropping its adopt moves (keep only the first op); `moveBlockDown` adding 1 to its move's `order_idx`; `planOutlinePaste` omitting the creates whose `parent_uid` is the target uid; `invertOps` replacing each inverse move's `order_idx` with the forward move's `order_idx`; `deleteSelection` keeping only its first delete op.
- [ ] **Step 2: One test per mutant** — `fc.check(property-with-seam, { numRuns: 3000, seed: SEED, endOnFailure: true, interruptAfterTimeLimit: 15_000 })`; `expect(details.failed).toBe(true)`, with a message naming the mutant when it survives.
- [ ] **Step 3: Run** `proptest/check.sh web --file outline/teeth.prop.ts > log 2>&1; echo $?` — exit 0 (every mutant caught). A surviving mutant: strengthen the arbitrary's reach toward it (Task 3) or report to the orchestrator if the model cannot see it.
- [ ] **Step 4: Run the whole web side again**; confirm the total stays near 4 minutes.
- [ ] **Step 5: Commit** — `test(props): teeth for the outline property`.

### Task 10: Docs

**Files:**
- Modify: `docs/architecture/property-checks.md`, `AGENTS.md` (Testing → Property checks sentence), `docs/superpowers/specs/2026-10-05-property-checks-outline-edits-design.md` (Shape: `model.ts`, `checks.ts` beside `reading.ts`; the coverage sentence: `src/props/**` is outside the coverage measure)
- Modify if a fix landed: `docs/troubleshooting.md`

- [ ] **Step 1: Invoke the `architecture-docs` skill**, then add to `property-checks.md`: the outline suite (what it drives, the reading-view oracle, undo comparisons ignore raw `order_idx`, `collapsed`, and null-vs-document view type), a budget-table row (`web` outline: `NUM_RUNS` in `outline.prop.ts`, about 45 s), the web side's total, and `--file` in the replay instructions. Grep both docs for "3 minutes" and stale suite counts.
- [ ] **Step 2: Commit** — `docs(property-checks): the outline edit command suite` (say what was added vs corrected).

### Finish (orchestrator)

- [ ] Gates: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`; `cd web && E2E_PORT=8981 pnpm verify`; `proptest/check.sh web`; `perf/check.sh frontend` only if a finding's fix touched product code.
- [ ] Final Opus review with mutation probes against `model.ts` and `checks.ts`, in its own detached worktree with `web/node_modules` symlinked.
- [ ] Bean pkm-f7zv checklist ticked, summary written, completed; `git merge --no-ff`; remove worktree and branch. Push and deploy only when Arthur says.
