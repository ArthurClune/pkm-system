# Page Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking "Click to start writing…" on an empty `Paper/…` or
`Book/…` page seeds that namespace's attribute blocks from a markdown file in
`web/src/templates/`.

**Architecture:** A Functional Core module parses template markdown and picks
the template for a title. A thin shell module loads `web/src/templates/*.md`
at build time with `import.meta.glob`. `useOutline.createFirstBlock` asks for
the title's block texts (one `""` when no template applies) and creates them
as top-level blocks in one `run()`, so one undo removes them all.

**Tech Stack:** React, TypeScript, Vite (`import.meta.glob` with
`query: "?raw"`), Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-15-page-templates-design.md`

## Global Constraints

- All work in `/Users/arthur/code/llm/pkm/.worktrees/page-templates`; never
  touch `/Users/arthur/code/llm/pkm` directly. `web/node_modules` is a
  symlink: never stage it, never `pnpm add/install` through it.
- `Paper.md`: `- Tags:: #Paper`, `- URL::`, `- Date::`, `- Local copy::`, in
  that order.
- `Book.md`: `- Tags:: #Book`, `- Author::`, `- Reading Status::`,
  `- Published::`, `- Format::`, `- Summary::`, in that order.
- File name is the namespace; a title matches when it starts with
  `<name>/`, exact and case-sensitive.
- A line whose text ends in `::` gets one trailing space appended.
- Caret after seeding: end of the first block's text.
- Any title with no template: exactly today's behaviour (one `""` block).
- Every new `.ts` file carries `// pattern: Functional Core` or
  `// pattern: Imperative Shell` in its first five lines.
- Comments: no bean ids, no line numbers, ≤ 80 columns.
- Verify with `cd web && pnpm verify` (not typecheck + unit alone).

## Review Focus

1. A title like `Papers/x` or `Paperback` must not get the Paper template:
   only the exact `Paper/` prefix matches. (Task 1 test.)
2. A template file saved with CRLF line endings or a trailing blank line
   parses the same as LF. (Task 1 test.)
3. A malformed template file (indented line, line without `- `) must not
   break the app at load or seed partial junk: the namespace is dropped,
   and a test over the shipped files fails. (Task 1 test.)
4. One Cmd+Z after seeding removes every seeded block, not just the last.
   (Task 2 test.)
5. Seeded text survives the round trip to the server, trailing space
   included, so the attribute renders and the caret lands after `:: `.
   (Task 3 e2e.)

---

### Task 1: Template files and the pure parser/picker

**Files:**
- Create: `web/src/templates/Paper.md`, `web/src/templates/Book.md`
- Create: `web/src/templates/pageTemplates.ts` (Functional Core)
- Create: `web/src/templates/load.ts` (Imperative Shell)
- Test: `web/src/templates/pageTemplates.test.ts`

**Interfaces:**
- Produces, in `pageTemplates.ts`:
  - `type PageTemplates = ReadonlyMap<string, readonly string[]>` — namespace
    → block texts.
  - `parseTemplate(markdown: string): string[] | null` — null when any
    non-blank line is not `- <text>` at column 0.
  - `templatesFromFiles(files: Record<string, string>): PageTemplates` —
    keys are glob paths like `./Paper.md`; namespace is the basename without
    `.md`; files whose parse is null are left out.
  - `firstBlockTexts(title: string, templates: PageTemplates): readonly string[]`
    — the matching template's texts, else `[""]`.
- Produces, in `load.ts`: `export const PAGE_TEMPLATES: PageTemplates`, built
  from `import.meta.glob("./*.md", { query: "?raw", import: "default",
  eager: true })`.

- [ ] **Step 1: Write the template files** exactly as in Global Constraints
  (no trailing spaces).

- [ ] **Step 2: Write the failing tests** in `pageTemplates.test.ts`:

```ts
it("parses one block per '- ' line, padding a bare 'Key::'", () => {
  expect(parseTemplate("- Tags:: #Paper\n- URL::\n"))
    .toEqual(["Tags:: #Paper", "URL:: "]);
});
it("accepts CRLF and blank lines", () => {
  expect(parseTemplate("- A::\r\n\r\n- B:: x\r\n")).toEqual(["A:: ", "B:: x"]);
});
it.each(["  - nested::", "Tags:: #Paper", "-Tags::"])(
  "rejects a template with the line %j", (line) => {
    expect(parseTemplate(`- ok::\n${line}\n`)).toBeNull();
  });
it("names a template by its file and drops unparseable files", () => {
  const t = templatesFromFiles({ "./Paper.md": "- URL::", "./Bad.md": " x" });
  expect([...t.keys()]).toEqual(["Paper"]);
});
it.each([
  ["Paper/Agents of Chaos", ["Tags:: #Paper", "URL:: "]],
  ["Paper/a/b", ["Tags:: #Paper", "URL:: "]],
  ["Papers/x", [""]], ["paper/x", [""]], ["Paperback", [""]], ["Page", [""]],
])("picks the template for %j", (title, texts) => {
  const t = new Map([["Paper", ["Tags:: #Paper", "URL:: "]]]);
  expect(firstBlockTexts(title, t)).toEqual(texts);
});
it("ships the Paper and Book templates as specified", () => {
  expect(PAGE_TEMPLATES.get("Paper"))
    .toEqual(["Tags:: #Paper", "URL:: ", "Date:: ", "Local copy:: "]);
  expect(PAGE_TEMPLATES.get("Book")).toEqual(["Tags:: #Book", "Author:: ",
    "Reading Status:: ", "Published:: ", "Format:: ", "Summary:: "]);
});
it("every shipped template file parses", () => {
  const files = import.meta.glob("./*.md",
    { query: "?raw", import: "default", eager: true });
  expect(PAGE_TEMPLATES.size).toBe(Object.keys(files).length);
});
```

- [ ] **Step 3: Run to see them fail**
  Run: `cd web && pnpm vitest run src/templates`
  Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `pageTemplates.ts` and `load.ts`** per Interfaces.
  `load.ts` casts the glob result to `Record<string, string>` and calls
  `templatesFromFiles`.

- [ ] **Step 5: Run to see them pass**, then `pnpm typecheck` and
  `pnpm check:fcis`. Expected: all pass.

- [ ] **Step 6: Commit** `feat(templates): Paper and Book page templates as
  markdown (pkm-msan)`, staging the five files by path.

### Task 2: Seed the template from "Click to start writing…"

**Files:**
- Modify: `web/src/outline/useOutline.ts` (`createFirstBlock`)
- Test: `web/src/views/EditablePage.test.tsx`

**Interfaces:**
- Consumes: `firstBlockTexts` (Task 1), `PAGE_TEMPLATES` (Task 1),
  `orderIdxPlus` and `FIRST_ORDER_IDX` from `outline/orderIdx.ts`, `newUid`
  from `uid.ts`.

- [ ] **Step 1: Let `mount` take a title.** Add an optional `title = "Page"`
  parameter to `mount` in `EditablePage.test.tsx`, passed through
  `canonicalTitleOf`. Existing calls are unchanged.

- [ ] **Step 2: Write the failing tests** beside "empty page shows the
  start-writing affordance which creates block zero":

```ts
test("start-writing on a Paper/ page seeds the Paper template in one batch", () => {
  const sync = mount(makeSync(), [], "Paper/X");
  fireEvent.click(screen.getByRole("button", { name: /start writing/i }));
  expect(sync.sent).toHaveLength(1);
  expect(sync.sent[0].map((o) => o.op === "create" && [o.text, o.order_idx,
    o.parent_uid, o.page_title])).toEqual([
    ["Tags:: #Paper", 0, null, "Paper/X"], ["URL:: ", 1, null, "Paper/X"],
    ["Date:: ", 2, null, "Paper/X"], ["Local copy:: ", 3, null, "Paper/X"]]);
  const ta = textbox();
  expect(ta.value).toBe("Tags:: #Paper");
  expect(ta.selectionStart).toBe("Tags:: #Paper".length);
});

test("one undo removes every seeded template block", () => {
  const sync = mount(makeSync(), [], "Book/Y");
  fireEvent.click(screen.getByRole("button", { name: /start writing/i }));
  undoKey();
  expect(sync.sent.at(-1)!.filter((o) => o.op === "delete")).toHaveLength(6);
  expect(screen.getByRole("button", { name: /start writing/i }))
    .toBeInTheDocument();
});
```

  If the undo inverse is not one batch of six deletes, assert on the
  rendered result instead (the start-writing button back, no textboxes);
  the requirement is that one Cmd+Z empties the page.

- [ ] **Step 3: Run to see them fail**
  Run: `cd web && pnpm vitest run src/views/EditablePage.test.tsx -t "seed|seeded"`
  Expected: FAIL (one `""` create).

- [ ] **Step 4: Change `createFirstBlock`** to build one create op per
  `firstBlockTexts(pageTitle, PAGE_TEMPLATES)` entry, each with a fresh
  `newUid()`, `parent_uid: null`,
  `order_idx: orderIdxPlus(FIRST_ORDER_IDX, i)`; focus the first uid with
  `cursor` at its text's length. Keep the `b.length > 0` guard.

- [ ] **Step 5: Run the file's tests**, including the existing
  "creates block zero" test, and `pnpm typecheck`. Expected: all pass.

- [ ] **Step 6: Commit** `feat(outline): start-writing seeds a page's
  template (pkm-msan)`.

### Task 3: End-to-end check and docs

**Files:**
- Modify: `web/e2e/ownPage.ts` (`Scratch.open` takes an optional prefix)
- Create: `web/e2e/page-template.spec.ts`
- Modify: `docs/architecture/frontend-editor.md` (one sentence)

**Interfaces:**
- Produces: `Scratch = { open: (prefix?: string) => Promise<RawTitle> }`;
  the title becomes `` `${prefix ?? ""}e2e ${slug} ${Date.now()}` ``.

- [ ] **Step 1: Add the prefix to `scratch.open`.**

- [ ] **Step 2: Write the spec** using `test` from `./ownPage`:
  with the `ownPage` and `scratch` fixtures, `scratch.open("Paper/")`, click
  "Click to start writing…", type ` #AI` (keyboard, not fill), press
  Escape. Assert `waitForServerText(page, title, "Tags:: #Paper #AI")` and
  `waitForServerText(page, title, "Local copy:: ")`, then after
  `page.reload()` that `URL`, `Date` and `Local copy` attribute rows show,
  in that order after `Tags`.

- [ ] **Step 3: Run it**
  Run: `cd web && pnpm build && E2E_PORT=8975 node tooling/runPlaywright.ts e2e/page-template.spec.ts`
  Expected: PASS. A spec that writes shared state gets a full-suite run
  via `pnpm verify` in Task 4.

- [ ] **Step 4: Docs.** Invoke the `architecture-docs` skill. In
  `frontend-editor.md`, in the section that covers outline commands, add
  that "Click to start writing…" seeds the blocks of a markdown template in
  `web/src/templates/` named for the title's namespace (`Paper.md` for
  `Paper/…`), and that seeding happens only on that click so viewing a page
  never writes. Name `firstBlockTexts`; do not list the templates.

- [ ] **Step 5: Commit** `test(e2e)+docs: page templates (pkm-msan)`.

### Task 4: Verify the branch

- [ ] `cd web && set -o pipefail && pnpm verify` — exit 0.
- [ ] `proptest/check.sh web` (foreground, long timeout) — exit 0.
- [ ] `perf/check.sh frontend` — record the table for the review package.
- [ ] Update bean pkm-msan: tick the checklist, add `## Summary of Changes`,
  mark completed, commit the bean file.
