# Unified Block Move Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Shift+Cmd+Up/Down the sole block-movement shortcut and give active multi-block selections the focused block’s atomic, depth-preserving movement behavior.

**Architecture:** Generalize the pure selection planner in `edits.ts` around the existing sibling-run and focused cross-parent rules, preflighting every original-tree run before emitting one deterministic batch. Keep `keyboardPolicy.ts` as the focused-key functional core, route selection-owned Shift+Cmd keys in `EditableBlockTree.tsx` before plain Shift selection extension, and retain `useOutline.run()` as the thin sync/optimistic/undo shell.

**Tech Stack:** TypeScript, React 18, Vitest, Testing Library, Playwright, pnpm.

## Global Constraints

- Work only in `/Users/arthur/code/llm/pkm/.worktrees/fix-block-selection-keyboard-move` on branch `fix/block-selection-keyboard-move`.
- Track the work in bean `pkm-8jt5`; commit bean updates with the implementation.
- Follow red-green-refactor: observe each changed production behavior failing before implementing it.
- Keep pure tree planning in Functional Core files and DOM/state/sync orchestration in Imperative Shell files; preserve the existing pattern declarations.
- Shift+Cmd+Up/Down is the only application-level block-movement shortcut.
- Focused Shift+Cmd movement remains behaviorally unchanged and keeps focus on the moved block.
- Selected descendants whose ancestors are selected travel with the ancestor and receive no independent move operation.
- Consecutive selected roots sharing a parent move as one ordered run; mixed-depth runs retain their absolute depths.
- Preflight every run against the original tree; if any run is ineligible, emit no operations for the entire gesture.
- Expand only collapsed cross-parent destinations, immediately before moving roots into them; do not expand selected roots.
- Keep successful and structural-no-op selections active.
- Plain Shift+Arrow continues to start or extend selection; Tab/Shift+Tab and drag-and-drop semantics remain unchanged.
- Option/Alt+Up/Down must be left to browser/platform handling for focused blocks and active selections, without focus-navigation fallthrough.
- Do not add a non-macOS movement shortcut.
- Do not change server, schema, API, operation protocol, replica, or generic drag behavior.
- Run `cd web && pnpm verify` before completion.
- Push after every commit; merge with `--no-ff` when integration is chosen.

## File Map

- `web/src/outline/edits.ts` — shared pure cross-parent destination logic and atomic selection movement planner.
- `web/src/outline/edits.test.ts` — operation-level same-parent, cross-parent, root-reduction, mixed-depth, collapse, and atomic-edge coverage.
- `web/src/outline/useOutline.selection.test.tsx` — one queued optimistic batch and retained selection.
- `web/src/outline/useOutline.undo.test.tsx` — one-step undo for a multi-operation selected move.
- `web/src/outline/keyboardPolicy.ts` — focused Shift+Cmd decision and explicit Option/Alt pass-through.
- `web/src/outline/keyboardPolicy.test.ts` — focused shortcut contract and Option/Alt regression.
- `web/src/components/EditableBlockTree.tsx` — active-selection key precedence and removal of dead focused Option handlers.
- `web/src/components/EditableBlockTree.test.tsx` — focused/selected dispatch, default prevention, plain Shift, Option pass-through, and read-only gating.
- `web/src/components/AutocompletePopup.test.tsx` — keep the shared `OutlineHandlers` test double current after legacy callbacks are removed.
- `web/src/outline/useOutline.ts` — remove dead single-block Option callbacks while retaining selected movement through `run()`.
- `web/src/views/EditablePage.test.tsx` — real editor regression proving Option/Alt no longer enqueues movement.
- `web/e2e/edit.spec.ts` — nested selected-run movement within a parent and across its boundary with retained selection.
- `.beans/pkm-8jt5--move-collapsed-subtrees-and-selections-with-keyboa.md` — implementation, verification, and integration tracking.

---

### Task 1: Atomic Depth-Preserving Selection Planner

**Files:**
- Modify: `web/src/outline/edits.test.ts:293-472`
- Modify: `web/src/outline/useOutline.selection.test.tsx:32-107`
- Modify: `web/src/outline/useOutline.undo.test.tsx:32-72`
- Modify: `web/src/outline/edits.ts:40-303`

**Interfaces:**
- Consumes:
  - `selectionSiblingRuns(blocks: BlockNode[], uids: string[]): SelectionSiblingRun[] | null`
  - `locate(blocks: BlockNode[], uid: string): Located | null`
  - `groupMoveOps(uids: string[], parentUid: string | null, orderIdx: number): BlockOp[]`
  - `useOutline.run(fn: (blocks: BlockNode[]) => EditResult): void`
- Produces:
  - Existing `moveSubtreeUp(blocks, pageTitle, uid): EditResult` and `moveSubtreeDown(...)` with unchanged public behavior.
  - Existing `moveSelectionUp(blocks, pageTitle, uids): EditResult` and `moveSelectionDown(...)` with generalized atomic semantics.
  - One `sync.enqueue` batch and one history entry per successful selected gesture.

- [ ] **Step 1: Replace the obsolete selection-planner tests with failing depth-preserving cases**

Keep the existing `tree`, `selectionTree`, and `deepTree` fixtures. Add this fixture immediately before the `moveSelectionUp / moveSelectionDown` suite:

```ts
const selectedMoveTree = () => [
  block("left", "Left", {
    order_idx: 0,
    children: [block("left0", "Left child", { order_idx: 0 })],
  }),
  block("source", "Source", {
    order_idx: 1,
    children: [
      block("first", "First", {
        order_idx: 0,
        children: [block("first0", "First child", { order_idx: 0 })],
      }),
      block("second", "Second", { order_idx: 1 }),
    ],
  }),
  block("right", "Right", {
    order_idx: 2,
    children: [block("right0", "Right child", { order_idx: 0 })],
  }),
];
```

Replace the current `moveSelectionUp / moveSelectionDown (pkm-q89w)` suite with:

```ts
describe("moveSelectionUp / moveSelectionDown (pkm-8jt5)", () => {
  test("up: a same-parent run swaps with the sibling above", () => {
    const r = moveSelectionUp(tree(), P, ["b", "c"]);
    expect(r.ops).toEqual([
      { op: "move", uid: "a", parent_uid: null, order_idx: 8 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "c", "a"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1", "b2"]);
  });

  test("down: a same-parent run swaps with the sibling below", () => {
    const r = moveSelectionDown(tree(), P, ["a", "b"]);
    expect(r.ops).toEqual([
      { op: "move", uid: "c", parent_uid: null, order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["c", "a", "b"]);
  });

  test("up: an edge run becomes the previous parent's last children", () => {
    const r = moveSelectionUp(
      selectedMoveTree(), P, ["first", "first0", "second"],
    );

    expect(r.ops).toEqual([
      { op: "move", uid: "first", parent_uid: "left", order_idx: 1 },
      { op: "move", uid: "second", parent_uid: "left", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, "left")!.children.map((n) => n.uid))
      .toEqual(["left0", "first", "second"]);
    expect(findNode(r.blocks, "source")!.children).toEqual([]);
    expect(findNode(r.blocks, "first")!.children.map((n) => n.uid))
      .toEqual(["first0"]);
  });

  test("down: a collapsed root carries hidden descendants without expanding", () => {
    const t = selectedMoveTree();
    findNode(t, "first")!.collapsed = true;

    const r = moveSelectionDown(t, P, ["first", "second"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "first", parent_uid: "right", order_idx: 0 },
      { op: "move", uid: "second", parent_uid: "right", order_idx: 1 },
    ]);
    expect(findNode(r.blocks, "right")!.children.map((n) => n.uid))
      .toEqual(["first", "second", "right0"]);
    expect(findNode(r.blocks, "source")!.children).toEqual([]);
    expect(findNode(r.blocks, "first")!.collapsed).toBe(true);
    expect(findNode(r.blocks, "first")!.children.map((n) => n.uid))
      .toEqual(["first0"]);
  });

  test("moves eligible mixed-depth runs from original positions", () => {
    const r = moveSelectionUp(selectionTree(), P, ["a1", "b"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a0", parent_uid: "a", order_idx: 2 },
      { op: "move", uid: "a", parent_uid: null, order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["b", "a", "c"]);
    expect(findNode(r.blocks, "a")!.children.map((n) => n.uid))
      .toEqual(["a1", "a0"]);
    expect(findNode(r.blocks, "a1")!.children.map((n) => n.uid))
      .toEqual(["a1x"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1"]);
  });

  test("one ineligible run aborts every mixed-depth run", () => {
    const t = selectionTree();
    const r = moveSelectionUp(t, P, ["a0", "b"]);

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("expands a collapsed cross-parent destination before its moves", () => {
    const t = selectedMoveTree();
    findNode(t, "left")!.collapsed = true;

    const r = moveSelectionUp(t, P, ["first", "second"]);

    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "left", collapsed: false },
      { op: "move", uid: "first", parent_uid: "left", order_idx: 1 },
      { op: "move", uid: "second", parent_uid: "left", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, "left")!.collapsed).toBe(false);
  });

  test("empty and unknown selections are no-ops", () => {
    const t = selectedMoveTree();
    expect(moveSelectionUp(t, P, []).ops).toEqual([]);
    expect(moveSelectionDown(t, P, []).ops).toEqual([]);
    expect(moveSelectionUp(t, P, ["missing"]).ops).toEqual([]);
    expect(moveSelectionDown(t, P, ["missing"]).ops).toEqual([]);
  });
});
```

- [ ] **Step 2: Add failing hook and undo tests for one atomic batch**

Add this fixture after `abc()` in `web/src/outline/useOutline.selection.test.tsx`:

```ts
const crossParentTree = () => [
  block("a", "A", {
    order_idx: 0,
    children: [block("a0", "A child", { order_idx: 0 })],
  }),
  block("b", "B", {
    order_idx: 1,
    children: [
      block("b0", "B first", {
        order_idx: 0,
        children: [block("b0x", "B grandchild", { order_idx: 0 })],
      }),
      block("b1", "B second", { order_idx: 1 }),
    ],
  }),
  block("c", "C", { order_idx: 2 }),
];
```

Add these tests after the current same-parent selection movement tests:

```ts
it("queues and applies one cross-parent selection move batch", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", crossParentTree());
  act(() => getOutline().handlers.onStartBlockSelection("b0", "down"));
  act(() => getOutline().handlers.onExtendBlockSelection("down"));
  expect(getOutline().selection).toEqual({ anchor: "b0", head: "b1" });

  act(() => getOutline().handlers.onMoveSelectionUp());

  expect(sync.sent).toEqual([[
    { op: "move", uid: "b0", parent_uid: "a", order_idx: 1 },
    { op: "move", uid: "b1", parent_uid: "a", order_idx: 2 },
  ]]);
  expect(getOutline().blocks.map((n) => n.uid)).toEqual(["a", "b", "c"]);
  expect(getOutline().blocks[0].children.map((n) => n.uid))
    .toEqual(["a0", "b0", "b1"]);
  expect(getOutline().blocks[0].children[1].children.map((n) => n.uid))
    .toEqual(["b0x"]);
  expect(getOutline().selection).toEqual({ anchor: "b0", head: "b1" });
});

it("does not enqueue when one selected movement run is ineligible", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", crossParentTree());
  act(() => getOutline().handlers.onStartBlockSelection("a0", "down"));
  expect(getOutline().selection).toEqual({ anchor: "a0", head: "b" });

  act(() => getOutline().handlers.onMoveSelectionUp());

  expect(sync.sent).toEqual([]);
  expect(getOutline().blocks.map((n) => n.uid)).toEqual(["a", "b", "c"]);
  expect(getOutline().selection).toEqual({ anchor: "a0", head: "b" });
});
```

Add this test after the selection-indent undo test in `web/src/outline/useOutline.undo.test.tsx`:

```ts
it("undo reverses a whole cross-parent selection move in one step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("a", "A", {
      order_idx: 0,
      children: [block("a0", "A child", { order_idx: 0 })],
    }),
    block("b", "B", {
      order_idx: 1,
      children: [
        block("b0", "B first", { order_idx: 0 }),
        block("b1", "B second", { order_idx: 1 }),
      ],
    }),
    block("c", "C", { order_idx: 2 }),
  ]);
  act(() => outline().handlers.onStartBlockSelection("b0", "down"));
  act(() => outline().handlers.onMoveSelectionUp());
  expect(outline().blocks[0].children.map((n) => n.uid))
    .toEqual(["a0", "b0", "b1"]);

  act(() => outline().handlers.onUndo());

  expect(outline().blocks[0].children.map((n) => n.uid)).toEqual(["a0"]);
  expect(outline().blocks[1].children.map((n) => n.uid))
    .toEqual(["b0", "b1"]);
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "b1", parent_uid: "b", order_idx: 1 },
    { op: "move", uid: "b0", parent_uid: "b", order_idx: 0 },
  ]);
});
```

- [ ] **Step 3: Run the new tests and verify RED**

```bash
cd web
pnpm test:unit -- \
  src/outline/edits.test.ts \
  src/outline/useOutline.selection.test.tsx \
  src/outline/useOutline.undo.test.tsx
```

Expected: the same-parent tests still pass, while cross-parent, mixed-depth, collapsed-destination, hook-batch, and undo tests fail because the current planner accepts only one contiguous sibling run and treats sibling-list edges as no-ops.

- [ ] **Step 4: Extract the shared cross-parent destination rule**

Add this code after `idxAfter` in `web/src/outline/edits.ts`:

```ts
type MoveDirection = "up" | "down";

interface CrossParentDestination {
  parentUid: string;
  orderIdx: number;
  expandUid: string | null;
}

/** At a sibling-list edge, preserve absolute depth by moving into the
 * previous/next sibling of the current parent. */
function crossParentDestination(
  blocks: BlockNode[],
  parent: BlockNode | null,
  direction: MoveDirection,
): CrossParentDestination | null {
  if (!parent) return null;
  const parentLoc = locate(blocks, parent.uid);
  if (!parentLoc) return null;
  const targetIndex = direction === "up"
    ? parentLoc.index - 1
    : parentLoc.index + 1;
  const target = parentLoc.siblings[targetIndex];
  if (!target) return null;
  const orderIdx = direction === "up"
    ? (target.children[target.children.length - 1]?.order_idx ?? -1) + 1
    : target.children[0]?.order_idx ?? 0;
  return {
    parentUid: target.uid,
    orderIdx,
    expandUid: target.collapsed ? target.uid : null,
  };
}
```

Refactor the cross-parent portions of `moveSubtreeUp` and `moveSubtreeDown` to use it while leaving their adjacent-sibling delegation untouched:

```ts
export function moveSubtreeUp(blocks: BlockNode[], pageTitle: string,
                              uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found) return noop(blocks);
  if (found.index > 0) return moveBlockUp(blocks, pageTitle, uid);
  const destination = crossParentDestination(blocks, found.parent, "up");
  if (!destination) return noop(blocks);
  const ops: BlockOp[] = [];
  if (destination.expandUid) {
    ops.push({
      op: "set_collapsed", uid: destination.expandUid, collapsed: false,
    });
  }
  ops.push({
    op: "move", uid, parent_uid: destination.parentUid,
    order_idx: destination.orderIdx,
  });
  return done(blocks, pageTitle, ops, null);
}

export function moveSubtreeDown(blocks: BlockNode[], pageTitle: string,
                                uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found) return noop(blocks);
  if (found.index < found.siblings.length - 1) {
    return moveBlockDown(blocks, pageTitle, uid);
  }
  const destination = crossParentDestination(blocks, found.parent, "down");
  if (!destination) return noop(blocks);
  const ops: BlockOp[] = [];
  if (destination.expandUid) {
    ops.push({
      op: "set_collapsed", uid: destination.expandUid, collapsed: false,
    });
  }
  ops.push({
    op: "move", uid, parent_uid: destination.parentUid,
    order_idx: destination.orderIdx,
  });
  return done(blocks, pageTitle, ops, null);
}
```

- [ ] **Step 5: Replace the sibling-only selection planner with atomic run planning**

Delete `locateSiblingRun` and replace the current `moveSelectionUp` / `moveSelectionDown` implementation with:

```ts
interface SelectionRunMovePlan {
  expandUid: string | null;
  ops: BlockOp[];
}

function planSelectionRunMove(
  blocks: BlockNode[],
  run: SelectionSiblingRun,
  direction: MoveDirection,
): SelectionRunMovePlan | null {
  const last = run.first + run.uids.length - 1;
  if (direction === "up" && run.first > 0) {
    const previous = run.siblings[run.first - 1];
    return {
      expandUid: null,
      ops: [{
        op: "move", uid: previous.uid,
        parent_uid: run.parent?.uid ?? null,
        order_idx: idxAfter(run.siblings, last),
      }],
    };
  }
  if (direction === "down" && last < run.siblings.length - 1) {
    const next = run.siblings[last + 1];
    return {
      expandUid: null,
      ops: [{
        op: "move", uid: next.uid,
        parent_uid: run.parent?.uid ?? null,
        order_idx: run.siblings[run.first].order_idx,
      }],
    };
  }
  const destination = crossParentDestination(
    blocks, run.parent, direction,
  );
  if (!destination) return null;
  return {
    expandUid: destination.expandUid,
    ops: groupMoveOps(
      run.uids, destination.parentUid, destination.orderIdx,
    ),
  };
}

function moveSelection(
  blocks: BlockNode[],
  pageTitle: string,
  uids: string[],
  direction: MoveDirection,
): EditResult {
  const runs = selectionSiblingRuns(blocks, uids);
  if (!runs || runs.length === 0) return noop(blocks);
  const plans: SelectionRunMovePlan[] = [];
  for (const run of runs) {
    const plan = planSelectionRunMove(blocks, run, direction);
    if (!plan) return noop(blocks);
    plans.push(plan);
  }

  const expanded = new Set<string>();
  const ops: BlockOp[] = [];
  for (const plan of plans) {
    if (plan.expandUid && !expanded.has(plan.expandUid)) {
      ops.push({
        op: "set_collapsed", uid: plan.expandUid, collapsed: false,
      });
      expanded.add(plan.expandUid);
    }
    ops.push(...plan.ops);
  }
  return done(blocks, pageTitle, ops, null);
}

export function moveSelectionUp(blocks: BlockNode[], pageTitle: string,
                                uids: string[]): EditResult {
  return moveSelection(blocks, pageTitle, uids, "up");
}

export function moveSelectionDown(blocks: BlockNode[], pageTitle: string,
                                  uids: string[]): EditResult {
  return moveSelection(blocks, pageTitle, uids, "down");
}
```

Keep `moveBlockUp`, `moveBlockDown`, `groupMoveOps`, selection indentation, drag movement, and operation protocol unchanged.

- [ ] **Step 6: Run focused tests and type checking; verify GREEN**

```bash
cd web
pnpm test:unit -- \
  src/outline/edits.test.ts \
  src/outline/tree.test.ts \
  src/outline/blockSelection.test.ts \
  src/outline/useOutline.selection.test.tsx \
  src/outline/useOutline.undo.test.tsx \
  src/outline/history.test.ts \
  src/outline/undoManager.test.ts
pnpm typecheck
```

Expected: all selected test files pass, focused subtree operation shapes remain unchanged, cross-parent selected gestures enqueue one batch, undo restores the original hierarchy in one step, and TypeScript reports no errors.

- [ ] **Step 7: Commit and push the pure planner**

```bash
git add \
  web/src/outline/edits.ts \
  web/src/outline/edits.test.ts \
  web/src/outline/useOutline.selection.test.tsx \
  web/src/outline/useOutline.undo.test.tsx
git diff --cached --check
git commit -m "fix(pkm-8jt5): plan atomic selected block moves"
git push
```

---

### Task 2: Unified Keyboard Routing and Legacy Shortcut Removal

**Files:**
- Modify: `web/src/outline/keyboardPolicy.test.ts:79-159,270-300`
- Modify: `web/src/components/EditableBlockTree.test.tsx:9-25,168-194,768-857`
- Modify: `web/src/views/EditablePage.test.tsx:193-207`
- Modify: `web/e2e/edit.spec.ts:75-124`
- Modify: `web/src/outline/keyboardPolicy.ts:32-52,90-110,145-148`
- Modify: `web/src/components/EditableBlockTree.tsx:31-77,128-161,580-606`
- Modify: `web/src/components/AutocompletePopup.test.tsx:12-26`
- Modify: `web/src/outline/useOutline.ts:15-22,255-270,327-355`

**Interfaces:**
- Consumes:
  - `moveSubtreeUp/Down(...)` for focused blocks.
  - Generalized `moveSelectionUp/Down(...)` from Task 1.
- Produces:
  - Focused exact Shift+Meta+Arrow decisions: `move-subtree-up` / `move-subtree-down`.
  - `OutlineHandlers.onMoveSelectionUp(): void` and `onMoveSelectionDown(): void`, now documented and dispatched as selected Shift+Cmd movement.
  - No `move-up` / `move-down` key decisions and no `OutlineHandlers.onMoveUp` / `onMoveDown` shell callbacks.

- [ ] **Step 1: Change focused keyboard-policy tests to require Option/Alt pass-through**

Delete the duplicate subtree-suite test that says Alt+Arrow remains a single-block move. Replace the structural-key Alt test with:

```ts
it("leaves every Option/Alt+Arrow variant to the platform", () => {
  for (const key of ["ArrowUp", "ArrowDown"]) {
    expect(decideEditorKey(input({ key, altKey: true })))
      .toEqual({ type: "none" });
    expect(decideEditorKey(input({
      key, altKey: true, shiftKey: true, metaKey: true,
    }))).toEqual({ type: "none" });
  }
});
```

Keep all focused Shift+Cmd and plain Shift+Arrow tests unchanged.

- [ ] **Step 2: Add failing component routing and pass-through tests**

In the focused keyboard-map test, remove the four Alt event/callback lines. Add this focused test next to it:

```ts
test("Option+Arrow stays with browser text handling", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();

  expect(fireEvent.keyDown(ta, { key: "ArrowUp", altKey: true })).toBe(true);
  expect(fireEvent.keyDown(ta, { key: "ArrowDown", altKey: true })).toBe(true);
  expect(h.onMoveSubtreeUp).not.toHaveBeenCalled();
  expect(h.onMoveSubtreeDown).not.toHaveBeenCalled();
  expect(h.onArrow).not.toHaveBeenCalled();
});
```

Replace the obsolete selected Alt movement test with:

```ts
test("Shift+Cmd+Arrow moves a selection before plain Shift handling", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  expect(fireEvent.keyDown(tree, {
    key: "ArrowUp", shiftKey: true, metaKey: true,
  })).toBe(false);
  expect(h.onMoveSelectionUp).toHaveBeenCalledTimes(1);
  expect(fireEvent.keyDown(tree, {
    key: "ArrowDown", shiftKey: true, metaKey: true,
  })).toBe(false);
  expect(h.onMoveSelectionDown).toHaveBeenCalledTimes(1);
  expect(h.onExtendBlockSelection).not.toHaveBeenCalled();
});

test("selected Option+Arrow remains unhandled", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  expect(fireEvent.keyDown(tree, { key: "ArrowUp", altKey: true })).toBe(true);
  expect(fireEvent.keyDown(tree, { key: "ArrowDown", altKey: true })).toBe(true);
  expect(h.onMoveSelectionUp).not.toHaveBeenCalled();
  expect(h.onMoveSelectionDown).not.toHaveBeenCalled();
  expect(h.onExtendBlockSelection).not.toHaveBeenCalled();
  expect(h.onFocusBlock).not.toHaveBeenCalled();
});

test("read-only Shift+Cmd does not move or extend a selection", () => {
  const h = handlers();
  const { container } = mountSelected(
    h, { anchor: "u1", head: "u2" }, true,
  );
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  expect(fireEvent.keyDown(tree, {
    key: "ArrowUp", shiftKey: true, metaKey: true,
  })).toBe(true);
  expect(h.onMoveSelectionUp).not.toHaveBeenCalled();
  expect(h.onExtendBlockSelection).not.toHaveBeenCalled();
});
```

The existing `Shift+Arrow on the selection extends it` test remains the plain-Shift regression.

- [ ] **Step 3: Replace the real-editor Alt integration test**

Replace the parameterized Alt movement test in `web/src/views/EditablePage.test.tsx` with:

```ts
test.each(["ArrowUp", "ArrowDown"])(
  "Alt+%s does not enqueue a focused block move",
  (key) => {
    const sync = mount(makeSync(), [
      block("u1", "first", { order_idx: 0 }),
      block("u2", "second", { order_idx: 1 }),
      block("u3", "third", { order_idx: 2 }),
    ]);
    const ta = focusBlock("second");

    expect(fireEvent.keyDown(ta, { key, altKey: true })).toBe(true);
    expect(sync.sent).toEqual([]);
  },
);
```

- [ ] **Step 4: Add the failing browser scenario**

Add this test after the existing multi-selection Tab scenario in `web/e2e/edit.spec.ts`:

```ts
test("Shift-Cmd moves a selected run within and across a parent (pkm-8jt5)", async ({ page }) => {
  const title = `SelectedMove${Date.now()}`;
  await login(page);
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await page.getByText("Click to start writing…").click();

  await input(page).fill("left parent");
  await input(page).press("Enter");
  await input(page).fill("left existing");
  await input(page).press("Tab");
  await input(page).press("Enter");
  await input(page).press("Shift+Tab");
  await input(page).fill("source parent");
  await input(page).press("Enter");
  await input(page).fill("source seed");
  await input(page).press("Tab");
  await input(page).press("Enter");
  await input(page).fill("move first");
  await input(page).press("Enter");
  await input(page).fill("move second");
  await input(page).press("Enter");
  await input(page).press("Shift+Tab");
  await input(page).fill("right parent");
  await input(page).press("Escape");

  const rowWithText = (text: string) => page.locator(".block-row", {
    has: page.locator(".block-text", { hasText: text }),
  });
  const leftUid = await rowWithText("left parent").getAttribute("data-uid");
  const sourceUid = await rowWithText("source parent").getAttribute("data-uid");
  const seedUid = await rowWithText("source seed").getAttribute("data-uid");
  const firstUid = await rowWithText("move first").getAttribute("data-uid");
  const secondUid = await rowWithText("move second").getAttribute("data-uid");
  expect(leftUid).not.toBeNull();
  expect(sourceUid).not.toBeNull();
  expect(seedUid).not.toBeNull();
  expect(firstUid).not.toBeNull();
  expect(secondUid).not.toBeNull();

  await rowWithText("move second").locator(".block-text").click();
  await caretToEnd(page);
  await input(page).press("Shift+ArrowUp");
  const tree = page.locator(".block-tree");
  const selectedRows = page.locator(".block-row.selected");
  await expect(tree).toBeFocused();
  await expect(selectedRows).toHaveCount(2);

  const directChildren = (uid: string) => page.locator(
    `.block-row[data-uid="${uid}"] + .block-children > .block > .block-row`,
  );

  await page.keyboard.press("Shift+Meta+ArrowUp");

  const sourceChildren = directChildren(sourceUid!);
  await expect(sourceChildren).toHaveCount(3);
  await expect(sourceChildren.nth(0)).toHaveAttribute("data-uid", firstUid!);
  await expect(sourceChildren.nth(1)).toHaveAttribute("data-uid", secondUid!);
  await expect(sourceChildren.nth(2)).toHaveAttribute("data-uid", seedUid!);
  await expect(tree).toBeFocused();
  await expect(selectedRows).toHaveCount(2);

  await page.keyboard.press("Shift+Meta+ArrowUp");

  await expect(sourceChildren).toHaveCount(1);
  await expect(sourceChildren.nth(0)).toHaveAttribute("data-uid", seedUid!);
  const leftChildren = directChildren(leftUid!);
  await expect(leftChildren).toHaveCount(3);
  await expect(leftChildren.nth(1)).toHaveAttribute("data-uid", firstUid!);
  await expect(leftChildren.nth(2)).toHaveAttribute("data-uid", secondUid!);
  await expect(tree).toBeFocused();
  await expect(selectedRows).toHaveCount(2);
  await expect(selectedRows.nth(0)).toHaveAttribute("data-uid", firstUid!);
  await expect(selectedRows.nth(1)).toHaveAttribute("data-uid", secondUid!);
});
```

- [ ] **Step 5: Run focused unit and browser tests; verify RED**

```bash
cd web
pnpm test:unit -- \
  src/outline/keyboardPolicy.test.ts \
  src/components/EditableBlockTree.test.tsx \
  src/views/EditablePage.test.tsx
pnpm e2e -- e2e/edit.spec.ts --grep "Shift-Cmd moves a selected run"
```

Expected: unit tests fail because focused/selected Alt still dispatches movement and selected Shift+Cmd extends selection; the browser test fails at the first hierarchy assertion because Shift+Cmd extends rather than moves the selected run.

- [ ] **Step 6: Remove focused Option decisions and prevent boundary-arrow fallthrough**

In `KeyDecision`, delete:

```ts
  | { type: "move-up" }
  | { type: "move-down" }
```

Immediately after the exact Shift+Cmd subtree branch, add an explicit Option/Alt pass-through before generic Shift+Arrow:

```ts
  // Option/Alt+Arrow belongs to native text navigation. Catch every modifier
  // variant before Shift selection or boundary-arrow handling can claim it.
  if (i.altKey && (i.key === "ArrowUp" || i.key === "ArrowDown")) {
    return NONE;
  }
```

Delete the later Alt movement branch:

```ts
  if (i.altKey && (i.key === "ArrowUp" || i.key === "ArrowDown")) {
    return i.key === "ArrowUp" ? { type: "move-up" } : { type: "move-down" };
  }
```

Update the Shift+Cmd comment to describe it as the sole movement chord without referring to the removed Alt route.

- [ ] **Step 7: Route selected Shift+Cmd before plain Shift and leave Option untouched**

Replace the selection-owned `onKeyDown` chain in `EditableBlockTree.tsx` with this modifier ordering:

```ts
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (fallback || !selection) return;
    const verticalArrow = e.key === "ArrowUp" || e.key === "ArrowDown";
    if (!readOnly && e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) handlers.onOutdentSelection();
      else handlers.onIndentSelection();
    } else if (e.shiftKey && e.metaKey && !e.ctrlKey && !e.altKey
               && verticalArrow) {
      if (!readOnly) {
        e.preventDefault();
        if (e.key === "ArrowUp") handlers.onMoveSelectionUp();
        else handlers.onMoveSelectionDown();
      }
    } else if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
               && verticalArrow) {
      e.preventDefault();
      handlers.onExtendBlockSelection(e.key === "ArrowUp" ? "up" : "down");
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void navigator.clipboard?.writeText(selectionText(blocks, selection));
    } else if (e.key === "Escape") {
      e.preventDefault();
      handlers.onClearBlockSelection();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      handlers.onDeleteBlockSelection();
    } else if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
               && verticalArrow) {
      e.preventDefault();
      handlers.onFocusBlock(selection.head, 0);
    }
  };
```

This exact-match branch recognizes read-only Shift+Cmd without dispatching or falling into plain Shift extension. Option/Alt reaches no application branch, and the final focus-collapse route accepts only unmodified arrows.

- [ ] **Step 8: Remove dead focused Option callback surfaces**

Delete `onMoveUp` and `onMoveDown` from `OutlineHandlers`, and update the selection movement comment to:

```ts
  /** Shift+Cmd+Arrow while a block selection is active: atomically move every
   * selected root one depth-preserving position. */
  onMoveSelectionUp(): void;
  onMoveSelectionDown(): void;
```

Delete the `move-up` and `move-down` switch cases from `BlockInput.onKeyDown`.

In `useOutline.ts`:

1. Remove `moveBlockUp` and `moveBlockDown` from the edit imports.
2. Delete `onMoveUp` and `onMoveDown` from the handlers object.
3. Replace the selected movement comment with:

```ts
    // Shift+Cmd+Arrow while a block selection is active: the pure planner
    // preflights every selected root run and run() keeps the gesture in one
    // optimistic, synced, undoable batch. Selection state remains active.
```

Remove `onMoveUp: vi.fn(), onMoveDown: vi.fn(),` from the `handlers()` test doubles in:

- `web/src/components/EditableBlockTree.test.tsx`
- `web/src/components/AutocompletePopup.test.tsx`

Keep `moveBlockUp` and `moveBlockDown` exported from `edits.ts`; focused `moveSubtreeUp/Down` still use them for adjacent-sibling swaps.

- [ ] **Step 9: Run focused tests, type checking, and browser regression; verify GREEN**

```bash
cd web
pnpm test:unit -- \
  src/outline/edits.test.ts \
  src/outline/keyboardPolicy.test.ts \
  src/components/EditableBlockTree.test.tsx \
  src/components/AutocompletePopup.test.tsx \
  src/views/EditablePage.test.tsx \
  src/outline/useOutline.selection.test.tsx \
  src/outline/useOutline.undo.test.tsx
pnpm typecheck
pnpm e2e -- e2e/edit.spec.ts --grep "Shift-Cmd moves a selected run"
```

Expected: all selected unit tests pass, TypeScript reports no errors, focused and selected Option/Alt events are unhandled, plain Shift still extends selection, read-only Shift+Cmd dispatches nothing, and the Playwright selected run moves within and then across the source parent while remaining selected.

- [ ] **Step 10: Commit and push the unified keyboard route**

```bash
git add \
  web/src/outline/keyboardPolicy.ts \
  web/src/outline/keyboardPolicy.test.ts \
  web/src/components/EditableBlockTree.tsx \
  web/src/components/EditableBlockTree.test.tsx \
  web/src/components/AutocompletePopup.test.tsx \
  web/src/outline/useOutline.ts \
  web/src/views/EditablePage.test.tsx \
  web/e2e/edit.spec.ts
git diff --cached --check
git commit -m "fix(pkm-8jt5): unify block movement shortcut"
git push
```

---

### Task 3: Full Verification, Review, and Branch Tracking

**Files:**
- Modify: `.beans/pkm-8jt5--move-collapsed-subtrees-and-selections-with-keyboa.md`

**Interfaces:**
- Consumes: completed Tasks 1–2.
- Produces: reviewed, fully verified, pushed feature branch with current beans tracking.

- [ ] **Step 1: Run the focused regression suite**

```bash
cd web
pnpm test:unit -- \
  src/outline/edits.test.ts \
  src/outline/tree.test.ts \
  src/outline/blockSelection.test.ts \
  src/outline/keyboardPolicy.test.ts \
  src/components/EditableBlockTree.test.tsx \
  src/components/AutocompletePopup.test.tsx \
  src/views/EditablePage.test.tsx \
  src/outline/useOutline.selection.test.tsx \
  src/outline/useOutline.undo.test.tsx \
  src/outline/history.test.ts \
  src/outline/undoManager.test.ts
```

Expected: all selected test files pass.

- [ ] **Step 2: Run repository-required full web verification**

```bash
cd web
pnpm verify
```

Expected: typecheck, lint, FCIS validation, enforced unit coverage, production build budgets, and every Playwright test pass.

- [ ] **Step 3: Inspect the final diff and request code review**

```bash
git status --short --branch
git diff origin/main...HEAD --check
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: only the bean, approved spec and plan, focused web implementation, and tests are present. Invoke `superpowers:requesting-code-review`; resolve findings with additional red-green cycles and rerun `pnpm verify` after the last code change.

- [ ] **Step 4: Update the bean with completed implementation work**

```bash
beans update pkm-8jt5 \
  --body-replace-old "- [ ] Add failing regression tests for unified shortcut routing and depth-preserving selected-range movement" \
  --body-replace-new "- [x] Add failing regression tests for unified shortcut routing and depth-preserving selected-range movement"
beans update pkm-8jt5 \
  --body-replace-old "- [ ] Implement the minimal shared fix while preserving single-block and drag behavior" \
  --body-replace-new "- [x] Implement the minimal shared fix while preserving single-block and drag behavior"
beans update pkm-8jt5 \
  --body-replace-old "- [ ] Run focused tests and full web verification" \
  --body-replace-new "- [x] Run focused tests and full web verification"
beans update pkm-8jt5 --body-append $'## Summary of Changes\n\nUnified focused and selected block movement on Shift+Cmd+Arrow, added atomic depth-preserving planning for mixed-depth selected root runs, expanded collapsed cross-parent destinations, removed application-level Option/Alt movement, and covered pure operations, keyboard precedence, read-only behavior, optimistic batching, undo, and browser hierarchy changes.'
```

Leave the final review/merge checklist item and bean status open until integration actually finishes.

- [ ] **Step 5: Commit and push verified branch tracking**

```bash
git add .beans/pkm-8jt5--move-collapsed-subtrees-and-selections-with-keyboa.md
git diff --cached --check
git commit -m "chore(pkm-8jt5): record verified block movement fix"
git push
```

---

### Task 4: Integrate with a Non-Fast-Forward Merge

**Files:**
- Modify after merge on `main`: `.beans/pkm-8jt5--move-collapsed-subtrees-and-selections-with-keyboa.md`

**Interfaces:**
- Consumes: reviewed and fully verified branch `fix/block-selection-keyboard-move`.
- Produces: pushed `main`, completed `pkm-8jt5`, and a removed feature worktree/branch.

- [ ] **Step 1: Confirm branch readiness with required finishing skills**

Invoke `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Confirm the worktree is clean and the latest `pnpm verify` evidence is from the current HEAD.

- [ ] **Step 2: Update and merge into main**

From `/Users/arthur/code/llm/pkm`:

```bash
git switch main
git pull --ff-only origin main
git merge --no-ff fix/block-selection-keyboard-move \
  -m "Merge pkm-8jt5: unified block movement shortcut"
git push origin main
```

Expected: the non-fast-forward merge commit is pushed and branch topology is preserved.

- [ ] **Step 3: Complete the bean only after the merge exists**

```bash
beans update pkm-8jt5 \
  --body-replace-old "- [ ] Review, summarize, complete, commit, push, and merge with --no-ff" \
  --body-replace-new "- [x] Review, summarize, complete, commit, push, and merge with --no-ff" \
  --status completed
git add .beans/pkm-8jt5--move-collapsed-subtrees-and-selections-with-keyboa.md
git diff --cached --check
git commit -m "chore(pkm-8jt5): complete unified movement bean"
git push origin main
```

Expected: `pkm-8jt5` has no unchecked items and is `completed` on pushed `main`.

- [ ] **Step 4: Remove the integrated worktree and branches**

```bash
git worktree remove .worktrees/fix-block-selection-keyboard-move
git branch -d fix/block-selection-keyboard-move
git push origin --delete fix/block-selection-keyboard-move
git status --short --branch
```

Expected: the primary checkout is clean on `main`; the merged local and remote feature branches and linked worktree are removed.
