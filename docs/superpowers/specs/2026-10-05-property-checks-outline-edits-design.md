# Property checks: outline edit commands (pkm-f7zv)

Agreed with Arthur 2026-10-05. Third of four sub-projects under the epic
pkm-nws9 (property-based sync checks). The server suite (pkm-svgx) and the
sync protocol harness (pkm-yxcs, widened by pkm-5k8q and pkm-dbr1) are
merged; client/server op divergence (pkm-j3ui, with pkm-sj5l folded in)
follows this one.

## Problem

The outline editor's commands (`web/src/outline/edits.ts`, `paste.ts`,
`dnd.ts`) turn a gesture into an op batch, and `history.ts` turns a batch
into its undo. Each is pinned by example tests on hand-built trees. Nothing
runs them on the trees real use leaves behind: `order_idx` gaps, collapsed
ancestors, empty blocks, selections spanning parents, a redo after an undo
that did not restore every `order_idx` exactly.

The handover's first idea, "applying a command's ops with `applyOpInPlace`
reproduces the edited tree", holds by construction: every command builds its
result as `applyOps(blocks, ops)` (`edits.ts done()`, `planOutlinePaste`). The
useful oracle is what each gesture means to someone reading the page.

## Outcome

- `proptest/check.sh web` also runs a pure fast-check suite that drives
  random sequences of outline commands, undo and redo through the real
  `edits`, `paste`, `dnd`, `blockSelection` and `history` code on one page,
  with no server.
- After every step the tree is valid and the command did what a reading-view
  model says it means; at the end, undo-all and redo-all land where they
  should.
- Budget: about 45 seconds, its own `NUM_RUNS`, on top of the sync suite's
  3 minutes (Arthur, 2026-10-05: hold the web side near 4 minutes; j3ui will
  add a third suite).
- Failure policy is the epic's: a product bug is fixed in `web/src/outline/`
  with the shrunk case as a vitest unit test beside the code; a wrong model
  is fixed in `props/` with the reason in the commit; a flaky property gets a
  bean against the gate. A model/command disagreement goes to Arthur to rule
  which side is wrong. Arthur wants every finding fixed, however small, so
  the suite stays clean.

Out of scope on purpose:

- Text-only key edits (`keyEdits.ts`: bracket pairing, link wrap, emphasis):
  they never change the tree (Arthur, 2026-10-05).
- Cross-page moves and drops: they need a second tree and the server, so
  they belong to pkm-j3ui.
- `outlineState`'s reconciliation of authoritative reads with local edits,
  and `undoManager`'s dispatch shell. The suite uses `history.ts`'s pure
  `recordEntry`/`takeUndo`/`takeRedo`, which `undoManager` wraps.

## Shape

```
web/src/props/
  env.ts                 seed, path, replay path (moved out of sync/env.ts)
  sync/env.ts            BASE_URL, PASSWORD; re-exports the shared three
  outline/
    arbitraries.ts       trees, selections, drops, paste forests, sequences
    reading.ts           reading-view flattening
    model.ts             one model per command, over reading rows
    checks.ts            the per-step and whole-sequence properties
    run.ts               pure sequence runner over the real commands
    outline.prop.ts      the properties, NUM_RUNS, time budget
    teeth.prop.ts        seeded wrong commands the properties must catch
    *.test.ts            unit tests for the Functional Core files
```

`arbitraries.ts`, `reading.ts`, `model.ts`, `run.ts` and `checks.ts` are
Functional Core. `reading.ts` and `model.ts` import nothing from
`web/src/outline/` beyond types, so the model cannot share a bug with the code
it checks. The `*.test.ts` files still run under `pnpm test:unit`, but
`src/props/**` is outside the unit coverage measure, so they do not count
towards its enforced coverage; the `*.prop.ts` files run only in the gate.

## The page and the commands

**Starting tree.** A random forest on one page (fixed canonical title), up to
about 30 blocks and depth 5. Sibling `order_idx` values are strictly
increasing with random gaps, as the server leaves them after deletes. Texts
are drawn from a small alphabet that includes the empty string and
characters `parseOutlineForest` treats specially (leading spaces, `- `);
`heading`, `view_type` (including null) and `collapsed` are drawn too.
Uids come from a counter, so new blocks never collide.

**Commands.** A sequence is a `fc.array` of command descriptors, each
resolved against the current tree when the runner reaches it (an index into
the visible rows, a caret fraction, a selection anchor and length), so
shrinking keeps sequences meaningful. Inputs stay inside what the UI can
produce:

| Command | Driven through | UI-reachable inputs |
|---|---|---|
| Type text | an `update_text` flushed before the next command, as `useOutline.run` does | a visible row, new text |
| Split | `splitBlock` | a visible row, a caret in `[0, text.length]` |
| Backspace at start | `backspaceAtStart` | a visible row |
| Indent / outdent block | `indentBlock`, `outdentBlock` | a visible row |
| Indent / outdent selection | `indentSelection`, `outdentSelection` | `selectedUids` over a contiguous visible-row range |
| Move block up / down | `moveBlockUp`, `moveBlockDown` | a visible row |
| Move subtree up / down | `moveSubtreeUp`, `moveSubtreeDown` | a visible row |
| Move selection up / down | `moveSelectionUp`, `moveSelectionDown` | a visible-row selection |
| Drop | `resolveDrop` then `moveBlocksTo` | a single row or a selection (`selectionDragUids`); a boundary and a depth from `dropRows`/`allowedDepths` |
| Delete selection | `deleteSelection` | a visible-row selection |
| Outline paste | `planOutlinePaste` | a visible row, a selection range in its text, a random forest rendered with 2-space, 4-space, tab or `- ` indents, only when `isOutlinePaste` holds |
| Collapse, heading, view type | `setCollapsed`, `setHeading`, `setViewType` | a visible row, a value |
| Undo, redo | `takeUndo`/`takeRedo`, then `replayEntry`: `resolveAnchors` re-keys the entry's inverse/ops placements against the current tree, as `undoManager` does, and `applyOps` applies the result | — |

The runner records history exactly as `useOutline.run` does: the entry's
ops are the flushed text ops plus the command's ops, its inverse is
`invertOps` against the tree before the flush, and an empty or null inverse
records nothing. A new entry clears redo (`recordEntry`).

## The reading-view model

The page flattens to its reading rows, top to bottom, ignoring `collapsed`
for order (a collapsed block's children are still rows, flagged hidden):
`(uid, depth, text, heading, view_type, collapsed, hidden)`. Each command
has an independent statement of its effect on those rows, written against
the rows and the command's inputs, never against `order_idx`:

| Command | Expected rows after |
|---|---|
| Type text | the row's text replaced; nothing else changes |
| Split at caret c (c > 0 or empty text) | the row keeps `text[:c]`; a new row with `text[c:]` follows it, as its first child when it had visible children, else as its next sibling after its subtree |
| Split at caret 0 of non-empty text | a new empty row before it at its depth; the row keeps its text |
| Backspace at start | a row with children: no-op. A first sibling or a row whose previous sibling has children: deleted when empty, else no-op. Otherwise it merges into the previous sibling (texts concatenated, the row gone) |
| Indent | reading order unchanged; the indented subtrees' depths +1; a collapsed new parent is expanded; no-op when any run starts at a first sibling |
| Outdent | reading order unchanged; the outdented subtrees' depths −1, and the following siblings they adopt keep their depth (a collapsed adopter is expanded); no-op at top level |
| Move block up/down | the block's subtree swaps with its neighbouring sibling's subtree |
| Move subtree up/down at an edge | the subtree becomes the last child of the parent's previous sibling (up) or the first child of its next sibling (down), same depth, that sibling expanded; else no-op |
| Move selection up/down | each run swaps with its neighbouring sibling, or crosses into the parent's neighbour as above, which is expanded even when it is itself a selected root; one blocked run makes the whole gesture a no-op |
| Drop | the dragged roots' subtrees leave and land as one contiguous run at the drop boundary and depth, in their original order; every other row keeps its relative order; no dragged root ends hidden, since `allowedDepths` offers no child depth under a collapsed row |
| Delete selection | exactly the selected roots' subtrees disappear |
| Outline paste | the first root's text splices into the row at the selection; its children become the row's first children (row expanded); later roots follow the row's subtree as siblings, each with its own subtree |
| Collapse, heading, view type | that one field of that one row; setting a field to the value it already holds is a no-op |

Where the model and the code disagree, the disagreement is a finding; which
side is wrong is Arthur's call, and the model's statement of a command is
then the record of what that command means.

## The properties

Checked after every step:

1. **Valid tree.** Uids unique; each sibling list strictly increasing in
   `order_idx`; every non-root's parent present.
2. **Meaning.** The rows after equal the model's prediction from the rows
   before and the command's inputs.
3. **No-ops are silent.** A command the model calls a no-op emits no ops,
   and one that emits ops changes the tree. `applyOpsWithChange(before,
   ops).changed` is false exactly when the result is `blocksEqual` to the
   input.
4. **Undoable.** Every command on this page that emits non-collapse ops has
   a non-null inverse.
5. **Focus.** A returned focus names a block in the result tree that is not
   hidden under a collapsed ancestor, with a caret in `[0, text.length]`.

Checked over the whole sequence:

6. **Undo stack.** Undo and redo steps inside a sequence match a model of
   the stack: undo restores the tree as it was before the entry's command,
   redo the tree as it was after.
7. **Undo all, redo all.** From the end, undoing every entry reaches the
   start; redoing every entry then reaches the end again.

Undo/redo comparisons are structural: same rows in the same order with the
same depth, text, heading and view type. Raw `order_idx` values are ignored
(nobody sees them), `collapsed` is ignored (undo deliberately never restores
it, except when recreating a deleted subtree), and `view_type` null equals
`"document"` (the inverse of `set_view_type` cannot express null). Redo
after undo is where a finding is most likely: redo replays ops built for the
original `order_idx` values, which undo may not have restored.

## Gate plumbing

- **Env.** `web/src/props/env.ts` reads `PROPTEST_SEED`, `PROPTEST_PATH`
  and `PROPTEST_REPLAY_PATH`; `sync/env.ts` keeps `BASE_URL` (still
  required at import) and `PASSWORD` and re-exports the three. The outline
  suite imports only the shared module, so it never needs the server.
- **One suite at a time.** `proptest/check.sh` gains `--file <filter>`,
  passed to vitest as a positional filter (web side only). Each suite's
  failure report prints a replay command naming its own file, so a
  counterexample path only ever reaches the suite it came from.
  `check.sh web` still starts the sync server on every run; skipping it for
  an outline-only replay is not worth the branch.
- **Budget.** `NUM_RUNS` in `outline.prop.ts`, set from a measured
  sequences-per-second rate to land near 45 s, with
  `interruptAfterTimeLimit` and the sync suite's distinct "ran out of its
  time budget … a budget problem, not a finding" message. If the useful
  count needs more than about 45 s, that goes to Arthur rather than growing
  silently.
- **Side picking** already sends every `web/…` change (except `web/e2e/`
  and Markdown) to the web side; no change.

## Teeth

`teeth.prop.ts` runs the same properties with one command swapped for a
deliberately wrong version and asserts each fails within the budget:

- outdent without adopting the following siblings;
- move-down placing one slot too far;
- paste dropping the first root's children;
- `invertOps` restoring a move with the post-move `order_idx`;
- `deleteSelection` deleting only the first selected root.

## Docs

- `docs/architecture/property-checks.md`: the outline suite (what it
  drives, the reading-view oracle, its budget row, `--file`); the web-side
  total.
- `AGENTS.md`: the gate's "about 3 minutes apiece" sentence stays accurate
  with the web side near 4 minutes.
- `docs/architecture/frontend.md`: only if its module map lists `props/`
  (it does not today).
- `docs/troubleshooting.md`: one row per invariant a finding's fix installs.

## Done

- Server and web gates green: pytest, pyrefly, ruff; `pnpm verify`.
- `proptest/check.sh web` clean, with every finding fixed (product) or
  ruled and fixed (model); `perf/check.sh frontend` if a fix touched
  product code.
- Every teeth mutant fails.
- A final Opus review with mutation probes against the model and the
  properties.
