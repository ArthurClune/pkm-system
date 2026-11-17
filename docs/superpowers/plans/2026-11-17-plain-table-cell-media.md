# Plain-table cell media renders in place — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a plain `{{table}}` cell, code renders as a code block, Mermaid
and nested queries as their source, and a bare Bluesky URL as a link,
instead of a ↗ label that jumps to its own cell.

**Architecture:** `CellMediaTarget` becomes a union that says which table the
cell belongs to. `cellMedia` (Functional Core) takes it and, for a plain
table, maps each former "line" medium to an in-place rendering; `Segment`
renders those. A "line" label carries its own page and uid, so
`CellMediaLabel` no longer reads the context.

**Tech Stack:** React, TypeScript, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-plain-table-cell-media-design.md`

**Worktree:** `/Users/arthur/code/llm/pkm/.worktrees/plain-table-cell-media`
(branch `feat/plain-table-cell-media`). Run every command from there; never
touch `/Users/arthur/code/llm/pkm` directly. Bean: `pkm-8ypj`.

## Global Constraints

- Query tables and Cards (`recordCells.tsx`) keep every label as today.
- PDFs and images keep their labels and overlays in every table.
- `StaticTable` (`roamTable.tsx`) and `PlainTable` render a cell the same.
- `data-cell-uid` on plain-table `<td>`s stays: a jump from elsewhere (a
  query-table label, a search hit) still lands on a plain-table cell.

## Review Focus

- A code block widens its column: the table must scroll sideways, not the
  page (`.data-table-scroll` / `.roam-table-scroll`). Checked by screenshot
  in Task 2.
- A click on the Bluesky link in a plain cell follows the link and does not
  open the cell editor (`DataTable.onCellClick` ignores `a`). Test in Task 1.
- A click on a rendered code block opens the cell editor, like any other
  cell text. Test in Task 1.
- A nested query's source keeps its options (`view:`, `sort:` …), not just
  the expression. Test in Task 1.
- A block ref in a plain cell whose block holds a query or code renders in
  place too (it is under the same context). No extra code; covered by the
  `cellMedia` tests being per-segment.

---

### Task 1: Plain-table cells render code, sources and links in place

**Files:**
- Modify: `web/src/contexts.ts` (`CellMediaTarget`, its doc comment)
- Modify: `web/src/components/cellMediaCore.ts`
- Modify: `web/src/components/InlineSegments.tsx` (`Segment`)
- Modify: `web/src/components/CellMediaLabel.tsx`
- Modify: `web/src/components/PlainTable.tsx`, `web/src/components/roamTable.tsx`
  (provide the plain target; drop their `OutlinePageContext` read if nothing
  else in the file uses it)
- Modify: `web/src/tables/recordCells.tsx` (provide the query target)
- Test: `web/src/components/cellMediaCore.test.ts`,
  `web/src/components/CellMediaLabel.test.tsx`,
  `web/src/components/roamTable.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // contexts.ts
  export type CellMediaTarget =
    | { table: "plain" }
    | { table: "query"; page: RawTitle; uid: BlockUid };
  // cellMediaCore.ts
  export type CellMedia =
    | { kind: "pdf"; href: string; label: string }
    | { kind: "image"; src: string; alt: string; label: string }
    | { kind: "line"; label: string; page: RawTitle; uid: BlockUid }
    | { kind: "code"; lang: string | null; code: string }
    | { kind: "link"; href: string }
    | { kind: "source"; text: string };
  export type LabelMedia = Extract<CellMedia, { kind: "pdf" | "image" | "line" }>;
  export function cellMedia(seg: BlockSegment, target: CellMediaTarget): CellMedia | null;
  // CellMediaLabel.tsx
  export function CellMediaLabel({ media }: { media: LabelMedia }): JSX.Element;
  ```

- [ ] **Step 1: Update `cellMediaCore.test.ts` (failing)**

  Every existing call gains a target: `const QUERY = { table: "query", page:
  rawTitleOf("P"), uid: uidOf("u1") } as const` and `const PLAIN = { table:
  "plain" } as const`. Existing assertions run against `QUERY`; the "line"
  expectations gain `page` and `uid`. The `it.each` "leaves %s alone" and
  plain-text cases run against both targets. New cases:

  ```ts
  it("in a plain table, shows code as code and mermaid as plain code", () => {
    expect(cellMedia(seg("```python\nprint(1)\n```"), PLAIN))
      .toEqual({ kind: "code", lang: "python", code: "print(1)" });
    expect(cellMedia(seg("```mermaid\ngraph TD; A-->B\n```"), PLAIN))
      .toEqual({ kind: "code", lang: null, code: "graph TD; A-->B" });
  });
  it("in a plain table, a bare Bluesky post is a link", () => {
    expect(cellMedia(seg(POST), PLAIN)).toEqual({ kind: "link", href: POST });
  });
  it("in a plain table, a query is its source, options kept", () => {
    expect(cellMedia(seg("{{query: {and: [[X]]} | view: cards}}"), PLAIN))
      .toEqual({ kind: "source", text: "{{query: {and: [[X]]} | view: cards}}" });
  });
  it("in a plain table, PDFs and images keep their labels", () => { /* the
    pdf and image cases above, against PLAIN, give the same result */ });
  ```
  Check the options separator against `formatMacroOptions`' `SEPARATOR` and
  write the expected source in that form.

- [ ] **Step 2: Run** `cd web && pnpm vitest run src/components/cellMediaCore.test.ts`
  — expect FAIL (type errors / wrong kinds).

- [ ] **Step 3: Implement** the `CellMediaTarget` union in `contexts.ts`
  (doc comment: a plain-table cell renders line media in place; a query
  cell or card shows a label that goes to `uid` on `page`), and
  `cellMedia(seg, target)`. For `target.table === "plain"`: code-block →
  `code` (Mermaid with `lang: null`); bare Bluesky link → `link`; query →
  `source` with text `` `{{query: ${expr}${formatMacroOptions(options)}}}` ``
  (`formatMacroOptions` from `../grammar/macroOptionsWrite`, Functional
  Core). For `"query"`: today's results, "line" carrying `target.page` and
  `target.uid`. Update the file's header comment.

- [ ] **Step 4: Run** the same command — expect PASS.

- [ ] **Step 5: Wire the renderers and providers.** In `Segment`, read the
  target and, when `cellMedia` returns non-null: `code` → `<CodeBlock>`,
  `link` → `<a href target="_blank" rel="noreferrer">{href}</a>`, `source`
  → the text, otherwise `<CellMediaLabel media=…>`. `CellMediaLabel` takes
  `LabelMedia`, uses `media.page`/`media.uid` for the line jump, and drops
  the context read and its no-page `<span>` branch (and the
  `span.cell-media-label` rules in `styles.css` if nothing else renders a
  `span.cell-media-label`). `PlainTable` and `StaticTable` provide
  `{ table: "plain" }`; `CellValue` provides `{ table: "query", page, uid }`.

- [ ] **Step 6: Update `CellMediaLabel.test.tsx` and `roamTable.test.tsx`**

  `CellMediaLabel.test.tsx`: `renderCell` provides a query target;
  delete `line_label_without_a_page_is_text` (that state no longer exists).
  `roamTable.test.tsx`, `RoamTable media cells`: replace
  "a line label goes to the cell's own block on this page" with:
  ```ts
  it("a mermaid cell shows its source as code, with no label", async () => {
    mountMedia(); await loaded();
    expect(screen.queryByRole("button", { name: /Mermaid/ })).toBeNull();
    const pre = screen.getByText("graph TD; A-->B").closest("pre.code-block");
    expect(pre).not.toBeNull();
    expect(pre!.closest("td")).toHaveAttribute("data-cell-uid", "tuid-bx");
  });
  it("a click on a code cell opens the cell editor", async () => {
    mountMedia(); await loaded();
    fireEvent.click(screen.getByText("graph TD; A-->B"));
    expect(tableEditor()).not.toBeNull();
  });
  it("a Bluesky cell is a link whose click opens no editor", async () => { … });
  ```
  For the Bluesky test, add a third row to `mediaTable` (`tuid-c`, `["bsky",
  POST]`) and assert `getByRole("link", { name: POST })` has `href` POST,
  and `fireEvent.click` on it leaves `tableEditor()` null.
  In "before the tables chunk loads", replace the `↗ Mermaid diagram`
  assertion with the `pre.code-block` one.

- [ ] **Step 7: Run** `cd web && pnpm typecheck && pnpm test:unit` — expect PASS.

- [ ] **Step 8: Commit** (stage by explicit path; never `web/node_modules`)
  ```bash
  git commit -m "Plain-table cells render code, sources and links in place (pkm-8ypj)"
  ```

### Task 2: E2E, architecture doc, bean

**Files:**
- Modify: `web/e2e/cell-media.spec.ts`
- Modify: `docs/architecture/frontend-rendering.md` § Media in table cells
  (use the `architecture-docs` skill)
- Modify: `.beans/pkm-8ypj*.md`

- [ ] **Step 1: Rewrite the plain-table half of `cell-media.spec.ts`.**
  The Mermaid cell shows `pre.code-block` containing `graph TD; A-->B`, no
  `svg`, no `↗` button; a click on it opens `textarea.cell-editor` (close it
  with Escape). Keep the jump-to-cell coverage by navigating to
  `` `${path}#${mermaidUid}` `` and asserting the `td[data-cell-uid=…]`
  gets `flash-target`. Drop the shift-click sidebar step (the plain table no
  longer has a label). Update the file's header comment and the test title.

- [ ] **Step 2: Run** `cd web && E2E_PORT=8975 pnpm e2e cell-media` (check
  `package.json` for the exact filter form) — expect PASS.

- [ ] **Step 3: Update the doc.** In § Media in table cells: the table's
  `line` row applies to query tables and Cards only, carrying page and uid in
  the result; add the plain-table rendering (code → `CodeBlock`, Mermaid →
  `CodeBlock` with no language, bare Bluesky → link, query → its source via
  `formatMacroOptions`); replace the sentences about a plain table's line
  being its own cell and the no-page plain-text label; keep the
  `data-cell-uid` rule, now justified by jumps from elsewhere.

- [ ] **Step 4: Run the full gate:** `cd web && set -o pipefail && pnpm verify`
  — expect exit 0. Then `perf/check.sh frontend` from the repo root.

- [ ] **Step 5: Screenshot** a plain table with a wide code block (the
  `verify` skill, scratch server on 8975): the table scrolls sideways, the
  page does not.

- [ ] **Step 6: Bean.** Tick its checklist, add `## Summary of Changes`
  (symptom: "↗ Mermaid diagram" / "↗ Code block" label in a plain table
  jumped to its own cell; now rendered in place; rule in
  frontend-rendering.md § Media in table cells), set status `completed`.

- [ ] **Step 7: Commit** e2e, doc, bean, spec and plan.
