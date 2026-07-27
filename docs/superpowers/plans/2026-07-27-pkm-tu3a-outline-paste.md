# Hierarchy-Preserving Outline Paste Implementation Plan (pkm-tu3a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-line pastes into a block become real blocks whose parent/child structure mirrors the clipboard's indentation, and multi-block copy emits tab indentation so copy → paste round-trips hierarchy.

**Architecture:** A new Functional Core module `web/src/outline/paste.ts` parses clipboard text into a forest (`parseOutlineForest`) and plans the complete op batch (`planOutlinePaste`) returning the standard `EditResult`. The Imperative Shell intercepts text pastes in `BlockInput.onPaste` (`EditableBlockTree.tsx`) and dispatches a new `OutlineHandlers.onPasteOutline`, which `useOutline` runs through the existing `run()` pipeline (flush draft → plan → optimistic apply → one enqueued batch → one undo entry). `selectionText` in `blockSelection.ts` gains relative-depth tabs.

**Tech Stack:** React 18 + TypeScript, Vitest + Testing Library, Playwright e2e. Spec: `docs/superpowers/specs/2026-07-27-pkm-tu3a-outline-paste-design.md` (read it first).

## Global Constraints

- Run everything from the worktree root `/Users/arthur/code/llm/pkm/.claude/worktrees/pkm-tu3a-outline-paste` — NEVER from the main checkout `/Users/arthur/code/llm/pkm`. Check `git status -sb` shows branch `worktree-pkm-tu3a-outline-paste` before every commit.
- New pure files declare `// pattern: Functional Core` on line 1; shell files already carry their pattern comment — don't change it.
- `order_idx` values are always read off the tree (`order_idx` fields), never array positions; create ops use insert-before-the-block-currently-at-`order_idx` semantics (`applyOps`/`shiftFrom` in `web/src/outline/tree.ts:80-116`).
- TDD: write the failing test, see it fail, implement, see it pass, commit. Include the bean file `.beans/pkm-tu3a--preserve-block-hierarchy-when-pasting-outlines.md` checklist updates in commits when a checklist item completes.
- Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LFdRDKy283w7wJMx37RWoY`

---

### Task 1: Clipboard forest parser (`parseOutlineForest`, `isOutlinePaste`)

**Files:**
- Create: `web/src/outline/paste.ts`
- Create: `web/src/outline/paste.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Tasks 2 and 4 rely on these exact signatures):
  - `export interface PastedNode { text: string; children: PastedNode[] }`
  - `export function parseOutlineForest(text: string): PastedNode[]`
  - `export function isOutlinePaste(text: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `web/src/outline/paste.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isOutlinePaste, parseOutlineForest } from "./paste";

const node = (text: string, children: ReturnType<typeof node>[] = []) =>
  ({ text, children });

describe("parseOutlineForest", () => {
  it("tab indentation nests children under the previous shallower line", () => {
    expect(parseOutlineForest("a\n\tb\n\t\tc\n\td\ne")).toEqual([
      node("a", [node("b", [node("c")]), node("d")]),
      node("e"),
    ]);
  });

  it("2-space and 4-space indents both work without configuration", () => {
    expect(parseOutlineForest("a\n  b\n    c")).toEqual([
      node("a", [node("b", [node("c")])]),
    ]);
    expect(parseOutlineForest("a\n    b\n        c")).toEqual([
      node("a", [node("b", [node("c")])]),
    ]);
  });

  it("mixed tab and space indents compare by column width (tab = 4)", () => {
    // "\t" (4 cols) deeper than "  " (2 cols)
    expect(parseOutlineForest("a\n  b\n\tc")).toEqual([
      node("a", [node("b", [node("c")])]),
    ]);
  });

  it("equal widths are siblings; dedent returns to the matching level", () => {
    expect(parseOutlineForest("a\n\tb\n\tc\nd")).toEqual([
      node("a", [node("b"), node("c")]),
      node("d"),
    ]);
  });

  it("an over-indent jump of any size is exactly one level deeper", () => {
    expect(parseOutlineForest("a\n\t\t\tb\n\tc")).toEqual([
      node("a", [node("b"), node("c")]),
    ]);
  });

  it("a dedent to a never-seen width becomes a sibling of the nearest shallower level", () => {
    // widths 0, 4; then 2 pops the 4-level and lands under the 0-level
    expect(parseOutlineForest("a\n    b\n  c")).toEqual([
      node("a", [node("b"), node("c")]),
    ]);
  });

  it("a uniformly indented clipboard still starts at depth 0", () => {
    expect(parseOutlineForest("\t\ta\n\t\t\tb")).toEqual([
      node("a", [node("b")]),
    ]);
  });

  it("blank lines never create blocks", () => {
    expect(parseOutlineForest("a\n\n   \n\tb")).toEqual([
      node("a", [node("b")]),
    ]);
  });

  it("CRLF and CR normalize to LF", () => {
    expect(parseOutlineForest("a\r\n\tb\rc")).toEqual([
      node("a", [node("b")]), node("c"),
    ]);
  });

  it("strips - * + bullets only when every line has one", () => {
    expect(parseOutlineForest("- a\n\t* b\n\t+ c")).toEqual([
      node("a", [node("b"), node("c")]),
    ]);
    // one bulletless line -> everything verbatim
    expect(parseOutlineForest("- a\nplain")).toEqual([
      node("- a"), node("plain"),
    ]);
  });

  it("numbered lists paste literally", () => {
    expect(parseOutlineForest("1. a\n2. b")).toEqual([
      node("1. a"), node("2. b"),
    ]);
  });

  it("keeps inline content verbatim", () => {
    expect(parseOutlineForest("x [[Ref]] #tag\n\t{{[[TODO]]}} y")).toEqual([
      node("x [[Ref]] #tag", [node("{{[[TODO]]}} y")]),
    ]);
  });

  it("returns [] for empty or blank-only text", () => {
    expect(parseOutlineForest("")).toEqual([]);
    expect(parseOutlineForest(" \n\t\n")).toEqual([]);
  });
});

describe("isOutlinePaste", () => {
  it("true for multi-line text (including a single line with trailing newline)", () => {
    expect(isOutlinePaste("a\nb")).toBe(true);
    expect(isOutlinePaste("a\n")).toBe(true);
    expect(isOutlinePaste("a\r\nb")).toBe(true);
  });

  it("false for single-line or blank-only text", () => {
    expect(isOutlinePaste("just one line")).toBe(false);
    expect(isOutlinePaste("")).toBe(false);
    expect(isOutlinePaste("\n \n")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && pnpm vitest run src/outline/paste.test.ts`
Expected: FAIL — cannot resolve `./paste`.

- [ ] **Step 3: Implement the parser**

Create `web/src/outline/paste.ts`:

```ts
// pattern: Functional Core
// Hierarchy-preserving outline paste (pkm-tu3a): parse clipboard text into a
// forest by indentation, then plan the exact op batch that anchors it at the
// paste location. Indent widths are compared ordinally with an indent stack,
// so 2-space, 4-space, and tab clipboards all work without configuration; an
// over-indent jump of any size is exactly one level (malformed input clamps,
// never throws).

export interface PastedNode {
  text: string;
  children: PastedNode[];
}

const TAB_WIDTH = 4; // only matters when one clipboard mixes tabs and spaces

const BULLET_RE = /^[-*+] /;

interface MeasuredLine {
  width: number; // leading whitespace as columns, tabs expanded
  rest: string;  // the line after its indent
}

function measure(line: string): MeasuredLine {
  let width = 0;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === "\t") width += TAB_WIDTH;
    else if (line[i] === " ") width += 1;
    else break;
  }
  return { width, rest: line.slice(i) };
}

/** Clipboard text -> forest. Blank lines vanish; bullets are stripped only
 * when EVERY non-blank line carries one (a consistent markdown list), so
 * prose with one leading dash stays verbatim. */
export function parseOutlineForest(text: string): PastedNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
    .filter((line) => line.trim() !== "")
    .map(measure);
  if (lines.length === 0) return [];
  const stripBullets = lines.every((l) => BULLET_RE.test(l.rest));
  const roots: PastedNode[] = [];
  // Open ancestors with the width that opened each level. Pop everything at
  // or deeper than the current width: equal = sibling, between-levels =
  // sibling of the nearest shallower level (clamp), deeper = child.
  const stack: { width: number; node: PastedNode }[] = [];
  for (const { width, rest } of lines) {
    const node: PastedNode = {
      text: stripBullets ? rest.replace(BULLET_RE, "") : rest,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].width >= width) {
      stack.pop();
    }
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ width, node });
  }
  return roots;
}

/** Whether onPaste should intercept: multi-line text that parses to at least
 * one node. Single-line and blank-only pastes keep the native splice. */
export function isOutlinePaste(text: string): boolean {
  return text.replace(/\r\n?/g, "\n").includes("\n")
    && parseOutlineForest(text).length > 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/outline/paste.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add web/src/outline/paste.ts web/src/outline/paste.test.ts
git commit -m "feat(pkm-tu3a): parse clipboard outlines into a forest"
```

---

### Task 2: Paste planner (`planOutlinePaste`)

**Files:**
- Modify: `web/src/outline/edits.ts:40-45` (export the private `idxAfter` helper)
- Modify: `web/src/outline/paste.ts`
- Test: `web/src/outline/paste.test.ts`

**Interfaces:**
- Consumes: `parseOutlineForest`/`PastedNode` (Task 1); `EditResult`, `clampCaret`, `idxAfter` from `./edits`; `applyOps`, `locate` from `./tree`; `BlockOp` from `../api/ops`; `BlockNode` from `../api/payloads`.
- Produces (Task 4 relies on this exact signature):
  - `export function planOutlinePaste(blocks: BlockNode[], pageTitle: string, uid: string, selStart: number, selEnd: number, text: string, newUid: () => string): EditResult`

- [ ] **Step 1: Export `idxAfter` from edits.ts**

In `web/src/outline/edits.ts`, change the existing private helper (around line 42) to exported, updating nothing else:

```ts
/** order_idx that inserts immediately after siblings[index]: the next
 * sibling's order_idx (insert before it), or last + 1. */
export function idxAfter(siblings: BlockNode[], index: number): number {
  const next = siblings[index + 1];
  return next ? next.order_idx : siblings[index].order_idx + 1;
}
```

- [ ] **Step 2: Write the failing planner tests**

Append to `web/src/outline/paste.test.ts` (the `block` helper is `web/src/test-helpers.tsx`'s block factory, used across outline tests):

```ts
import { block } from "../test-helpers";
import { planOutlinePaste } from "./paste";

function uidGen() {
  let n = 0;
  return () => `n${++n}`;
}

const PAGE = "Page";

describe("planOutlinePaste", () => {
  it("splices the first root at the caret and creates the rest as siblings", () => {
    const blocks = [
      block("a", "hello world", { order_idx: 0 }),
      block("z", "after", { order_idx: 1 }),
    ];
    const r = planOutlinePaste(blocks, PAGE, "a", 5, 5, "X\nY\nZ", uidGen());
    expect(r.ops).toEqual([
      { op: "update_text", uid: "a", text: "helloX world" },
      { op: "create", uid: "n1", page_title: PAGE, parent_uid: null,
        order_idx: 1, text: "Y" },
      { op: "create", uid: "n2", page_title: PAGE, parent_uid: null,
        order_idx: 2, text: "Z" },
    ]);
    // applyOps mirror: a, Y, Z, after in order
    expect(r.blocks.map((b) => b.text)).toEqual(
      ["helloX world", "Y", "Z", "after"]);
    expect(r.focus).toEqual({ uid: "n2", cursor: 1 });
  });

  it("replaces a text selection with the first root's text", () => {
    const blocks = [block("a", "abcdef", { order_idx: 0 })];
    const r = planOutlinePaste(blocks, PAGE, "a", 1, 4, "XY\nrest", uidGen());
    expect(r.ops[0]).toEqual({ op: "update_text", uid: "a", text: "aXYef" });
  });

  it("nests pasted children under their pasted parents (depth-first creates)", () => {
    const blocks = [block("a", "", { order_idx: 0 })];
    const r = planOutlinePaste(blocks, PAGE, "a", 0, 0,
                               "top\nnext\n\tchild\n\t\tgrand", uidGen());
    expect(r.ops).toEqual([
      { op: "update_text", uid: "a", text: "top" },
      { op: "create", uid: "n1", page_title: PAGE, parent_uid: null,
        order_idx: 1, text: "next" },
      { op: "create", uid: "n2", page_title: PAGE, parent_uid: "n1",
        order_idx: 0, text: "child" },
      { op: "create", uid: "n3", page_title: PAGE, parent_uid: "n2",
        order_idx: 0, text: "grand" },
    ]);
    expect(r.focus).toEqual({ uid: "n3", cursor: "grand".length });
  });

  it("the first root's children become the target's FIRST children", () => {
    const blocks = [
      block("a", "parent", {
        order_idx: 0,
        children: [block("a0", "existing", { order_idx: 4 })],
      }),
    ];
    const r = planOutlinePaste(blocks, PAGE, "a", 6, 6, "!\n\tk1\n\tk2",
                               uidGen());
    expect(r.ops).toEqual([
      { op: "update_text", uid: "a", text: "parent!" },
      { op: "create", uid: "n1", page_title: PAGE, parent_uid: "a",
        order_idx: 4, text: "k1" },
      { op: "create", uid: "n2", page_title: PAGE, parent_uid: "a",
        order_idx: 5, text: "k2" },
    ]);
    const a = r.blocks[0];
    expect(a.children.map((c) => c.text)).toEqual(["k1", "k2", "existing"]);
  });

  it("expands a collapsed target that receives children", () => {
    const blocks = [
      block("a", "p", {
        order_idx: 0, collapsed: true,
        children: [block("a0", "hidden", { order_idx: 0 })],
      }),
    ];
    // first root "!" carries a child, so the collapsed target must expand
    const r = planOutlinePaste(blocks, PAGE, "a", 1, 1, "!\n\tkid", uidGen());
    expect(r.ops[0]).toEqual({ op: "update_text", uid: "a", text: "p!" });
    expect(r.ops).toContainEqual({ op: "set_collapsed", uid: "a",
                                   collapsed: false });
  });

  it("sibling roots insert between the target and its next sibling", () => {
    const blocks = [
      block("p", "P", {
        order_idx: 0,
        children: [
          block("p0", "first", { order_idx: 2 }),
          block("p1", "second", { order_idx: 7 }),
        ],
      }),
    ];
    const r = planOutlinePaste(blocks, PAGE, "p0", 0, 5, "first\nmid",
                               uidGen());
    // splice replaces "first" with "first": no update_text op is emitted
    expect(r.ops).toEqual([
      { op: "create", uid: "n1", page_title: PAGE, parent_uid: "p",
        order_idx: 7, text: "mid" },
    ]);
    expect(r.blocks[0].children.map((c) => c.text))
      .toEqual(["first", "mid", "second"]);
  });

  it("single root with no children: splice only, focus after the pasted text", () => {
    const blocks = [block("a", "ab", { order_idx: 0 })];
    const r = planOutlinePaste(blocks, PAGE, "a", 1, 1, "XY\n", uidGen());
    expect(r.ops).toEqual([{ op: "update_text", uid: "a", text: "aXYb" }]);
    expect(r.focus).toEqual({ uid: "a", cursor: 3 });
  });

  it("clamps out-of-range caret offsets", () => {
    const blocks = [block("a", "ab", { order_idx: 0 })];
    const r = planOutlinePaste(blocks, PAGE, "a", 99, 99, "X\nY", uidGen());
    expect(r.ops[0]).toEqual({ op: "update_text", uid: "a", text: "abX" });
  });

  it("no-ops on a missing uid or an empty parse", () => {
    const blocks = [block("a", "ab", { order_idx: 0 })];
    expect(planOutlinePaste(blocks, PAGE, "gone", 0, 0, "x\ny", uidGen()).ops)
      .toEqual([]);
    expect(planOutlinePaste(blocks, PAGE, "a", 0, 0, " \n ", uidGen()).ops)
      .toEqual([]);
  });
});
```

Careful with clipboards whose first line is blank (e.g. `"\nmid"`): the
parser drops blank lines, so the next line becomes the FIRST root and
splices into the target — always choose test clipboards whose first line is
the intended first root.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && pnpm vitest run src/outline/paste.test.ts`
Expected: FAIL — `planOutlinePaste` not exported.

- [ ] **Step 4: Implement the planner**

Append to `web/src/outline/paste.ts`:

```ts
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import { clampCaret, idxAfter, type EditResult, type FocusTarget } from "./edits";
import { applyOps, locate } from "./tree";

/** Anchor a parsed clipboard forest at the paste location. The first root's
 * text splices into the target block at [selStart, selEnd); the first root's
 * children become the target's FIRST children (expanding a collapsed
 * target); remaining roots become siblings immediately after the target.
 * Creates are emitted depth-first so every parent exists before its
 * children; consecutive-sibling order_idx values rely on applyOps's
 * insert-before shift, exactly like splitBlock. */
export function planOutlinePaste(
  blocks: BlockNode[], pageTitle: string, uid: string,
  selStart: number, selEnd: number, text: string,
  newUid: () => string,
): EditResult {
  const forest = parseOutlineForest(text);
  const found = locate(blocks, uid);
  if (!found || forest.length === 0) return { blocks, ops: [], focus: null };
  const { node, parent, siblings, index } = found;
  const [first, ...rest] = forest;

  const start = clampCaret(selStart, node.text.length);
  const end = Math.max(start, clampCaret(selEnd, node.text.length));
  const spliced = node.text.slice(0, start) + first.text + node.text.slice(end);

  const ops: BlockOp[] = [];
  if (spliced !== node.text) ops.push({ op: "update_text", uid, text: spliced });
  if (first.children.length > 0 && node.collapsed) {
    ops.push({ op: "set_collapsed", uid, collapsed: false });
  }

  let focus: FocusTarget = { uid, cursor: start + first.text.length };
  const createSubtree = (n: PastedNode, parentUid: string | null,
                         orderIdx: number): void => {
    const createdUid = newUid();
    ops.push({ op: "create", uid: createdUid, page_title: pageTitle,
               parent_uid: parentUid, order_idx: orderIdx, text: n.text });
    focus = { uid: createdUid, cursor: n.text.length };
    n.children.forEach((child, i) => createSubtree(child, createdUid, i));
  };

  const childBase = node.children[0]?.order_idx ?? 0;
  first.children.forEach((child, i) => createSubtree(child, uid, childBase + i));
  const rootBase = idxAfter(siblings, index);
  rest.forEach((root, i) => createSubtree(root, parent?.uid ?? null,
                                          rootBase + i));

  if (ops.length === 0) return { blocks, ops: [], focus: null };
  return { blocks: applyOps(blocks, ops, pageTitle), ops, focus };
}
```

Move the `import` lines to the top of the file with the existing imports (ESLint/tsc require imports first).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/outline/paste.test.ts src/outline/edits.test.ts`
Expected: PASS (planner cases + no regression from exporting `idxAfter`).

- [ ] **Step 6: Commit**

```bash
git add web/src/outline/paste.ts web/src/outline/paste.test.ts web/src/outline/edits.ts
git commit -m "feat(pkm-tu3a): plan hierarchy-preserving paste op batches"
```

---

### Task 3: Copy emits tab indentation (`selectionText`)

**Files:**
- Modify: `web/src/outline/blockSelection.ts:37-43`
- Test: `web/src/outline/blockSelection.test.ts:100-107`

**Interfaces:**
- Consumes: existing `selectedUids`, `findNode`; adds a depth walk over `BlockNode[]`.
- Produces: `selectionText` keeps its exact signature `(blocks: BlockNode[], sel: BlockSelection): string` — only the return value gains tabs. The caller (`EditableBlockTree.tsx:162`) needs no change.

- [ ] **Step 1: Update the tests (write failing)**

In `web/src/outline/blockSelection.test.ts`, extend the fixture with a nested run and replace the `selectionText` describe block:

```ts
// add below BLOCKS:
const NESTED = [
  block("r", "root", {
    order_idx: 0,
    children: [
      block("r0", "child", {
        order_idx: 0,
        children: [block("r00", "grand", { order_idx: 0 })],
      }),
    ],
  }),
  block("s", "sibling", { order_idx: 1 }),
];

describe("selectionText", () => {
  it("joins the selected blocks' text with newlines in document order", () => {
    expect(selectionText(BLOCKS, { anchor: "a", head: "c" })).toBe("one\ntwo\nthree");
  });

  it("orders by the document even when head precedes anchor", () => {
    expect(selectionText(BLOCKS, { anchor: "c", head: "a" })).toBe("one\ntwo\nthree");
  });

  it("indents by depth relative to the shallowest selected block (pkm-tu3a)", () => {
    expect(selectionText(NESTED, { anchor: "r", head: "s" }))
      .toBe("root\n\tchild\n\t\tgrand\nsibling");
    // selection entirely below the top level re-bases at zero tabs
    expect(selectionText(NESTED, { anchor: "r0", head: "r00" }))
      .toBe("child\n\tgrand");
  });
});
```

- [ ] **Step 2: Run to verify the new case fails**

Run: `cd web && pnpm vitest run src/outline/blockSelection.test.ts`
Expected: FAIL on the new indentation case only.

- [ ] **Step 3: Implement**

Replace `selectionText` in `web/src/outline/blockSelection.ts`:

```ts
/** The selected blocks' text joined with newlines in document order, each
 * line indented with one tab per depth level relative to the shallowest
 * selected block (pkm-tu3a) — what lands on the clipboard when the selection
 * is copied, and what parseOutlineForest round-trips back into structure. */
export function selectionText(blocks: BlockNode[], sel: BlockSelection): string {
  const uids = selectedUids(blocks, sel);
  const depths = new Map<string, number>();
  const walk = (nodes: BlockNode[], depth: number): void => {
    for (const n of nodes) {
      depths.set(n.uid, depth);
      walk(n.children, depth + 1);
    }
  };
  walk(blocks, 0);
  const base = Math.min(...uids.map((uid) => depths.get(uid) ?? 0));
  return uids
    .map((uid) => "\t".repeat((depths.get(uid) ?? base) - base)
      + (findNode(blocks, uid)?.text ?? ""))
    .join("\n");
}
```

(`Math.min()` of an empty array is `Infinity`, but `uids.map` on an empty selection produces `[]` and the final `join` of `[]` is `""` — same as today.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/outline/blockSelection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/outline/blockSelection.ts web/src/outline/blockSelection.test.ts
git commit -m "feat(pkm-tu3a): copy multi-block selections with tab indentation"
```

---

### Task 4: Shell wiring — `onPasteOutline` through BlockInput and useOutline

**Files:**
- Modify: `web/src/components/EditableBlockTree.tsx` (OutlineHandlers interface ~line 56; `BlockInput.onPaste` ~line 685)
- Modify: `web/src/outline/useOutline.ts` (handlers memo, after `onFiles`)
- Test: `web/src/components/EditableBlockTree.test.tsx`
- Create: `web/src/outline/useOutline.paste.test.tsx`

**Interfaces:**
- Consumes: `isOutlinePaste`, `planOutlinePaste` (Tasks 1–2); existing `run`, `newUid`.
- Produces: `OutlineHandlers.onPasteOutline(uid: string, selStart: number, selEnd: number, text: string): void`

- [ ] **Step 1: Write the failing component tests**

Append to `web/src/components/EditableBlockTree.test.tsx` (its `handlers()` factory must gain `onPasteOutline: vi.fn(),` — add it next to `onFiles`):

```ts
test("multi-line text paste dispatches onPasteOutline with the caret range", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const ta = focusedTextarea();
  ta.setSelectionRange(2, 5);
  const prevented = !fireEvent.paste(ta, {
    clipboardData: { files: [], getData: () => "a\n\tb" },
  });
  expect(prevented).toBe(true); // preventDefault: we own the paste
  expect(h.onPasteOutline).toHaveBeenCalledWith("u1", 2, 5, "a\n\tb");
});

test("single-line paste keeps the native textarea behaviour", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const prevented = !fireEvent.paste(focusedTextarea(), {
    clipboardData: { files: [], getData: () => "one line" },
  });
  expect(prevented).toBe(false);
  expect(h.onPasteOutline).not.toHaveBeenCalled();
});

test("file paste still routes to onFiles, never onPasteOutline", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 });
  const file = new File(["x"], "x.png", { type: "image/png" });
  fireEvent.paste(focusedTextarea(), {
    clipboardData: { files: [file], getData: () => "a\nb" },
  });
  expect(h.onFiles).toHaveBeenCalled();
  expect(h.onPasteOutline).not.toHaveBeenCalled();
});

test("read-only outlines do not intercept text pastes", () => {
  const h = handlers();
  mount(h, { uid: "u1", cursor: 0 }, true);
  fireEvent.paste(focusedTextarea(), {
    clipboardData: { files: [], getData: () => "a\nb" },
  });
  expect(h.onPasteOutline).not.toHaveBeenCalled();
});
```

Check how the read-only tree renders a "focused" textarea before relying on
`focusedTextarea()` in the read-only case (the `readOnly blocks structural
keys` test at line 265 shows the working pattern — mirror it). If read-only
blocks render no textarea, assert on the tree container instead or drop that
DOM detail and keep the handler-not-called assertion via the editable path
with `readOnly=true` mount, matching the existing test's approach.

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && pnpm vitest run src/components/EditableBlockTree.test.tsx`
Expected: the new tests FAIL (`onPasteOutline` missing from the interface →
type error counts as failure; add the interface member first if tsc blocks
the run, then the behavioural assertions fail).

- [ ] **Step 3: Implement the component side**

In `web/src/components/EditableBlockTree.tsx`:

1. Add to `OutlineHandlers` (next to `onFiles`, ~line 56):

```ts
  /** Multi-line text paste (pkm-tu3a): parse outline indentation into real
   * blocks anchored at the caret. Single-line pastes stay native. */
  onPasteOutline(uid: string, selStart: number, selEnd: number,
                 text: string): void;
```

2. Import `isOutlinePaste` from `../outline/paste` and extend `onPaste`
   (~line 685):

```ts
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (readOnly) return;
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      handlers.onFiles(node.uid, e.currentTarget.selectionStart, files);
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    if (!isOutlinePaste(text)) return; // native splice for single lines
    e.preventDefault();
    handlers.onPasteOutline(node.uid, e.currentTarget.selectionStart,
                            e.currentTarget.selectionEnd, text);
  };
```

Note this restructures the existing file branch: today's code returns early
when `files.length === 0 || readOnly`. Preserve the existing file behaviour
exactly (readOnly file pastes must stay inert, as before).

3. Update the `handlers()` factory in `EditableBlockTree.test.tsx` and any
   other `OutlineHandlers` literal that now fails typecheck:
   `grep -rn "onFiles: vi.fn()" web/src` to find them all; add
   `onPasteOutline: vi.fn(),` beside each.

- [ ] **Step 4: Run to verify component tests pass**

Run: `cd web && pnpm vitest run src/components/EditableBlockTree.test.tsx && pnpm typecheck`
Expected: PASS, no type errors anywhere.

- [ ] **Step 5: Write the failing hook test**

Create `web/src/outline/useOutline.paste.test.tsx` (harness copied from
`useOutline.selection.test.tsx:1-30` — same `Harness`/`setup`/`block`
imports):

```tsx
// pkm-tu3a: onPasteOutline is the imperative half of planOutlinePaste — one
// flushed, optimistic, synced, undoable batch per paste gesture.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { expect, it, vi } from "vitest";
import type { BlockNode } from "../api/payloads";
import { SyncContext } from "../sync/SyncProvider";
import { block, makeSync, type SyncFake } from "../test-helpers";
import { useOutline, type Outline } from "./useOutline";

vi.mock("../uid", () => {
  let n = 0;
  return { newUid: () => `n${++n}` };
});

function Harness({ pageTitle, initial, onReady }: {
  pageTitle: string;
  initial: BlockNode[];
  onReady: (o: Outline) => void;
}) {
  const outline = useOutline(pageTitle, initial);
  useEffect(() => onReady(outline));
  return null;
}

function setup(sync: SyncFake, pageTitle: string, initial: BlockNode[]) {
  let outline!: Outline;
  render(
    <SyncContext.Provider value={sync}>
      <Harness pageTitle={pageTitle} initial={initial}
               onReady={(o) => { outline = o; }} />
    </SyncContext.Provider>);
  return () => outline;
}

it("onPasteOutline enqueues one batch and focuses the last pasted block", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [
    block("a", "seed", { order_idx: 0 }),
  ]);

  act(() => getOutline().handlers.onPasteOutline("a", 4, 4, "!\nnext\n\tkid"));

  expect(sync.sent).toEqual([[
    { op: "update_text", uid: "a", text: "seed!" },
    { op: "create", uid: expect.any(String), page_title: "Page",
      parent_uid: null, order_idx: 1, text: "next" },
    { op: "create", uid: expect.any(String), page_title: "Page",
      parent_uid: expect.any(String), order_idx: 0, text: "kid" },
  ]]);
  const [, createNext, createKid] = sync.sent[0] as
    [unknown, { uid: string }, { parent_uid: string; uid: string }];
  expect(createKid.parent_uid).toBe(createNext.uid);
  expect(getOutline().blocks.map((b) => b.text)).toEqual(["seed!", "next"]);
  expect(getOutline().blocks[1].children.map((b) => b.text)).toEqual(["kid"]);
  expect(getOutline().focus).toEqual({ uid: createKid.uid,
                                       cursor: "kid".length });
});

it("a paste that plans nothing enqueues nothing", () => {
  const sync = makeSync();
  const getOutline = setup(sync, "Page", [
    block("a", "seed", { order_idx: 0 }),
  ]);
  act(() => getOutline().handlers.onPasteOutline("gone", 0, 0, "x\ny"));
  expect(sync.sent).toEqual([]);
});
```

Check `web/src/test-helpers.tsx` for whether `makeSync().sent` is the enqueued
batch list (the selection tests at `useOutline.selection.test.tsx:68-71` use
exactly this shape). If the real `newUid` module path differs (`../uid`
re-exports from `uidCore`), keep the `vi.mock("../uid", ...)` — that is the
specifier `useOutline.ts:17` imports. If a different existing test already
mocks uids another way, mirror that instead; `expect.any(String)` keeps the
test robust either way.

- [ ] **Step 6: Implement the hook side**

In `web/src/outline/useOutline.ts`:

1. Import: add `planOutlinePaste` from `"./paste"`.
2. Add to the `handlers` memo, right after `onFiles`:

```ts
    // Multi-line text paste (pkm-tu3a): one planned batch through run() —
    // flushed draft, optimistic apply, single server batch, single undo entry.
    onPasteOutline: (uid, selStart, selEnd, text) =>
      run((b) => planOutlinePaste(b, pageTitle, uid, selStart, selEnd, text,
                                  newUid)),
```

- [ ] **Step 7: Run the full unit suite and typecheck**

Run: `cd web && pnpm vitest run && pnpm typecheck`
Expected: PASS — including every `OutlineHandlers` literal across tests
(EditablePage, Journal, etc. may construct handler objects; typecheck
finds any you missed in Step 3.3).

- [ ] **Step 8: Commit**

```bash
git add web/src/components/EditableBlockTree.tsx web/src/components/EditableBlockTree.test.tsx web/src/outline/useOutline.ts web/src/outline/useOutline.paste.test.tsx
git commit -m "feat(pkm-tu3a): wire outline paste through BlockInput and useOutline"
```

---

### Task 5: End-to-end paste coverage

**Files:**
- Create: `web/e2e/paste.spec.ts`

**Interfaces:**
- Consumes: the running app only. Model files: `web/e2e/edit.spec.ts`
  (login/input/caretToEnd helpers), `web/e2e/rename.spec.ts` (unique-page
  pattern), `web/e2e/server-state.ts` (`waitForServerText`).

**Constraints (from session memory):**
- E2E must NOT write today's journal beyond what the shared-DB specs
  tolerate — use a POST-created unique page and navigate to it.
- `pnpm build` first: e2e serves `web/dist`.
- Headless clipboard: dispatch a real `paste` event with a `DataTransfer`;
  for copy, patch `navigator.clipboard.writeText` to capture into
  `window.__copied` (pattern from pkm-y6af).

- [ ] **Step 1: Write the spec**

Create `web/e2e/paste.spec.ts`:

```ts
// pkm-tu3a: pasting an indented outline creates real hierarchy, and a
// copied multi-block selection round-trips through paste.
import { type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

const input = (page: Page) => page.locator("textarea.block-input");

/** Create a fresh page over the API and open it (never touches the shared
 * journal). */
async function openFreshPage(page: Page, title: string) {
  const res = await page.request.post("/api/pages", {
    data: { title },
  });
  expect(res.ok()).toBe(true);
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await expect(page.locator("h1.page-title")).toHaveText(title);
}

async function pasteText(page: Page, text: string) {
  await input(page).evaluate((el: HTMLTextAreaElement, clip: string) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", clip);
    el.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
  }, text);
}

test("pasting an indented outline creates nested blocks", async ({ page }) => {
  await login(page);
  const title = `Paste Target ${Date.now()}`;
  await openFreshPage(page, title);

  await page.getByText("Click to start writing…").click();
  await pasteText(page, "alpha\n\tbeta\n\t\tgamma\ndelta");

  // hierarchy renders: beta under alpha, gamma under beta, delta top-level
  const blocks = page.locator(".block-text");
  await expect(blocks).toHaveCount(4);
  await expect(page.locator(".block-children .block-text",
                            { hasText: "beta" })).toBeVisible();
  await expect(page.locator(".block-children .block-children .block-text",
                            { hasText: "gamma" })).toBeVisible();
  await waitForServerText(page, title, "gamma");

  // server structure: delta is a ROOT sibling, not nested
  const res = await page.request.get(`/api/page/${encodeURIComponent(title)}`);
  const body = await res.json() as {
    blocks: { text: string; children: { text: string }[] }[];
  };
  expect(body.blocks.map((b) => b.text)).toEqual(["alpha", "delta"]);
});

test("copy of a multi-block selection round-trips hierarchy", async ({ page }) => {
  await login(page);
  const src = `Paste Src ${Date.now()}`;
  await openFreshPage(page, src);

  await page.getByText("Click to start writing…").click();
  await pasteText(page, "one\n\ttwo\n\t\tthree");
  await waitForServerText(page, src, "three");

  // capture the clipboard: writeText is patched to window.__copied
  await page.evaluate(() => {
    (window as unknown as { __copied?: string }).__copied = undefined;
    navigator.clipboard.writeText = (t: string) => {
      (window as unknown as { __copied?: string }).__copied = t;
      return Promise.resolve();
    };
  });

  // select all three blocks: focus "one", select whole block, extend twice
  await page.locator(".block-text", { hasText: "one" }).click();
  await page.keyboard.press("Control+Meta+ArrowDown"); // one-block selection
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Meta+c");
  const copied = await page.evaluate(() =>
    (window as unknown as { __copied?: string }).__copied);
  expect(copied).toBe("one\n\ttwo\n\t\tthree");

  // paste the captured text into a fresh page and verify the structure
  const dst = `Paste Dst ${Date.now()}`;
  await openFreshPage(page, dst);
  await page.getByText("Click to start writing…").click();
  await pasteText(page, copied!);
  await waitForServerText(page, dst, "three");
  const res = await page.request.get(`/api/page/${encodeURIComponent(dst)}`);
  const body = await res.json() as {
    blocks: { text: string;
              children: { text: string;
                          children: { text: string }[] }[] }[];
  };
  expect(body.blocks).toHaveLength(1);
  expect(body.blocks[0].text).toBe("one");
  expect(body.blocks[0].children[0].text).toBe("two");
  expect(body.blocks[0].children[0].children[0].text).toBe("three");
});
```

Before finalizing, read `web/e2e/fixtures.ts` and one selection e2e (the
pkm-0ovd Tab test in `edit.spec.ts`, added 2026-07-21 — search for
"selection") to confirm the exact selection-start chord and the copy
shortcut the tree handles (`EditableBlockTree.tsx:162` shows the copy path;
the keyboard chord that reaches it is in the tree container's keydown —
verify whether it is Meta+c on the tree container and whether
`page.keyboard.press("Meta+c")` reaches it headlessly; the pkm-am54 memory
warns native mac selection chords can't be reproduced headlessly, but
Ctrl+Cmd+ArrowDown and Shift+ArrowDown ARE app-handled keys, which do work —
see `web/e2e/edit.spec.ts`'s existing multi-block selection test for the
proven recipe).

If the selection-copy half proves headless-hostile after investigation,
keep test 1 (paste) as-is and reduce test 2 to: build the clipboard string
by hand (`"one\n\ttwo\n\t\tthree"`), paste it, and assert structure — the
copy format itself is already unit-tested in Task 3. Note the reduction in
the bean's Summary of Changes.

- [ ] **Step 2: Build and run the new spec**

```bash
cd web && pnpm build && pnpm exec playwright test e2e/paste.spec.ts
```
Expected: both tests PASS against the e2e server (fixtures boot it).

- [ ] **Step 3: Commit**

```bash
git add web/e2e/paste.spec.ts
git commit -m "test(pkm-tu3a): e2e outline paste + copy round-trip"
```

---

### Task 6: Full verification and bean completion

**Files:**
- Modify: `.beans/pkm-tu3a--preserve-block-hierarchy-when-pasting-outlines.md`

- [ ] **Step 1: Full web verification**

Run: `cd web && pnpm verify`
Expected: typecheck + unit coverage + lint/fcis/budgets + full Playwright
suite green. Known load-sensitive flake: `edit.spec.ts:308` (memory
2026-07-27) — retry once before investigating; investigate anything else.

- [ ] **Step 2: Server suite (untouched, but gate before merge)**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: all green (no server changes in this feature).

- [ ] **Step 3: Complete the bean**

Check off the remaining checklist items and append a `## Summary of
Changes` section describing: parser rules (indent stack, bullet stripping),
planner anchoring semantics, copy indentation, shell wiring, and test
coverage. Commit:

```bash
git add .beans/pkm-tu3a--preserve-block-hierarchy-when-pasting-outlines.md
git commit -m "chore(pkm-tu3a): record verified implementation"
```
