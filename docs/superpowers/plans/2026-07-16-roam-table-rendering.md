# Roam Table Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render imported Roam `{{table}}` trees as semantic Markdown-style tables and add `/table` to the existing slash-command menu.

**Architecture:** A pure Functional Core converts a valid table macro's block tree into normalized rows. A small Imperative Shell renders those rows with the existing inline-Markdown pipeline; the read-only and editable block shells substitute it for the macro's ordinary outline. The importer and stored source data remain unchanged.

**Tech Stack:** React 18, TypeScript, Vitest/Testing Library, CSS, pnpm, Python/pytest server verification

## Global Constraints

- Follow strict red-green-refactor: no production change before its focused regression test has failed for the expected reason.
- Preserve the imported `BlockNode` tree; do not alter the server or import pipeline.
- Recognize only complete `{{table}}` and `{{[[table]]}}` macro spellings, case-insensitively after trimming whitespace.
- Treat direct children as rows and each row's single-child chain as cells; first row is the header.
- Fall back to the ordinary outline for empty or branching table structures so no content is hidden.
- Pad ragged rows with empty trailing cells to the widest row.
- Every new runtime file must declare its FCIS pattern.
- Keep the bug bean `.beans/pkm-kbv5--render-roam-table-imports-as-markdown-tables.md` current and commit it with code changes.

---

### Task 1: Pure Roam table tree conversion

**Files:**
- Create: `web/src/components/roamTable.ts`
- Create: `web/src/components/roamTable.test.ts`

**Interfaces:**
- Consumes: generated `BlockNode` from `web/src/api/payloads.ts`.
- Produces: `RoamTableRows = (BlockNode | null)[][]` and `roamTableRows(node: BlockNode): RoamTableRows | null`.

- [ ] **Step 1: Write the failing pure-core tests**

Create `web/src/components/roamTable.test.ts` with fixtures that mirror `AI Pricing`'s direct-row/single-child-chain shape:

```ts
import { describe, expect, test } from "vitest";
import { block } from "../test-helpers";
import { roamTableRows } from "./roamTable";

const texts = (rows: ReturnType<typeof roamTableRows>) =>
  rows?.map((row) => row.map((cell) => cell?.text ?? null));

function validTable(text = "{{[[table]]}}") {
  return block("table", text, { children: [
    block("h1", "**Model**", { children: [
      block("h2", "Price", { children: [block("h3", "Plan")] }),
    ] }),
    block("r1c1", "[[Claude]]", { children: [
      block("r1c2", "$5", { children: [block("r1c3", "Pro")] }),
    ] }),
  ] });
}

describe("roamTableRows", () => {
  test("converts direct-child rows and their child chains in source order", () => {
    expect(texts(roamTableRows(validTable()))).toEqual([
      ["**Model**", "Price", "Plan"],
      ["[[Claude]]", "$5", "Pro"],
    ]);
  });

  test("accepts both exact macro spellings with whitespace and case", () => {
    expect(roamTableRows(validTable("  {{TABLE}}  "))).not.toBeNull();
    expect(roamTableRows(validTable("{{[[TaBlE]]}}"))).not.toBeNull();
  });

  test("rejects non-table and empty table blocks", () => {
    expect(roamTableRows(validTable("before {{table}}"))).toBeNull();
    expect(roamTableRows(block("empty", "{{table}}"))).toBeNull();
  });

  test("pads ragged rows to the widest row", () => {
    const table = validTable();
    table.children[1].children[0].children = [];
    expect(texts(roamTableRows(table))).toEqual([
      ["**Model**", "Price", "Plan"],
      ["[[Claude]]", "$5", null],
    ]);
  });

  test("rejects branching cell structures rather than hiding a branch", () => {
    const table = validTable();
    table.children[0].children.push(block("branch", "must remain visible"));
    expect(roamTableRows(table)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web
pnpm exec vitest run src/components/roamTable.test.ts
```

Expected: FAIL because `./roamTable` does not exist.

- [ ] **Step 3: Implement the minimal Functional Core**

Create `web/src/components/roamTable.ts`:

```ts
// pattern: Functional Core
// Converts Roam's table-macro block shape into normalized semantic rows.
import type { BlockNode } from "../api/payloads";

export type RoamTableRows = (BlockNode | null)[][];

const TABLE_MACRO = /^(?:\{\{table\}\}|\{\{\[\[table\]\]\}\})$/i;

export function roamTableRows(node: BlockNode): RoamTableRows | null {
  if (!TABLE_MACRO.test(node.text.trim()) || node.children.length === 0) return null;

  const rows: BlockNode[][] = [];
  for (const first of node.children) {
    const row: BlockNode[] = [];
    let cell: BlockNode | undefined = first;
    while (cell) {
      row.push(cell);
      if (cell.children.length > 1) return null;
      cell = cell.children[0];
    }
    rows.push(row);
  }

  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => [
    ...row,
    ...Array<BlockNode | null>(width - row.length).fill(null),
  ]);
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `cd web && pnpm exec vitest run src/components/roamTable.test.ts`.

Expected: 5 tests pass with no warnings.

- [ ] **Step 5: Commit the pure conversion**

```bash
git add web/src/components/roamTable.ts web/src/components/roamTable.test.ts
git commit -m "feat(web): parse Roam table block trees (pkm-kbv5)"
git push
```

---

### Task 2: Semantic table shell and read-only outline integration

**Files:**
- Create: `web/src/components/RoamTable.tsx`
- Modify: `web/src/components/BlockTree.tsx:5-67`
- Modify: `web/src/components/BlockTree.test.tsx`
- Modify: `web/src/styles.css:325-345`
- Modify: `web/src/styles.test.ts`

**Interfaces:**
- Consumes: `RoamTableRows` and `roamTableRows` from Task 1; existing `tokenizeBlock` and `InlineSegments`.
- Produces: `RoamTable({ rows }: { rows: RoamTableRows })` and read-only block substitution.

- [ ] **Step 1: Add failing read-only rendering and CSS tests**

In `BlockTree.test.tsx`, import `within` and add a collapsed macro fixture (matching all five `AI Pricing` macros) that asserts:

```ts
it("renders a collapsed Roam table as header/body rows instead of an outline", () => {
  const table = block("table", "{{[[table]]}}", { collapsed: true, children: [
    block("header-model", "**Model**", { children: [block("header-price", "Price")] }),
    block("claude", "[[Claude]]", { children: [block("claude-price", "$5")] }),
  ] });
  const { container } = renderTree([table]);
  const rendered = screen.getByRole("table");

  expect(within(rendered).getAllByRole("columnheader").map((x) => x.textContent))
    .toEqual(["Model", "Price"]);
  expect(within(rendered).getAllByRole("cell").map((x) => x.textContent))
    .toEqual(["Claude", "$5"]);
  expect(within(rendered).getByRole("link", { name: "Claude" })).toBeInTheDocument();
  expect(within(rendered).getByText("Model").closest("strong")).not.toBeNull();
  expect(screen.queryByText("{{[[table]]}}")).toBeNull();
  expect(container.querySelector(".block-children")).toBeNull();
});
```

In `styles.test.ts`, add:

```ts
describe("Roam tables (pkm-kbv5)", () => {
  test("wide tables scroll and cells use themed borders", () => {
    expect(ruleFor(".roam-table-scroll")).toContain("overflow-x: auto;");
    expect(ruleFor(".roam-table th, .roam-table td"))
      .toContain("border: 1px solid var(--color-border);");
    expect(ruleFor(".roam-table th")).toContain("text-align: left;");
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd web
pnpm exec vitest run src/components/BlockTree.test.tsx src/styles.test.ts
```

Expected: the table test fails because no element has role `table`; the style test fails with `Missing CSS rule for .roam-table-scroll`.

- [ ] **Step 3: Add the semantic rendering shell**

Create `web/src/components/RoamTable.tsx`:

```tsx
// pattern: Imperative Shell
// Semantic table shell composing the context-aware inline render pipeline.
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import type { RoamTableRows } from "./roamTable";

export function RoamTable({ rows }: { rows: RoamTableRows }) {
  const [header, ...body] = rows;
  const content = (text: string) =>
    <InlineSegments segments={tokenizeBlock(text)} />;

  return (
    <div className="roam-table-scroll">
      <table className="roam-table">
        <thead><tr>{header.map((cell, index) => (
          <th key={cell?.uid ?? `empty-header-${index}`} scope="col">
            {cell ? content(cell.text) : null}
          </th>
        ))}</tr></thead>
        <tbody>{body.map((row, rowIndex) => (
          <tr key={row.find((cell) => cell)?.uid ?? `empty-row-${rowIndex}`}>
            {row.map((cell, cellIndex) => (
              <td key={cell?.uid ?? `empty-${rowIndex}-${cellIndex}`}>
                {cell ? content(cell.text) : null}
              </td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Substitute valid tables in `BlockTree`**

Import `RoamTable` and `roamTableRows`. After computing `childrenView`, compute `const tableRows = roamTableRows(node);`. Render `RoamTable` instead of `InlineSegments` when rows exist, and suppress the descendant outline:

```tsx
<Tag className={"block-text" + (quoted !== null ? " quote-block" : "")}>
  {tableRows
    ? <RoamTable rows={tableRows} />
    : <InlineSegments segments={tokenizeBlock(quoted ?? node.text)} />}
</Tag>
...
{hasChildren && !collapsed && !tableRows && (/* existing children */)}
```

Use `tableRows === null` when deriving chevron visibility so a rendered table does not advertise a collapse action whose contents are already represented by the table. Do not gate table rendering on `collapsed`: imported `AI Pricing` table macros are intentionally stored collapsed.

- [ ] **Step 5: Add scoped CSS**

Add beside the inline/code presentation rules in `styles.css`:

```css
.roam-table-scroll { display: block; width: 100%; overflow-x: auto; margin: 4px 0; }
.roam-table { width: 100%; min-width: max-content; border-collapse: collapse; }
.roam-table th, .roam-table td { border: 1px solid var(--color-border);
  padding: 6px 8px; vertical-align: top; }
.roam-table th { background: var(--color-bg-subtle); text-align: left; font-weight: 600; }
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run `cd web && pnpm exec vitest run src/components/roamTable.test.ts src/components/BlockTree.test.tsx src/styles.test.ts`.

Expected: all focused tests pass.

- [ ] **Step 7: Commit and push the read-only renderer**

```bash
git add web/src/components/RoamTable.tsx web/src/components/BlockTree.tsx \
  web/src/components/BlockTree.test.tsx web/src/styles.css web/src/styles.test.ts
git commit -m "feat(web): render imported Roam tables (pkm-kbv5)"
git push
```

---

### Task 3: Editable outline integration and raw editing fallback

**Files:**
- Modify: `web/src/components/EditableBlockTree.tsx:194-299`
- Modify: `web/src/components/EditableBlockTree.test.tsx`

**Interfaces:**
- Consumes: `RoamTable`, `roamTableRows`, existing `FocusTarget`, handlers, and `BlockInput`.
- Produces: rendered-table display mode that returns to the existing raw editor when the macro receives focus.

- [ ] **Step 1: Write the failing editable regression test**

Add a test that renders a collapsed valid macro, verifies the table, clicks it, and rerenders using the focus request:

```ts
test("a rendered Roam table focuses its macro and reveals raw editable blocks", () => {
  const h = handlers();
  const macro = block("table", "{{[[table]]}}", { collapsed: true, children: [
    block("header", "Model", { children: [block("header-2", "Price")] }),
    block("row", "Claude", { children: [block("row-2", "$5")] }),
  ] });
  const view = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[macro]} focus={null} handlers={h} readOnly={false} />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("table"));
  expect(h.onFocusBlock).toHaveBeenCalledWith("table", "{{[[table]]}}".length);

  view.rerender(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={[macro]} focus={{ uid: "table", cursor: 0 }}
                         handlers={h} readOnly={false} />
    </MemoryRouter>,
  );
  expect(screen.queryByRole("table")).toBeNull();
  expect(focusedTextarea()).toHaveValue("{{[[table]]}}");
  expect(screen.getByText("Model")).toBeInTheDocument();
  expect(screen.getByText("Claude")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web
pnpm exec vitest run src/components/EditableBlockTree.test.tsx \
  -t "a rendered Roam table focuses its macro"
```

Expected: FAIL because the editable tree has no semantic table.

- [ ] **Step 3: Integrate table display into `EditableBlock`**

Import `RoamTable` and `roamTableRows`. Compute:

```ts
const tableRows = roamTableRows(node);
const showTable = !focused && tableRows !== null;
```

In the unfocused `Tag`, choose `<RoamTable rows={tableRows} />` when `showTable`; otherwise retain `InlineSegments` and `BlockEditContext`. Keep the existing `Tag` click handler so clicking non-link table content focuses the macro block.

Change descendant rendering to:

```tsx
{hasChildren && !showTable && (tableRows !== null || !node.collapsed) && (
  <div className={`block-children ${childrenView}-view`}>
    {/* existing recursive EditableBlock mapping */}
  </div>
)}
```

This deliberately reveals the source rows whenever a valid table macro is focused, even when imported with `collapsed: true`; malformed tables continue to obey ordinary collapse behavior. Derive chevron visibility/disabled state from `showTable ? false : hasChildren` so the rendered-table state has no misleading collapse control.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd web
pnpm exec vitest run src/components/EditableBlockTree.test.tsx \
  src/components/BlockTree.test.tsx src/components/roamTable.test.ts
```

Expected: all tests pass, including the editable fallback regression.

- [ ] **Step 5: Commit and push editable integration**

```bash
git add web/src/components/EditableBlockTree.tsx \
  web/src/components/EditableBlockTree.test.tsx
git commit -m "feat(web): edit rendered Roam table sources (pkm-kbv5)"
git push
```

---

### Task 4: `/table` creation command

**Files:**
- Modify: `web/src/outline/slashCommands.ts:22-36,92-102`
- Modify: `web/src/outline/slashCommands.test.ts`
- Modify: `web/src/components/EditableBlockTree.test.tsx`

**Interfaces:**
- Consumes: existing `SLASH_COMMANDS`, `matchSlashCommands`, `applySlashCommand`, and autocomplete selection path.
- Produces: `{ name: "table", label: "Table" }`; empty `/table` becomes `{ text: "{{table}}", cursor: 9 }`.

- [ ] **Step 1: Write failing core and integration tests**

Add to `slashCommands.test.ts`:

```ts
describe("table", () => {
  test("table is offered and creates an exact renderable macro", () => {
    expect(matchSlashCommands("tab")).toEqual([{ name: "table", label: "Table" }]);
    expect(applySlashCommand("/table", 6,
      { kind: "command", start: 1, query: "table" }, "table"))
      .toEqual({ text: "{{table}}", cursor: 9 });
  });

  test("does not discard existing content when /table is picked mid-block", () => {
    expect(applySlashCommand("notes /table", 12,
      { kind: "command", start: 7, query: "table" }, "table"))
      .toEqual({ text: "notes ", cursor: 6 });
  });
});
```

Add an `EditableBlockTree.test.tsx` command-menu test mirroring the existing `/todo` test: type `/tab`, assert the `Table` option, press Enter, and expect `onDraftChange("u1", "{{table}}")`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd web
pnpm exec vitest run src/outline/slashCommands.test.ts \
  src/components/EditableBlockTree.test.tsx -t "table"
```

Expected: FAIL because `Table` is absent from the command list.

- [ ] **Step 3: Add the command and safe transform**

Add `{ name: "table", label: "Table" }` near `todo` in `SLASH_COMMANDS`. Add this switch case before the code-fence cases:

```ts
case "table":
  return content.trim()
    ? { text: content, cursor: content.length }
    : { text: "{{table}}", cursor: "{{table}}".length };
```

This creates an exact macro on the intended empty-block path and never destroys unrelated text if selected elsewhere.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd web
pnpm exec vitest run src/outline/slashCommands.test.ts \
  src/components/EditableBlockTree.test.tsx
```

Expected: all slash-command and editable-tree tests pass.

- [ ] **Step 5: Update bean implementation checkboxes, commit, and push**

Use `beans update pkm-kbv5 --body-replace-old ... --body-replace-new ...` to check:

- `Add a focused regression test and confirm it fails`
- `Implement the minimal frontend table renderer`
- `Add the /table creation command`

Then:

```bash
git add web/src/outline/slashCommands.ts web/src/outline/slashCommands.test.ts \
  web/src/components/EditableBlockTree.test.tsx \
  .beans/pkm-kbv5--render-roam-table-imports-as-markdown-tables.md
git commit -m "feat(web): add table slash command (pkm-kbv5)"
git push
```

---

### Task 5: Full verification, review, integration, and bean completion

**Files:**
- Modify: `.beans/pkm-kbv5--render-roam-table-imports-as-markdown-tables.md`

**Interfaces:**
- Consumes: all implementation tasks.
- Produces: verified, reviewed, merged, pushed fix with completed bean.

- [ ] **Step 1: Run all required verification from the worktree root**

```bash
cd server && uv run pytest -q
cd ../server && uv run pyrefly check
cd ../server && uv run ruff check
cd ../web && pnpm verify
cd .. && git diff --check && git status --short
```

Expected:

- server: 395 or more tests pass and enforced coverage remains at least 95%;
- pyrefly: no errors;
- ruff: no errors;
- web: typecheck, lint, FCIS, enforced coverage, build, and all Playwright tests pass;
- `git diff --check`: no output.

- [ ] **Step 2: Update verification state and summary in the bean**

Check `Run focused and full verification` and append:

```markdown
## Summary of Changes

- Added a pure Roam table-tree converter with malformed-tree fallback and ragged-row padding.
- Rendered valid imported table macros as semantic, horizontally scrollable tables in read-only and editable outlines.
- Preserved raw source editing by revealing the macro subtree while its macro block is focused.
- Added `/table` to create an exact `{{table}}` macro.
- Verified server tests/typecheck/lint and the complete web verification suite.
```

Commit and push the bean update:

```bash
git add .beans/pkm-kbv5--render-roam-table-imports-as-markdown-tables.md
git commit -m "chore(beans): record pkm-kbv5 verification"
git push
```

- [ ] **Step 3: Invoke `superpowers:requesting-code-review` and address findings**

Review the complete branch diff against the design spec and this plan. For any valid finding, use `superpowers:receiving-code-review`, add a failing regression test first, implement the minimal correction, rerun focused/full verification as appropriate, commit, and push.

- [ ] **Step 4: Merge with preserved branch history and push main**

From `/Users/arthur/code/llm/pkm`:

```bash
git status --short
git pull --ff-only
git merge --no-ff fix/roam-table-import \
  -m "Merge fix/roam-table-import: render Roam tables (pkm-kbv5)"
git push origin main
```

Expected: clean main checkout, a non-fast-forward merge commit, and successful push.

- [ ] **Step 5: Complete the bean only after merge**

From main, check the merge/completion checklist item, ensure no unchecked items remain, and mark the bean completed:

```bash
beans update pkm-kbv5 \
  --body-replace-old '- [ ] Commit, push, merge with --no-ff, and push main' \
  --body-replace-new '- [x] Commit, push, merge with --no-ff, and push main'
beans update pkm-kbv5 \
  --body-replace-old '- [ ] Document the result and complete the bean' \
  --body-replace-new '- [x] Document the result and complete the bean' \
  --status completed
git add .beans/pkm-kbv5--render-roam-table-imports-as-markdown-tables.md
git commit -m "chore(beans): mark pkm-kbv5 completed"
git push origin main
```

- [ ] **Step 6: Report evidence**

Report the merged commit, the exact server/web verification counts, the table behavior on the `AI Pricing` shape, `/table` behavior, and bean `pkm-kbv5` completion. Offer to create a follow-up bean only for non-urgent work explicitly deferred during review.
