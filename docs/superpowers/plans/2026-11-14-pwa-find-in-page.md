# Find in Page for the Installed App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the installed app (`display-mode: standalone`), Cmd-F opens an
in-app find bar over the main pane and right sidebar, and Cmd-G /
Shift-Cmd-G step through matches.

**Architecture:** A pure matcher (`find/findMatches.ts`) finds matches in
groups of text-node strings and maps them back to node offsets. A DOM shell
(`find/pageText.ts`) walks the searched regions into those groups and turns
matches into `Range`s. `find/FindBar.tsx` owns the keys, the bar, a
`MutationObserver` for recounts, and paints with the CSS Custom Highlight
API. It mounts once in `App.tsx`.

**Tech Stack:** React 19 + TypeScript, vitest + jsdom, Playwright
(Chromium).

**Spec:** `docs/superpowers/specs/2026-11-14-pwa-find-in-page-design.md`

Worktree: `/Users/arthur/code/llm/pkm/.worktrees/pwa-find`, branch
`feat/pwa-find`, bean `pkm-06os`. Run every command from the worktree;
never touch `/Users/arthur/code/llm/pkm` directly.

## Global Constraints

- Keys bind only while `window.matchMedia("(display-mode: standalone)").matches`,
  read at keydown time (not cached at mount).
- Chords are `metaKey` only, with `ctrlKey` and `altKey` false. No Ctrl
  variant: Ctrl-F/Ctrl-G are emacs bindings inside block textareas.
- Searched regions: `.main-pane` and `.sidebar` (`<aside>` in `App.tsx`).
- Case-insensitive; the query is literal text, never a regex.
- Highlight registry names: `pkm-find` (all matches) and `pkm-find-current`.
- Count copy: `"{n} of {m}"`; `"No matches"` when the query is non-empty and
  nothing matches; empty when the query is empty.
- Every new runtime file starts with `// pattern: Functional Core` or
  `// pattern: Imperative Shell`; comment lines ≤ 80 columns; no bean ids
  in code comments.
- Verification command for the branch: `cd web && pnpm verify` (not just
  typecheck + unit).

## Review Focus

1. **Regex metacharacters in the query** (`a.b`, `(x`, `$5`): must match
   literally and never throw. Task 1 test `treats the query as literal text`.
2. **Escape in the find input must not also close another surface or clear
   a block selection**: the bar stops the event's propagation. Task 3 test
   `Escape in the bar does not reach document listeners`.
3. **A match spanning inline markup** (`foo **bar**` rendered as text plus
   `<strong>`) must still be found, but never one spanning two blocks.
   Task 1 tests `matches across nodes of one group` and `never matches
   across groups`; Task 2 test `groups text by block row`.
4. **The page changing under an open bar** (navigation, a sync edit): the
   count updates and the current index clamps instead of pointing past the
   end. Task 1 test for `clampIndex`; Task 3 test `recounts when the
   searched DOM changes`.
5. **Cmd-F from inside an editing block**: the block's text must become
   searchable and Escape must put the user back into that block. Task 4
   e2e `searches a block that was being edited and Escape re-enters it`.

---

### Task 1: Pure matcher

**Files:**
- Create: `web/src/find/findMatches.ts`
- Test: `web/src/find/findMatches.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NodePos = { node: number; offset: number };
  export type FindMatch = { group: number; start: NodePos; end: NodePos };
  export function findMatches(
    groups: readonly (readonly string[])[], query: string): FindMatch[];
  export function stepIndex(
    current: number | null, count: number, dir: 1 | -1): number | null;
  export function clampIndex(
    current: number | null, count: number): number | null;
  export type FindCommand = "open" | "next" | "prev";
  export function findCommand(e: {
    key: string; metaKey: boolean; ctrlKey: boolean;
    altKey: boolean; shiftKey: boolean }): FindCommand | null;
  ```
  `node` indexes into the group's string array; `end` is exclusive, and
  `end.offset` may equal that node's length. Matches are ordered by group,
  then by position.

- [ ] **Step 1: Write the failing tests** in `findMatches.test.ts`:

```ts
describe("findMatches", () => {
  it("is case-insensitive", () => {
    expect(findMatches([["Hello hello"]], "HELLO")).toEqual([
      { group: 0, start: { node: 0, offset: 0 }, end: { node: 0, offset: 5 } },
      { group: 0, start: { node: 0, offset: 6 }, end: { node: 0, offset: 11 } },
    ]);
  });
  it("folds case outside ASCII", () => {
    expect(findMatches([["école"]], "ÉCOLE")).toHaveLength(1);
  });
  it("treats the query as literal text", () => {
    expect(findMatches([["axb a.b (x $5"]], "a.b")).toHaveLength(1);
    expect(findMatches([["(x"]], "(x")).toHaveLength(1);
    expect(findMatches([["$5"]], "$5")).toHaveLength(1);
  });
  it("does not overlap matches", () => {
    expect(findMatches([["aaa"]], "aa")).toHaveLength(1);
  });
  it("matches across nodes of one group", () => {
    expect(findMatches([["foo ba", "r baz"]], "bar")).toEqual([
      { group: 0, start: { node: 0, offset: 4 }, end: { node: 1, offset: 1 } },
    ]);
  });
  it("ends a match at the end of its node, not the start of the next", () => {
    expect(findMatches([["foo", "bar"]], "foo")[0].end)
      .toEqual({ node: 0, offset: 3 });
  });
  it("never matches across groups", () => {
    expect(findMatches([["foo"], ["bar"]], "foobar")).toEqual([]);
  });
  it("returns nothing for an empty query", () => {
    expect(findMatches([["abc"]], "")).toEqual([]);
  });
});

describe("stepIndex", () => {
  it("starts at the first or last match", () => {
    expect(stepIndex(null, 3, 1)).toBe(0);
    expect(stepIndex(null, 3, -1)).toBe(2);
  });
  it("wraps both ways", () => {
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
  });
  it("is null with no matches", () => {
    expect(stepIndex(1, 0, 1)).toBeNull();
  });
});

describe("clampIndex", () => {
  it("keeps an index that still exists", () => expect(clampIndex(1, 3)).toBe(1));
  it("falls back to the first match", () => expect(clampIndex(5, 3)).toBe(0));
  it("is null with no matches", () => expect(clampIndex(0, 0)).toBeNull());
  it("selects the first match when nothing was current", () =>
    expect(clampIndex(null, 2)).toBe(0));
});

describe("findCommand", () => {
  const k = (key: string, mods: Partial<Record<
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
    ({ key, metaKey: false, ctrlKey: false, altKey: false,
       shiftKey: false, ...mods });
  it("maps the chords", () => {
    expect(findCommand(k("f", { metaKey: true }))).toBe("open");
    expect(findCommand(k("g", { metaKey: true }))).toBe("next");
    expect(findCommand(k("G", { metaKey: true, shiftKey: true }))).toBe("prev");
    expect(findCommand(k("g", { metaKey: true, shiftKey: true }))).toBe("prev");
  });
  it("leaves Ctrl and Alt chords alone", () => {
    expect(findCommand(k("f", { ctrlKey: true }))).toBeNull();
    expect(findCommand(k("f", { metaKey: true, ctrlKey: true }))).toBeNull();
    expect(findCommand(k("f", { metaKey: true, altKey: true }))).toBeNull();
    expect(findCommand(k("f"))).toBeNull();
  });
  it("ignores Shift-Cmd-F", () => {
    expect(findCommand(k("F", { metaKey: true, shiftKey: true }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing):
  `cd web && pnpm vitest run src/find/findMatches.test.ts`

- [ ] **Step 3: Implement** `findMatches.ts` (`// pattern: Functional Core`).
  Per group, join the strings, keep each node's start offset, run
  `new RegExp(escaped, "giu")` over the join (escaping makes the query
  literal; the `i`+`u` flags fold case without changing offsets), and map
  each match's start and exclusive end back to `NodePos` by binary or
  linear search over node starts. For the end, pick the node where
  `nodeStart < end <= nodeStart + length` so a match ending at a node
  boundary ends in that node.

- [ ] **Step 4: Run, expect PASS**, same command.

- [ ] **Step 5: Commit**
  `git add web/src/find/findMatches.ts web/src/find/findMatches.test.ts`
  then `git commit -m "find: pure matcher for in-app find (pkm-06os)"`.

### Task 2: Page text shell

**Files:**
- Create: `web/src/find/pageText.ts`
- Test: `web/src/find/pageText.test.ts`

**Interfaces:**
- Consumes: `FindMatch` from Task 1.
- Produces:
  ```ts
  export const FIND_ROOTS_SELECTOR = ".main-pane, .sidebar";
  export type PageText = { groups: string[][]; nodes: Text[][] };
  export function collectPageText(roots: readonly Element[]): PageText;
  export function matchRange(text: PageText, m: FindMatch): Range;
  ```
  `groups[i][j] === nodes[i][j].data`.

- [ ] **Step 1: Write the failing tests** (build DOM with
  `document.body.innerHTML`):
  - `groups text by block row`: two `.block-row` elements, the first
    containing `foo <strong>bar</strong>`, the second `baz`; expect
    `groups` to equal `[["foo ", "bar"], ["baz"]]`.
  - `groups text outside a block row by its parent element`: a `<h1>`
    title and a `<p>` in the root give two groups.
  - `skips form controls, scripts and styles`: text inside `textarea`,
    `input`, `script`, `style` and `noscript` is not collected.
  - `skips whitespace-only nodes`: `"\n  "` between elements is not a group
    member.
  - `skips hidden elements where the browser can tell`: an element whose
    `checkVisibility` is stubbed to return `false` contributes nothing; with
    `checkVisibility` absent (jsdom's default) text is collected.
  - `walks roots in order`: two roots give groups from the first root
    before the second.
  - `matchRange spans the matched nodes`: for `[["foo ba", "r"]]` and the
    match from Task 1's cross-node example, `range.toString()` is `"bar"`.

- [ ] **Step 2: Run, expect FAIL**:
  `cd web && pnpm vitest run src/find/pageText.test.ts`

- [ ] **Step 3: Implement** `pageText.ts` (`// pattern: Imperative Shell`)
  with a `TreeWalker` over `NodeFilter.SHOW_TEXT` per root. A text node's
  group key is `parent.closest(".block-row") ?? parent`; start a new group
  whenever the key element changes from the previous node's. Reject a node
  whose parent is inside `textarea, input, script, style, noscript`, or
  whose parent's `checkVisibility?.()` returns `false`.

- [ ] **Step 4: Run, expect PASS**, same command.

- [ ] **Step 5: Commit** both files:
  `"find: collect searchable page text and ranges (pkm-06os)"`.

### Task 3: FindBar component, wiring, styles, docs

**Files:**
- Create: `web/src/find/FindBar.tsx`
- Test: `web/src/find/FindBar.test.tsx`
- Modify: `web/src/App.tsx` (render `<FindBar />` beside `<UndoRedoKeys />`
  inside `.app`)
- Modify: `web/src/styles.css` (bar styles, tokens, `::highlight` rules)
- Modify: `docs/keyboard.md`, `docs/architecture/frontend.md`,
  `docs/architecture/styling.md`

**Interfaces:**
- Consumes: Task 1's `findMatches`, `stepIndex`, `clampIndex`,
  `findCommand`; Task 2's `FIND_ROOTS_SELECTOR`, `collectPageText`,
  `matchRange`.
- Produces: `export function FindBar(): JSX.Element | null` (no props).

Behaviour the tests pin (spec § Goals, § Decided, § Builder's calls):

- A `keydown` listener on `window` in the capture phase. It acts only when
  `findCommand(e)` is non-null **and** standalone matches; then it calls
  `preventDefault()`.
- `open`: remember `document.activeElement`; if it is a
  `textarea.block-input`, also remember its `closest("[data-uid]")` uid and
  the root (`closest(FIND_ROOTS_SELECTOR)`) it sits in. Prefill the query
  from the selection: a textarea's `value.slice(selectionStart,
  selectionEnd)`, else `window.getSelection()?.toString()`; use it only if
  non-empty and without a newline, otherwise keep the previous query. Show
  the bar, focus the input, select its text. Cmd-F while open re-focuses
  and re-selects.
- `next`/`prev` while closed: open as above, then step. While open: step.
- Enter / Shift-Enter in the input: next / prev. Escape in the input:
  `stopPropagation()` and `preventDefault()`, close, then restore focus:
  the remembered element if still `isConnected`, else (a block textarea
  that unmounted on blur) click
  `root.querySelector('[data-uid="<uid>"] > .block-text')` if present.
- Matches are recomputed when the query changes and, while open, on any
  `MutationObserver` record (`subtree`, `childList`, `characterData`)
  under the roots, coalesced to one recompute per animation frame; the
  index is `clampIndex`ed on recompute and reset to `null`→first match on
  a query change.
- When `globalThis.CSS?.highlights` and `Highlight` exist: set `pkm-find`
  to all match ranges and `pkm-find-current` to the current one; delete
  both on close and unmount. Without them, count and scroll still work.
- Stepping scrolls the current match's
  `startContainer.parentElement` into view with `{ block: "nearest" }`.
- Markup: `<div className="find-bar" role="search">` holding an
  `<input aria-label="Find on page">`, a count `<span aria-live="polite">`,
  buttons `aria-label`led "Previous match", "Next match", "Close find"
  (iPad touch has no Shift-Enter).

- [ ] **Step 1: Write the failing tests** in `FindBar.test.tsx`. A helper
  `standalone(on: boolean)` stubs `matchMedia` with
  `vi.fn((q: string) => new FakeMediaQueryList(on && q === "(display-mode: standalone)"))`
  (from `test-helpers.ts`). Render `<FindBar />` beside a
  `<main className="main-pane">` holding three block rows
  (`<div class="block-row" data-uid="b1"><div class="block-text">apple pie</div></div>`,
  `"apple tart"`, `"pear"`). Tests:
  - `does nothing outside the installed app`: with `standalone(false)`,
    `Meta+f` leaves no `role="search"` and does not `preventDefault`.
  - `Cmd-F opens the bar with the input focused`.
  - `prefills from the page selection`: select "pear" via a DOM `Range`
    on `window.getSelection()`, press Cmd-F, input value is `"pear"`,
    count reads `"1 of 1"`.
  - `counts and steps with Enter and Shift-Enter, wrapping`: type
    `apple` → `"1 of 2"`; Enter → `"2 of 2"`; Enter → `"1 of 2"`;
    Shift-Enter → `"2 of 2"`.
  - `Cmd-G and Shift-Cmd-G step when focus is outside the bar`.
  - `shows No matches`: query `zzz` → `"No matches"`.
  - `recounts when the searched DOM changes`: with `apple` at
    `"2 of 2"`, remove the second row; after an animation frame the count
    reads `"1 of 1"`.
  - `Escape closes and restores focus to the previous element`.
  - `Escape re-enters a block whose textarea went away`: focus a
    `<textarea class="block-input">` inside row `b1`, press Cmd-F, remove
    the textarea (as blur would), press Escape; a click spy on `b1`'s
    `.block-text` was called once.
  - `Escape in the bar does not reach document listeners`: a `keydown`
    listener on `document` added before the test sees no Escape.
  - `paints highlights when the API exists`: stub `globalThis.CSS` with
    `{ highlights: new Map() }` and a `Highlight` class recording its
    ranges; after typing `apple`, `pkm-find` holds 2 ranges and
    `pkm-find-current` 1; after Escape both keys are gone.

- [ ] **Step 2: Run, expect FAIL**:
  `cd web && pnpm vitest run src/find/FindBar.test.tsx`

- [ ] **Step 3: Implement** `FindBar.tsx` (`// pattern: Imperative Shell`)
  to the behaviour above, and render it in `App.tsx` after
  `<UndoRedoKeys />`.

- [ ] **Step 4: Styles** in `styles.css`: tokens `--color-find-match` and
  `--color-find-current` in each of the three theme blocks (light `:root`,
  the `prefers-color-scheme: dark` block, and `[data-theme="dark"]`),
  `::highlight(pkm-find)` and `::highlight(pkm-find-current)` using them,
  and `.find-bar` fixed top-right at
  `top: calc(var(--app-banner-height, 0px) + 8px)`, built from the existing
  control classes and radius tokens in `styling.md` § Controls rather than
  new ones. Run `pnpm vitest run src/styles.test.ts` to see whether it
  checks token parity across themes.

- [ ] **Step 5: Run, expect PASS**:
  `cd web && pnpm vitest run src/find src/App.test.tsx src/styles.test.ts`

- [ ] **Step 6: Docs.**
  - `docs/keyboard.md` "Anywhere in the app": `Cmd+F (installed app only)
    | Find on this page`; `Cmd+G / Shift+Cmd+G (installed app only) | Next /
    previous match`. A short "## Find on page" table: Enter / Shift+Enter
    next / previous, Escape close and return to where you were. User-facing
    wording, no rationale.
  - `docs/architecture/frontend.md`, the standalone-quirks table: a row
    "The installed app has no browser find | `FindBar` binds Cmd-F/Cmd-G
    only under `display-mode: standalone`, painting with the CSS Custom
    Highlight API so the DOM React owns is never wrapped |
    `find/FindBar.tsx`". Invoke the `architecture-docs` skill for this edit.
  - `docs/architecture/styling.md` § Tokens and theming: add `-find-*` to
    the colour-system list.

- [ ] **Step 7: Commit** the five source/test files and three docs:
  `"find: in-app find bar for the installed app (pkm-06os)"`.

### Task 4: End-to-end in Chromium

**Files:**
- Create: `web/e2e/find-in-page.spec.ts`

**Interfaces:**
- Consumes: Task 3's markup (`role="search"`, `aria-label="Find on page"`,
  the count span) and the `pkm-find` highlight name.

Standalone is forced with `page.addInitScript` wrapping
`window.matchMedia` so the query `(display-mode: standalone)` returns a
list whose `matches` is `true` and every other query passes through.
Import `test` from `./ownPage`; seed blocks with `POST /api/ops` creates on
the `ownPage.title` page (pattern in `reveal-collapsed.spec.ts::postOps`),
then reload. Use `E2E_PORT` per AGENTS.md when running alongside other
sessions.

- [ ] **Step 1: Write the specs:**
  - `Cmd-F finds and steps through matches`: blocks `alpha one`,
    `beta`, `alpha two`; `Meta+f`, type `alpha` → count `1 of 2` and
    `page.evaluate(() => CSS.highlights.get("pkm-find")?.size)` is `2`;
    `Meta+g` → `2 of 2`; `Meta+Shift+g` → `1 of 2`.
  - `searches a block that was being edited and Escape re-enters it`:
    click `alpha one`'s text to edit it, `Meta+f`, type `one` →
    `1 of 1`; `Escape` → the bar is gone and a `textarea.block-input` is
    focused with value `alpha one`.
  - `leaves Cmd-F to the browser outside the installed app`: a test
    without the init script; `Meta+f` shows no `role="search"`.

- [ ] **Step 2: Run, expect PASS**:
  `cd web && pnpm build && node tooling/runPlaywright.ts e2e/find-in-page.spec.ts`
  (a spec that fails alone but passes in the suite is a suspected product
  bug, per AGENTS.md).

- [ ] **Step 3: Full verification**:
  `cd web && set -o pipefail && pnpm verify`. Expected: exit 0.

- [ ] **Step 4: Commit** `web/e2e/find-in-page.spec.ts`:
  `"find: e2e for in-app find (pkm-06os)"`.
