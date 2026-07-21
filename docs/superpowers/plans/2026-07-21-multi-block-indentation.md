# Multi-Block Tab Indentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tab and Shift-Tab atomically move an active multi-block selection exactly one nesting level while preserving order and hierarchy.

**Architecture:** Add dedicated pure selection planners in `edits.ts` that reduce selected descendants to roots, partition roots into original-tree sibling runs, preflight every run, and emit one ordered operation batch. Wire the planners through `useOutline` and the tree-owned selection keyboard handler so the existing optimistic sync and undo pipeline remains unchanged.

**Tech Stack:** TypeScript, React 18, Vitest, Testing Library, Playwright, pnpm.

## Global Constraints

- Work only in `.worktrees/pkm-0ovd-multi-block-indent` on branch `fix/pkm-0ovd-multi-block-indent`.
- Follow red-green-refactor: every production behavior must have a test that was observed failing first.
- Keep pure tree planning in Functional Core files and DOM/state/persistence wiring in Imperative Shell files.
- A gesture is all-or-nothing across every selected root run.
- A successful gesture changes every selected block's absolute depth by exactly one level.
- Preserve selected root order and nested subtree relationships; never staircase selected siblings.
- Keep the selection active after success and after structural no-ops.
- Do not add server, schema, API, replica, or generic tree-diff changes.
- Hierarchy-preserving paste remains separate in `pkm-tu3a`.
- Push after every commit.

## File Map

- `web/src/outline/edits.ts` — pure sibling-run discovery, preflight, and selection indent/outdent planning.
- `web/src/outline/edits.test.ts` — operation-level behavior, mixed-depth cases, and atomic edge tests.
- `web/src/components/EditableBlockTree.tsx` — selection handler interface and tree-level Tab dispatch.
- `web/src/components/EditableBlockTree.test.tsx` — DOM keyboard dispatch, default prevention, and read-only gating.
- `web/src/components/AutocompletePopup.test.tsx` — update the shared `OutlineHandlers` test double for the new callbacks.
- `web/src/outline/useOutline.ts` — connect live selection state to the pure planners through `run`.
- `web/src/outline/useOutline.selection.test.tsx` — exact queued batches and selection preservation.
- `web/src/outline/useOutline.undo.test.tsx` — prove a whole selection gesture is one undo step.
- `web/e2e/edit.spec.ts` — real Shift+Arrow selection followed by Tab and Shift-Tab.
- `.beans/pkm-0ovd--make-multi-block-tab-indentation-match-single-bloc.md` — implementation and verification tracking.

---

### Task 1: Pure Atomic Selection Planners

**Files:**
- Modify: `web/src/outline/edits.test.ts` in the existing `indent / outdent` area.
- Modify: `web/src/outline/edits.ts` beside `indentBlock` and `outdentBlock`.

**Interfaces:**
- Consumes: `selectionRoots(blocks, uids)`, `locate(blocks, uid)`, `groupMoveOps(uids, parentUid, orderIdx)`, and the existing `EditResult` contract.
- Produces:
  - `indentSelection(blocks: BlockNode[], pageTitle: string, uids: string[]): EditResult`
  - `outdentSelection(blocks: BlockNode[], pageTitle: string, uids: string[]): EditResult`

- [ ] **Step 1: Add failing pure edit tests**

Extend the import in `web/src/outline/edits.test.ts` to include the new commands:

```ts
import { backspaceAtStart, clampCaret, deleteSelection, indentBlock,
         indentSelection, moveBlockDown, moveBlocksTo, moveBlockUp,
         moveSelectionDown, moveSelectionUp, moveSubtreeDown, moveSubtreeUp,
         outdentBlock, outdentSelection, setCollapsed, setHeading,
         setViewType, splitBlock } from "./edits";
```

Add this fixture and test group after the existing single-block indent/outdent tests:

```ts
const selectionTree = () => [
  block("a", "A", {
    order_idx: 0,
    children: [
      block("a0", "A zero", { order_idx: 0 }),
      block("a1", "A one", {
        order_idx: 1,
        children: [block("a1x", "A one child", { order_idx: 0 })],
      }),
    ],
  }),
  block("b", "B", {
    order_idx: 1,
    children: [block("b1", "B child", { order_idx: 0 })],
  }),
  block("c", "C", { order_idx: 2 }),
];

const mixedOutdentTree = () => [
  block("root", "Root", {
    order_idx: 0,
    children: [
      block("p", "P", {
        order_idx: 0,
        children: [
          block("p0", "P zero", { order_idx: 0 }),
          block("x", "X", { order_idx: 1 }),
        ],
      }),
      block("q", "Q", {
        order_idx: 1,
        children: [block("q1", "Q child", { order_idx: 0 })],
      }),
    ],
  }),
  block("z", "Z", { order_idx: 1 }),
];

describe("indentSelection / outdentSelection (pkm-0ovd)", () => {
  test("indents one sibling run under one parent without staircasing", () => {
    const r = indentSelection(selectionTree(), P, ["b", "b1", "c"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "b", parent_uid: "a", order_idx: 2 },
      { op: "move", uid: "c", parent_uid: "a", order_idx: 3 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a"]);
    expect(findNode(r.blocks, "a")!.children.map((n) => n.uid))
      .toEqual(["a0", "a1", "b", "c"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1"]);
  });

  test("indents mixed-level roots from original destinations by one level", () => {
    const r = indentSelection(selectionTree(), P, ["a1", "a1x", "b", "b1"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a1", parent_uid: "a0", order_idx: 0 },
      { op: "move", uid: "b", parent_uid: "a", order_idx: 2 },
    ]);
    expect(findNode(r.blocks, "a0")!.children.map((n) => n.uid))
      .toEqual(["a1"]);
    expect(findNode(r.blocks, "a1")!.children.map((n) => n.uid))
      .toEqual(["a1x"]);
    expect(findNode(r.blocks, "a")!.children.map((n) => n.uid))
      .toEqual(["a0", "b"]);
    expect(findNode(r.blocks, "b")!.children.map((n) => n.uid))
      .toEqual(["b1"]);
  });

  test("expands a collapsed destination once before moving its run", () => {
    const t = selectionTree();
    findNode(t, "a")!.collapsed = true;

    const r = indentSelection(t, P, ["b", "b1", "c"]);

    expect(r.ops).toEqual([
      { op: "set_collapsed", uid: "a", collapsed: false },
      { op: "move", uid: "b", parent_uid: "a", order_idx: 2 },
      { op: "move", uid: "c", parent_uid: "a", order_idx: 3 },
    ]);
  });

  test("one first-sibling run aborts every indent run", () => {
    const t = selectionTree();
    const r = indentSelection(
      t, P, ["a0", "a1", "a1x", "b", "b1"],
    );

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("outdents one sibling run consecutively after its former parent", () => {
    const r = outdentSelection(selectionTree(), P, ["a0", "a1", "a1x"]);

    expect(r.ops).toEqual([
      { op: "move", uid: "a0", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "a1", parent_uid: null, order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid))
      .toEqual(["a", "a0", "a1", "b", "c"]);
    expect(findNode(r.blocks, "a1")!.children.map((n) => n.uid))
      .toEqual(["a1x"]);
  });

  test("outdents mixed-level roots once while preserving their subtrees", () => {
    const r = outdentSelection(
      mixedOutdentTree(), P, ["x", "q", "q1"],
    );

    expect(r.ops).toEqual([
      { op: "move", uid: "x", parent_uid: "root", order_idx: 1 },
      { op: "move", uid: "q", parent_uid: null, order_idx: 1 },
    ]);
    expect(findNode(r.blocks, "root")!.children.map((n) => n.uid))
      .toEqual(["p", "x"]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["root", "q", "z"]);
    expect(findNode(r.blocks, "q")!.children.map((n) => n.uid))
      .toEqual(["q1"]);
  });

  test("one top-level root aborts every outdent run", () => {
    const t = selectionTree();
    const r = outdentSelection(t, P, ["a1", "a1x", "b", "b1"]);

    expect(r.ops).toEqual([]);
    expect(r.blocks).toBe(t);
  });

  test("empty or missing selections are no-ops", () => {
    const t = selectionTree();
    expect(indentSelection(t, P, []).ops).toEqual([]);
    expect(outdentSelection(t, P, []).ops).toEqual([]);
    expect(indentSelection(t, P, ["missing"]).ops).toEqual([]);
    expect(outdentSelection(t, P, ["missing"]).ops).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cd web
pnpm exec vitest run src/outline/edits.test.ts
```

Expected: FAIL because `indentSelection` and `outdentSelection` are not exported by `edits.ts`.

- [ ] **Step 3: Implement sibling-run discovery and both pure planners**

Insert this code in `web/src/outline/edits.ts` immediately before `indentBlock`:

```ts
interface SelectionSiblingRun {
  uids: string[];
  parent: BlockNode | null;
  siblings: BlockNode[];
  first: number;
}

/** Reduce selected descendants to roots, then group consecutive roots that
 * shared a parent in the original tree. All destinations are derived from
 * these original runs before any move is applied. */
function selectionSiblingRuns(blocks: BlockNode[], uids: string[]):
    SelectionSiblingRun[] | null {
  if (uids.length === 0) return [];
  if (uids.some((uid) => !locate(blocks, uid))) return null;
  const runs: SelectionSiblingRun[] = [];
  for (const uid of selectionRoots(blocks, uids)) {
    const found = locate(blocks, uid);
    if (!found) return null;
    const last = runs[runs.length - 1];
    if (last && last.siblings === found.siblings
        && found.index === last.first + last.uids.length) {
      last.uids.push(uid);
    } else {
      runs.push({
        uids: [uid], parent: found.parent,
        siblings: found.siblings, first: found.index,
      });
    }
  }
  return runs;
}

/** Indent every selected root exactly once. Complete preflight precedes op
 * generation, so one first-sibling run aborts the whole gesture and selected
 * siblings can never become one another's parent. */
export function indentSelection(blocks: BlockNode[], pageTitle: string,
                                uids: string[]): EditResult {
  const runs = selectionSiblingRuns(blocks, uids);
  if (!runs || runs.length === 0 || runs.some((run) => run.first === 0)) {
    return noop(blocks);
  }
  const ops: BlockOp[] = [];
  for (const run of runs) {
    const target = run.siblings[run.first - 1];
    const lastChild = target.children[target.children.length - 1];
    if (target.collapsed) {
      ops.push({ op: "set_collapsed", uid: target.uid, collapsed: false });
    }
    ops.push(...groupMoveOps(
      run.uids, target.uid, lastChild ? lastChild.order_idx + 1 : 0,
    ));
  }
  return done(blocks, pageTitle, ops, null);
}

/** Outdent every selected root exactly once. A top-level run aborts the whole
 * gesture; otherwise each run lands consecutively after its former parent. */
export function outdentSelection(blocks: BlockNode[], pageTitle: string,
                                 uids: string[]): EditResult {
  const runs = selectionSiblingRuns(blocks, uids);
  if (!runs || runs.length === 0
      || runs.some((run) => run.parent === null)) {
    return noop(blocks);
  }
  const plans: Array<{
    uids: string[];
    parentUid: string | null;
    orderIdx: number;
  }> = [];
  for (const run of runs) {
    if (!run.parent) return noop(blocks);
    const parentLoc = locate(blocks, run.parent.uid);
    if (!parentLoc) return noop(blocks);
    plans.push({
      uids: run.uids,
      parentUid: parentLoc.parent?.uid ?? null,
      orderIdx: idxAfter(parentLoc.siblings, parentLoc.index),
    });
  }
  const ops = plans.flatMap((plan) =>
    groupMoveOps(plan.uids, plan.parentUid, plan.orderIdx));
  return done(blocks, pageTitle, ops, null);
}
```

Keep the existing single-block `indentBlock` and `outdentBlock` implementations unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd web
pnpm exec vitest run src/outline/edits.test.ts src/outline/tree.test.ts
pnpm typecheck
```

Expected: all selected test files pass and TypeScript reports no errors.

- [ ] **Step 5: Commit and push the pure planner**

```bash
git add web/src/outline/edits.ts web/src/outline/edits.test.ts
git diff --cached --check
git commit -m "feat(pkm-0ovd): plan atomic selection indentation"
git push
```

---

### Task 2: Keyboard, Hook, and Undo Wiring

**Files:**
- Modify: `web/src/components/EditableBlockTree.test.tsx` around `handlers`, `mountSelected`, and selection keyboard tests.
- Modify: `web/src/components/AutocompletePopup.test.tsx` in its `OutlineHandlers` test double.
- Modify: `web/src/outline/useOutline.selection.test.tsx` after selection movement tests.
- Modify: `web/src/outline/useOutline.undo.test.tsx` after the single-block structural undo test.
- Modify: `web/e2e/edit.spec.ts` after the core editing-loop test.
- Modify: `web/src/components/EditableBlockTree.tsx` in `OutlineHandlers` and the tree-level `onKeyDown`.
- Modify: `web/src/outline/useOutline.ts` imports and selection handler block.

**Interfaces:**
- Consumes:
  - `indentSelection(blocks, pageTitle, uids): EditResult`
  - `outdentSelection(blocks, pageTitle, uids): EditResult`
- Produces:
  - `OutlineHandlers.onIndentSelection(): void`
  - `OutlineHandlers.onOutdentSelection(): void`

- [ ] **Step 1: Add failing component keyboard tests**

In both `EditableBlockTree.test.tsx` and `AutocompletePopup.test.tsx`, add the new callbacks to the `handlers()` object beside the existing selection movement callbacks:

```ts
onIndentSelection: vi.fn(), onOutdentSelection: vi.fn(),
```

Change `mountSelected` in `EditableBlockTree.test.tsx` to accept read-only state:

```ts
function mountSelected(
  h: OutlineHandlers,
  selection: { anchor: string; head: string },
  readOnly = false,
) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={BLOCKS} focus={null} selection={selection}
                         handlers={h} readOnly={readOnly} />
    </MemoryRouter>);
}
```

Add these tests beside the existing selection keyboard tests:

```ts
test("Tab and Shift-Tab indent and outdent an editable selection (pkm-0ovd)", () => {
  const h = handlers();
  const { container } = mountSelected(h, { anchor: "u1", head: "u2" });
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  expect(fireEvent.keyDown(tree, { key: "Tab" })).toBe(false);
  expect(h.onIndentSelection).toHaveBeenCalledTimes(1);
  expect(fireEvent.keyDown(tree, { key: "Tab", shiftKey: true })).toBe(false);
  expect(h.onOutdentSelection).toHaveBeenCalledTimes(1);
});

test("Tab does not mutate a read-only selection (pkm-0ovd)", () => {
  const h = handlers();
  const { container } = mountSelected(
    h, { anchor: "u1", head: "u2" }, true,
  );
  const tree = container.querySelector(".block-tree") as HTMLDivElement;

  expect(fireEvent.keyDown(tree, { key: "Tab" })).toBe(true);
  expect(fireEvent.keyDown(tree, { key: "Tab", shiftKey: true })).toBe(true);
  expect(h.onIndentSelection).not.toHaveBeenCalled();
  expect(h.onOutdentSelection).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Add failing hook, undo, and browser tests**

Add this test to `useOutline.selection.test.tsx`:

```ts
it("indents and outdents the selected run as one batch without clearing it", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection("b", "down"));

  act(() => getOutline().handlers.onIndentSelection());

  expect(sync.sent).toEqual([[
    { op: "move", uid: "b", parent_uid: "a", order_idx: 0 },
    { op: "move", uid: "c", parent_uid: "a", order_idx: 1 },
  ]]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["a"]);
  expect(getOutline().blocks[0].children.map((b) => b.uid))
    .toEqual(["b", "c"]);
  expect(getOutline().selection).toEqual({ anchor: "b", head: "c" });

  act(() => getOutline().handlers.onOutdentSelection());

  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "b", parent_uid: null, order_idx: 1 },
    { op: "move", uid: "c", parent_uid: null, order_idx: 2 },
  ]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["a", "b", "c"]);
  expect(getOutline().selection).toEqual({ anchor: "b", head: "c" });
});

it("keeps the whole selection unchanged when one indent run is ineligible", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", abc());
  act(() => getOutline().handlers.onStartBlockSelection("a", "down"));

  act(() => getOutline().handlers.onIndentSelection());

  expect(sync.sent).toEqual([]);
  expect(getOutline().blocks.map((b) => b.uid)).toEqual(["a", "b", "c"]);
  expect(getOutline().selection).toEqual({ anchor: "a", head: "b" });
});
```

Add this test to `useOutline.undo.test.tsx`:

```ts
it("undo reverses a whole selection indent in one step", () => {
  const sync = makeSync();
  const outline = setup(sync, PAGE, [
    block("a", "alpha", { order_idx: 0 }),
    block("b", "beta", { order_idx: 1 }),
    block("c", "gamma", { order_idx: 2 }),
  ]);
  act(() => outline().handlers.onStartBlockSelection("b", "down"));
  act(() => outline().handlers.onIndentSelection());
  expect(outline().blocks[0].children.map((n) => n.uid))
    .toEqual(["b", "c"]);

  act(() => outline().handlers.onUndo());

  expect(outline().blocks.map((n) => n.uid)).toEqual(["a", "b", "c"]);
  expect(sync.sent).toHaveLength(2);
  expect(sync.sent[1]).toEqual([
    { op: "move", uid: "c", parent_uid: null, order_idx: 2 },
    { op: "move", uid: "b", parent_uid: null, order_idx: 1 },
  ]);
});
```

Add this test to `web/e2e/edit.spec.ts`:

```ts
test("Tab and Shift-Tab move a multi-block selection one level (pkm-0ovd)", async ({ page }) => {
  const title = `MultiIndent${Date.now()}`;
  await login(page);
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await page.getByText("Click to start writing…").click();

  await input(page).fill("indent parent");
  await input(page).press("Enter");
  await input(page).fill("indent first");
  await input(page).press("Enter");
  await input(page).fill("indent second");

  const topRows = page.locator(".block-tree > .block > .block-row");
  await expect(topRows).toHaveCount(3);
  const parentUid = await topRows.nth(0).getAttribute("data-uid");
  const firstUid = await topRows.nth(1).getAttribute("data-uid");
  const secondUid = await topRows.nth(2).getAttribute("data-uid");
  expect(parentUid).not.toBeNull();
  expect(firstUid).not.toBeNull();
  expect(secondUid).not.toBeNull();

  await input(page).press("Shift+ArrowUp");
  const tree = page.locator(".block-tree");
  await expect(tree).toBeFocused();
  await expect(page.locator(".block-row.selected")).toHaveCount(2);

  await page.keyboard.press("Tab");

  const childRows = page.locator(
    `.block-row[data-uid="${parentUid}"] + .block-children > .block > .block-row`,
  );
  await expect(childRows).toHaveCount(2);
  await expect(childRows.nth(0)).toHaveAttribute("data-uid", firstUid!);
  await expect(childRows.nth(1)).toHaveAttribute("data-uid", secondUid!);
  await expect(tree).toBeFocused();
  await expect(page.locator(".block-row.selected")).toHaveCount(2);

  await page.keyboard.press("Shift+Tab");

  await expect(topRows).toHaveCount(3);
  await expect(topRows.nth(0)).toHaveAttribute("data-uid", parentUid!);
  await expect(topRows.nth(1)).toHaveAttribute("data-uid", firstUid!);
  await expect(topRows.nth(2)).toHaveAttribute("data-uid", secondUid!);
  await expect(tree).toBeFocused();
  await expect(page.locator(".block-row.selected")).toHaveCount(2);
});
```

- [ ] **Step 3: Run the new tests and verify RED**

Run the focused unit tests:

```bash
cd web
pnpm exec vitest run \
  src/components/EditableBlockTree.test.tsx \
  src/outline/useOutline.selection.test.tsx \
  src/outline/useOutline.undo.test.tsx
```

Expected: FAIL because the tree does not dispatch Tab and `useOutline` has no selection indent/outdent callbacks.

Then run the browser regression against the same missing wiring:

```bash
pnpm build
node tooling/runPlaywright.mjs e2e/edit.spec.ts
```

Expected: the new test FAILS when unhandled Tab moves browser focus instead of creating two child rows.

- [ ] **Step 4: Extend `OutlineHandlers` and dispatch tree-owned Tab**

Add these methods to `OutlineHandlers` in `EditableBlockTree.tsx` immediately before selection movement methods:

```ts
/** Tab/Shift-Tab while a block selection is active: atomically change every
 * selected root's depth by one while preserving the selected structure. */
onIndentSelection(): void;
onOutdentSelection(): void;
```

Add the Tab branch first in the selection-owned `onKeyDown`, before Shift+Arrow handling:

```ts
if (!readOnly && e.key === "Tab") {
  e.preventDefault();
  if (e.shiftKey) handlers.onOutdentSelection();
  else handlers.onIndentSelection();
} else if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
```

Leave read-only Tab unhandled so normal browser focus traversal remains available.

- [ ] **Step 5: Wire selection commands through `useOutline.run`**

Update the edit imports in `useOutline.ts`:

```ts
import { backspaceAtStart, deleteSelection, indentBlock, indentSelection,
         moveBlockDown, moveBlocksTo, moveBlockUp, moveSelectionDown,
         moveSelectionUp, moveSubtreeDown, moveSubtreeUp, outdentBlock,
         outdentSelection, setCollapsed, setHeading, splitBlock, setViewType,
         type EditResult, type FocusTarget } from "./edits";
```

Add these handlers immediately before `onMoveSelectionUp`:

```ts
onIndentSelection: () => {
  if (!selection) return;
  run((b) => indentSelection(b, pageTitle, selectedUids(b, selection)));
},
onOutdentSelection: () => {
  if (!selection) return;
  run((b) => outdentSelection(b, pageTitle, selectedUids(b, selection)));
},
```

Do not clear `selection`; the existing memo dependency on `selection` already keeps these closures current.

- [ ] **Step 6: Run focused tests and type checking; verify GREEN**

Run:

```bash
cd web
pnpm exec vitest run \
  src/outline/edits.test.ts \
  src/components/EditableBlockTree.test.tsx \
  src/components/AutocompletePopup.test.tsx \
  src/outline/useOutline.selection.test.tsx \
  src/outline/useOutline.undo.test.tsx
pnpm typecheck
pnpm build
node tooling/runPlaywright.mjs e2e/edit.spec.ts
```

Expected: all selected unit tests and `e2e/edit.spec.ts` pass, and TypeScript reports no errors.

- [ ] **Step 7: Commit and push the complete UI wiring**

```bash
git add \
  web/src/components/EditableBlockTree.tsx \
  web/src/components/EditableBlockTree.test.tsx \
  web/src/components/AutocompletePopup.test.tsx \
  web/src/outline/useOutline.ts \
  web/src/outline/useOutline.selection.test.tsx \
  web/src/outline/useOutline.undo.test.tsx \
  web/e2e/edit.spec.ts
git diff --cached --check
git commit -m "fix(pkm-0ovd): apply Tab to block selections"
git push
```

---

### Task 3: Full Verification and Branch Review

**Files:**
- Modify: `.beans/pkm-0ovd--make-multi-block-tab-indentation-match-single-bloc.md`

**Interfaces:**
- Consumes: the complete implementation from Tasks 1–2.
- Produces: verified branch state and current beans tracking ready for integration.

- [ ] **Step 1: Run the focused regression suite**

```bash
cd web
pnpm exec vitest run \
  src/outline/edits.test.ts \
  src/outline/tree.test.ts \
  src/components/EditableBlockTree.test.tsx \
  src/components/AutocompletePopup.test.tsx \
  src/outline/useOutline.selection.test.tsx \
  src/outline/useOutline.undo.test.tsx
```

Expected: all selected test files pass.

- [ ] **Step 2: Run the repository-required full web verification**

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

Expected: only the spec, plan, beans, focused web implementation, and tests are present. Invoke `superpowers:requesting-code-review`; resolve any findings with additional red-green cycles and rerun `pnpm verify` after the last change.

- [ ] **Step 4: Update branch tracking after review**

Check off these bean items:

```bash
beans update pkm-0ovd \
  --body-replace-old "- [ ] Write and review implementation plan" \
  --body-replace-new "- [x] Write and review implementation plan"
beans update pkm-0ovd \
  --body-replace-old "- [ ] Implement with failing tests first" \
  --body-replace-new "- [x] Implement with failing tests first"
beans update pkm-0ovd \
  --body-replace-old "- [ ] Run focused and full verification" \
  --body-replace-new "- [x] Run focused and full verification"
beans update pkm-0ovd --body-append $'## Summary of Changes\n\nAdded atomic one-level Tab and Shift-Tab planning for multi-block selections, wired it through tree-owned selection keyboard handling and the existing sync/undo pipeline, and covered same-level, mixed-level, read-only, atomic-edge, undo, and browser round-trip behavior.'
```

Leave the final merge checklist item and bean status open until integration actually finishes.

- [ ] **Step 5: Commit and push branch tracking**

```bash
git add .beans/pkm-0ovd--make-multi-block-tab-indentation-match-single-bloc.md
git diff --cached --check
git commit -m "chore(pkm-0ovd): record verified implementation"
git push
```

---

### Task 4: Integrate with a Non-Fast-Forward Merge

**Files:**
- Modify after merge on `main`: `.beans/pkm-0ovd--make-multi-block-tab-indentation-match-single-bloc.md`

**Interfaces:**
- Consumes: reviewed and fully verified branch `fix/pkm-0ovd-multi-block-indent`.
- Produces: pushed `main`, completed `pkm-0ovd`, and a cleaned worktree.

- [ ] **Step 1: Confirm branch readiness using the finishing skill**

Invoke `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Confirm the worktree is clean and the latest `pnpm verify` evidence is from the current HEAD.

- [ ] **Step 2: Update and merge into main**

From the primary checkout:

```bash
git switch main
git pull --ff-only origin main
git merge --no-ff fix/pkm-0ovd-multi-block-indent \
  -m "Merge pkm-0ovd: multi-block Tab indentation"
git push origin main
```

Expected: the merge commit is pushed and branch topology is preserved.

- [ ] **Step 3: Complete the bean only after the merge exists**

```bash
beans update pkm-0ovd \
  --body-replace-old "- [ ] Review, complete bean, commit, push, and merge with --no-ff" \
  --body-replace-new "- [x] Review, complete bean, commit, push, and merge with --no-ff" \
  --status completed
git add .beans/pkm-0ovd--make-multi-block-tab-indentation-match-single-bloc.md
git diff --cached --check
git commit -m "chore(pkm-0ovd): complete multi-block indentation bean"
git push origin main
```

Expected: `pkm-0ovd` has no unchecked items and is `completed` on pushed `main`.

- [ ] **Step 4: Remove the integrated worktree and branches**

```bash
git worktree remove .worktrees/pkm-0ovd-multi-block-indent
git branch -d fix/pkm-0ovd-multi-block-indent
git push origin --delete fix/pkm-0ovd-multi-block-indent
git status --short --branch
```

Expected: the primary checkout is clean on `main`; the merged local and remote feature branches are removed.
