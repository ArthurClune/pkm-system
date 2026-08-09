# Outdent Reparents Following Siblings (pkm-udqj) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outdenting a block takes its following siblings with it as children (Logseq/Workflowy behavior), so the page reads identically top-to-bottom and outdenting the last child becomes an "insert after this subtree" gesture.

**Architecture:** Pure change to the two Functional Core edit planners (`outdentBlock`, `outdentSelection`) in `web/src/outline/edits.ts`, sharing one new private helper `adoptTrailingOps`. All new behavior is expressed with existing `move` + `set_collapsed` ops — no server, API, or schema changes. Spec: `docs/superpowers/specs/2026-08-09-outdent-reparents-siblings-design.md`.

**Tech Stack:** TypeScript, vitest (`cd web && pnpm test:unit`), pnpm.

## Global Constraints

- Work in the worktree at `/Users/arthur/code/llm/pkm/.claude/worktrees/outdent-reparents-siblings` on branch `worktree-outdent-reparents-siblings`. Run `git status -sb` before every commit to confirm you are on that branch.
- `web/src/outline/edits.ts` is `# pattern: Functional Core` — no I/O, no clock, no randomness may be added.
- Op semantics (header comment of edits.ts): `MoveOp.order_idx` means "insert before the block currently at order_idx, counted BEFORE the moved block is removed". order_idx values are always read off the tree (`node.order_idx`), never array positions — the server leaves gaps.
- Ops are computed entirely from the ORIGINAL tree; nothing is applied until `done()` calls `applyOps`. Keep it that way.
- Indent behavior must NOT change. `moveBlockUp/Down`, `moveSubtreeUp/Down` must NOT change. Top-level outdent stays a no-op.
- Update the bean checklist in `.beans/pkm-udqj--outdent-reparents-following-siblings.md` as tasks complete; commit bean updates with the code.

---

### Task 1: `adoptTrailingOps` helper + `outdentBlock` adoption

**Files:**
- Modify: `web/src/outline/edits.ts:207-218` (`outdentBlock`; add helper just above it)
- Test: `web/src/outline/edits.test.ts` (describe `"indent / outdent"`, lines 84-120)

**Interfaces:**
- Consumes: existing `locate` (from `./tree`; returns `{ node, parent, siblings, index }` or `null`), `idxAfter(siblings, index)`, `groupMoveOps(uids, parentUid, orderIdx)` (declared at edits.ts:388 — function declarations hoist, calling it from above is already done by `indentSelection`), `noop`, `done`.
- Produces: `function adoptTrailingOps(adopter: BlockNode, siblings: BlockNode[], from: number, to: number): BlockOp[]` — module-private (not exported), reused by Task 2. Emits `[]` for an empty range; otherwise an optional `set_collapsed` for a collapsed adopter followed by one `move` per adopted sibling onto `adopter.uid`, order_idx starting after the adopter's last existing child.

- [ ] **Step 1: Update the existing outdent test and add the new failing tests**

In `web/src/outline/edits.test.ts`, replace the test at line 109
(`"outdent becomes the sibling right after its old parent"`) with:

```ts
  test("outdent lands after its old parent and adopts trailing siblings", () => {
    const r = outdentBlock(tree(), P, "b1");
    expect(r.ops).toEqual([
      { op: "move", uid: "b1", parent_uid: null, order_idx: 7 }, // before c
      { op: "move", uid: "b2", parent_uid: "b1", order_idx: 0 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "b", "b1", "c"]);
    expect(findNode(r.blocks, "b1")!.children.map((n) => n.uid))
      .toEqual(["b2"]);
    expect(findNode(r.blocks, "b")!.children).toEqual([]);
  });
```

Then add these four tests after it (still inside `describe("indent / outdent")`),
plus the `adoptionTree` fixture right after the existing `tree` fixture at the
top of the file (after line 35):

```ts
const adoptionTree = () => [
  block("p", "parent", {
    order_idx: 0,
    children: [
      block("u", "u-block", {
        order_idx: 0,
        children: [block("u1", "u child", { order_idx: 4 })],
      }),
      block("s1", "sib one", { order_idx: 1 }),
      block("s2", "sib two", { order_idx: 2 }),
    ],
  }),
  block("z", "zed", { order_idx: 9 }),
];
```

```ts
  test("outdenting the last child emits no adoption ops", () => {
    const r = outdentBlock(tree(), P, "b2");
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: null, order_idx: 7 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["a", "b", "b2", "c"]);
  });

  test("adopted siblings append after the block's existing children", () => {
    const r = outdentBlock(adoptionTree(), P, "u");
    expect(r.ops).toEqual([
      { op: "move", uid: "u", parent_uid: null, order_idx: 9 }, // before z
      { op: "move", uid: "s1", parent_uid: "u", order_idx: 5 }, // u1 is 4
      { op: "move", uid: "s2", parent_uid: "u", order_idx: 6 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["p", "u", "z"]);
    expect(findNode(r.blocks, "u")!.children.map((n) => n.uid))
      .toEqual(["u1", "s1", "s2"]);
    expect(findNode(r.blocks, "p")!.children).toEqual([]);
  });

  test("a collapsed block expands when it adopts trailing siblings", () => {
    const t = adoptionTree();
    findNode(t, "u")!.collapsed = true;
    const r = outdentBlock(t, P, "u");
    expect(r.ops).toEqual([
      { op: "move", uid: "u", parent_uid: null, order_idx: 9 },
      { op: "set_collapsed", uid: "u", collapsed: false },
      { op: "move", uid: "s1", parent_uid: "u", order_idx: 5 },
      { op: "move", uid: "s2", parent_uid: "u", order_idx: 6 },
    ]);
  });

  test("no expand op when a collapsed block adopts nothing", () => {
    const t = tree();
    findNode(t, "b2")!.collapsed = true;
    const r = outdentBlock(t, P, "b2");
    expect(r.ops).toEqual([
      { op: "move", uid: "b2", parent_uid: null, order_idx: 7 },
    ]);
  });
```

Leave `"top-level blocks can't outdent"` (line 117) untouched — it must keep
passing.

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd web && pnpm test:unit -- src/outline/edits.test.ts`
Expected: the replaced test and the three adoption tests FAIL (extra/missing
ops); `"outdenting the last child emits no adoption ops"` and the top-level
no-op test PASS (they assert current behavior).

- [ ] **Step 3: Implement `adoptTrailingOps` and wire it into `outdentBlock`**

In `web/src/outline/edits.ts`, insert directly above `outdentBlock` (line 207):

```ts
/** Ops that reparent siblings[from..to) under `adopter`, appended after its
 * existing children in order — outdent takes the following siblings with it,
 * so the page reads identically top-to-bottom before and after (pkm-udqj).
 * A collapsed adopter is expanded first so the adopted blocks don't silently
 * vanish into its subtree (mirrors indentBlock). */
function adoptTrailingOps(adopter: BlockNode, siblings: BlockNode[],
                          from: number, to: number): BlockOp[] {
  const adopted = siblings.slice(from, to);
  if (adopted.length === 0) return [];
  const ops: BlockOp[] = [];
  if (adopter.collapsed) {
    ops.push({ op: "set_collapsed", uid: adopter.uid, collapsed: false });
  }
  const last = adopter.children[adopter.children.length - 1];
  ops.push(...groupMoveOps(adopted.map((n) => n.uid), adopter.uid,
                           last ? last.order_idx + 1 : 0));
  return ops;
}
```

Replace `outdentBlock` (lines 207-218) with:

```ts
/** Outdent lands right after its old parent and adopts its former following
 * siblings as children — the page reads identically top-to-bottom. */
export function outdentBlock(blocks: BlockNode[], pageTitle: string,
                             uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.parent === null) return noop(blocks);
  const parentLoc = locate(blocks, found.parent.uid);
  if (!parentLoc) return noop(blocks);
  const ops: BlockOp[] = [{
    op: "move", uid, parent_uid: parentLoc.parent?.uid ?? null,
    order_idx: idxAfter(parentLoc.siblings, parentLoc.index),
  }];
  ops.push(...adoptTrailingOps(found.node, found.siblings,
                               found.index + 1, found.siblings.length));
  return done(blocks, pageTitle, ops, null);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm test:unit -- src/outline/edits.test.ts`
Expected: ALL tests in the file PASS (including the untouched
`outdentSelection` describe — Task 1 must not change selection behavior).

- [ ] **Step 5: Update the bean checklist and commit**

Tick the Task 1 item in `.beans/pkm-udqj--outdent-reparents-following-siblings.md`.

```bash
git status -sb   # must show worktree-outdent-reparents-siblings
git add web/src/outline/edits.ts web/src/outline/edits.test.ts .beans/
git commit -m "pkm-udqj: outdentBlock adopts trailing siblings as children"
```

---

### Task 2: `outdentSelection` adoption per run

**Files:**
- Modify: `web/src/outline/edits.ts:165-190` (`outdentSelection`)
- Test: `web/src/outline/edits.test.ts` (describe `"indentSelection / outdentSelection (pkm-0ovd)"`, lines 160-259)

**Interfaces:**
- Consumes: `adoptTrailingOps(adopter, siblings, from, to)` from Task 1; `selectionSiblingRuns` (edits.ts:118 — returns document-ordered runs of CONSECUTIVE selected sibling roots as `{ uids, parent, siblings, first }`, or `null` for unknown uids); `groupMoveOps`, `idxAfter`, `locate`, `noop`, `done`.
- Produces: no new exports; `outdentSelection` keeps its signature `(blocks, pageTitle, uids) => EditResult`.

Background you need: runs are consecutive, so `run.siblings[run.first + run.uids.length - 1]` is the run's last selected node. Each run adopts the unselected siblings between its end and the NEXT run in the same sibling group (`next.siblings === run.siblings` — reference equality is correct, `selectionSiblingRuns` stores the same array) or the end of the sibling list. The UI's block selection is always a contiguous visible range, so split runs within one sibling group are unreachable today — the gap-bounding is defensive pure-function semantics, and its test asserts ops + parent/child shape only (relative top-level ordering of same-parent runs is a pre-existing quirk out of scope here).

- [ ] **Step 1: Write the failing tests**

Add the `gapTree` fixture after `mixedOutdentTree` (edits.test.ts line 158):

```ts
const gapTree = () => [
  block("top", "top parent", {
    order_idx: 0,
    children: [
      block("s1", "one", { order_idx: 0 }),
      block("s2", "two", { order_idx: 1 }),
      block("s3", "three", { order_idx: 2 }),
      block("s4", "four", { order_idx: 3 }),
      block("s5", "five", { order_idx: 4 }),
    ],
  }),
];
```

Add these three tests inside the `"indentSelection / outdentSelection (pkm-0ovd)"`
describe, after the test `"outdents mixed-level roots once while preserving
their subtrees"` (line 242):

```ts
  test("a run adopts trailing siblings under its last block", () => {
    const r = outdentSelection(gapTree(), P, ["s1", "s2"]);
    expect(r.ops).toEqual([
      { op: "move", uid: "s1", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "s2", parent_uid: null, order_idx: 2 },
      { op: "move", uid: "s3", parent_uid: "s2", order_idx: 0 },
      { op: "move", uid: "s4", parent_uid: "s2", order_idx: 1 },
      { op: "move", uid: "s5", parent_uid: "s2", order_idx: 2 },
    ]);
    expect(r.blocks.map((n) => n.uid)).toEqual(["top", "s1", "s2"]);
    expect(findNode(r.blocks, "s2")!.children.map((n) => n.uid))
      .toEqual(["s3", "s4", "s5"]);
    expect(findNode(r.blocks, "top")!.children).toEqual([]);
  });

  test("split runs in one sibling group each adopt only their gap", () => {
    const r = outdentSelection(gapTree(), P, ["s2", "s4"]);
    expect(r.ops).toEqual([
      { op: "move", uid: "s2", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "s3", parent_uid: "s2", order_idx: 0 },
      { op: "move", uid: "s4", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "s5", parent_uid: "s4", order_idx: 0 },
    ]);
    expect(findNode(r.blocks, "s2")!.children.map((n) => n.uid))
      .toEqual(["s3"]);
    expect(findNode(r.blocks, "s4")!.children.map((n) => n.uid))
      .toEqual(["s5"]);
  });

  test("a collapsed run tail expands when it adopts", () => {
    const t = gapTree();
    findNode(t, "s2")!.collapsed = true;
    const r = outdentSelection(t, P, ["s1", "s2"]);
    expect(r.ops).toEqual([
      { op: "move", uid: "s1", parent_uid: null, order_idx: 1 },
      { op: "move", uid: "s2", parent_uid: null, order_idx: 2 },
      { op: "set_collapsed", uid: "s2", collapsed: false },
      { op: "move", uid: "s3", parent_uid: "s2", order_idx: 0 },
      { op: "move", uid: "s4", parent_uid: "s2", order_idx: 1 },
      { op: "move", uid: "s5", parent_uid: "s2", order_idx: 2 },
    ]);
  });
```

The existing selection tests must keep passing unchanged: in
`"outdents one sibling run consecutively after its former parent"` the run is
ALL of `a`'s children, and in the mixed-level test both `x` and `q` are last
children — no trailing siblings anywhere, so no adoption ops.

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd web && pnpm test:unit -- src/outline/edits.test.ts`
Expected: the three new tests FAIL (missing adoption ops); everything else
PASSES.

- [ ] **Step 3: Implement per-run adoption**

Replace `outdentSelection` (edits.ts lines 165-190, including its doc comment)
with:

```ts
/** Outdent every selected root exactly once. A top-level run aborts the whole
 * gesture; otherwise each run lands consecutively after its former parent and
 * adopts the unselected siblings between it and the next run (or the end of
 * its sibling list) as children of its last block (pkm-udqj). */
export function outdentSelection(blocks: BlockNode[], pageTitle: string,
                                 uids: string[]): EditResult {
  const runs = selectionSiblingRuns(blocks, uids);
  if (!runs || runs.length === 0
      || runs.some((run) => run.parent === null)) {
    return noop(blocks);
  }
  const ops: BlockOp[] = [];
  for (const [i, run] of runs.entries()) {
    if (!run.parent) return noop(blocks);
    const parentLoc = locate(blocks, run.parent.uid);
    if (!parentLoc) return noop(blocks);
    ops.push(...groupMoveOps(run.uids, parentLoc.parent?.uid ?? null,
                             idxAfter(parentLoc.siblings, parentLoc.index)));
    const end = run.first + run.uids.length;
    const next = runs[i + 1];
    ops.push(...adoptTrailingOps(
      run.siblings[end - 1], run.siblings, end,
      next && next.siblings === run.siblings ? next.first
                                             : run.siblings.length));
  }
  return done(blocks, pageTitle, ops, null);
}
```

Note this drops the intermediate `plans` array: it existed to derive all
destinations from the original tree before emitting ops, and the single loop
preserves that property because nothing is applied until `done()` — every
read (`locate`, `idxAfter`, `adoptTrailingOps`) still sees the original tree.
The mid-loop `return noop(blocks)` is safe for the same reason: `ops` is a
local array and `blocks` is untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm test:unit -- src/outline/edits.test.ts`
Expected: ALL tests PASS.

- [ ] **Step 5: Update the bean checklist and commit**

Tick the Task 2 item in `.beans/pkm-udqj--outdent-reparents-following-siblings.md`.

```bash
git status -sb   # must show worktree-outdent-reparents-siblings
git add web/src/outline/edits.ts web/src/outline/edits.test.ts .beans/
git commit -m "pkm-udqj: outdentSelection adopts each run's gap siblings"
```

---

### Task 3: Docs, full verification, bean completion

**Files:**
- Modify: `docs/keyboard.md:66` and `docs/keyboard.md:130`
- Modify: `.beans/pkm-udqj--outdent-reparents-following-siblings.md`

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1-2.
- Produces: nothing downstream; this closes the bean.

- [ ] **Step 1: Update keyboard.md**

Line 66 currently reads:

```
| Tab / Shift+Tab | Indent / outdent |
```

Change to:

```
| Tab / Shift+Tab | Indent / outdent (outdent takes the following siblings along as its children) |
```

Line 130 currently reads:

```
| Tab / Shift+Tab | Indent / outdent all selected blocks together |
```

Change to:

```
| Tab / Shift+Tab | Indent / outdent all selected blocks together (outdent takes the trailing siblings along under the last selected block) |
```

Do NOT edit `docs/architecture/` — frontend.md only mentions outdent for
read-only gating, which is unchanged. (If you believe an architecture doc
edit is needed, invoke the `architecture-docs` skill first per CLAUDE.md.)

- [ ] **Step 2: Run full web verification**

Run: `cd web && CI=true pnpm verify`
Expected: typecheck, unit tests with enforced coverage, and Playwright E2E
all pass. The existing e2e Shift+Tab uses outdent last children (no trailing
siblings), so no e2e edits are expected; if one fails, read the failure
before touching anything — do not loosen assertions to make it pass.

- [ ] **Step 3: Complete the bean and commit**

In `.beans/pkm-udqj--outdent-reparents-following-siblings.md`: tick the Task 3
item, add a `## Summary of Changes` section describing what shipped, and set
the bean to completed:

```bash
beans update pkm-udqj -s completed
git status -sb   # must show worktree-outdent-reparents-siblings
git add docs/keyboard.md .beans/
git commit -m "pkm-udqj: document outdent adoption in keyboard.md; complete bean"
```

---

## Verification checklist (whole branch, before merge)

- `cd web && pnpm typecheck` — clean
- `cd web && pnpm test:unit` — all pass with enforced coverage
- `cd web && CI=true pnpm verify` — full suite including Playwright
- No server files touched (`git diff main --stat` shows only `web/src/outline/edits.ts`, `web/src/outline/edits.test.ts`, `docs/keyboard.md`, `docs/superpowers/`, `.beans/`)
