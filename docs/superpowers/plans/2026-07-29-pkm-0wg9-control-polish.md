# Control Styling Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app's buttons, selects and inputs read as modern rather than blocky — pill-shaped actions, one field family modelled on the existing Cmd-U search, hover/focus feedback — without touching any behaviour.

**Architecture:** Pure CSS token work in `web/src/styles.css`, plus four one-line className additions in components so bespoke fields join the shared `.input-control` class instead of restating its colours, plus extraction of the top bar's search look into shared `.search-field*` classes that `/files` reuses. No new dependencies, no logic changes.

**Tech Stack:** Plain CSS (no preprocessor, no Tailwind), React 19 + TypeScript, Vitest + Testing Library for unit tests, Playwright for E2E. `web/src/styles.test.ts` is a **text-level drift guard**: it reads `styles.css` as a string and asserts declarations appear in named rules. It is the primary test surface for this plan.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-pkm-0wg9-control-polish-design.md`. Bean: `pkm-0wg9`.
- Plain CSS only. No new tokens beyond `--radius-pill`, `--radius-field`, `--color-error-fill`.
- `--radius-control` stays `4px`. Do not change it — `.inline-code`, `.block-row`, `.block-ref:hover`, `.math-error`, `.file-thumb` and `.file-badge` depend on it, and `styles.test.ts` asserts it.
- `.block-input` (the outline editor) must not gain a background or border. It is a writing surface, not a field.
- The top bar's search **behaviour** must not change: the 220px→320px focus growth, the `transition: width 0.15s`, the ⌘U hint chip, and the results dropdown all stay. The `kbd.top-bar-search-hint` must remain the input's immediate next sibling — `.top-bar-search-input:focus + .top-bar-search-hint` depends on it (pkm-absu).
- `.top-bar-search-input` keeps `outline: none` and gains **no** focus ring. Only `.input-control` carries the themed `:focus-visible` ring.
- Colours come from existing tokens only: `--color-bg-subtle`, `--color-bg-surface`, `--color-border`, `--color-border-strong`, `--color-border-input`, `--color-text`, `--color-text-secondary`, `--color-link`.
- Every task ends green. Run `cd web && pnpm vitest run src/styles.test.ts` at minimum; the final task runs `pnpm verify`.
- Commit at the end of every task. Do not squash tasks together.
- Run every command from the worktree root: `/Users/arthur/code/llm/pkm/.claude/worktrees/pkm-0wg9-control-polish`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `web/src/styles.css` | the whole stylesheet | tokens, button rules, field rules, search-field extraction, ghost-button radius |
| `web/src/styles.test.ts` | CSS drift guards | new assertions; two existing assertions move |
| `web/src/components/SearchBar.tsx` | Cmd-U search | compose shared `.search-field*` classes |
| `web/src/views/Files.tsx` | /files view | wrap search input in the shared search field, add `SearchIcon` |
| `web/src/views/Files.test.tsx` | /files unit tests | search input now asserts `search-field-input` |
| `web/src/components/SidebarNav.tsx` | sidebar | add `input-control` to the Add field |
| `web/src/assistant/AssistantPanel.tsx` | assistant panel | add `input-control` to the textarea and the model select |
| `web/src/components/Composer.tsx` | phone composer | add `input-control` to the textarea |

---

### Task 1: Radius tokens and pill buttons

**Files:**
- Modify: `web/src/styles.css` (`:root` block ~line 56; `.btn-secondary`/`.btn-danger` ~lines 204-214)
- Test: `web/src/styles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `--radius-pill` and `--radius-field` custom properties, used by every later task.

- [ ] **Step 1: Write the failing test**

Add this describe block to `web/src/styles.test.ts`, immediately **before** the existing `describe("typography hierarchy (pkm-b68q, pkm-ofec)"` block:

```ts
describe("control polish (pkm-0wg9)", () => {
  test("actions and fields have their own radius tokens", () => {
    const root = ruleFor(":root");
    expect(root).toContain("--radius-pill: 999px;");
    expect(root).toContain("--radius-field: 7px;");
    // unchanged: inline code, block rows, badges and thumbs still use it
    expect(root).toContain("--radius-control: 4px;");
  });

  test("buttons are pills with hover and focus feedback", () => {
    const btn = ruleFor(".btn-secondary");
    expect(btn).toContain("border-radius: var(--radius-pill);");
    expect(btn).toContain("padding: 5px 14px;");
    expect(btn).toContain("border: 1px solid var(--color-border);");
    expect(btn).toContain("transition:");
    expect(ruleFor(".btn-danger")).toContain("border-radius: var(--radius-pill);");
    expect(ruleFor(".btn-secondary:hover:not(:disabled)"))
      .toContain("border-color: var(--color-border-strong);");
    expect(ruleFor(".btn-secondary:focus-visible, .btn-danger:focus-visible"))
      .toContain("outline: 2px solid var(--color-link);");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/styles.test.ts -t "control polish"`
Expected: FAIL — first with `Missing CSS rule for .btn-secondary:focus-visible, .btn-danger:focus-visible`, and on `--radius-pill: 999px;` not found.

- [ ] **Step 3: Add the tokens**

In `web/src/styles.css`, find this block inside `:root`:

```css
  /* one radius scale for the whole chrome (pkm-9kye); not re-declared by
   * the dark blocks since geometry doesn't change with theme */
  --radius-control: 4px; /* buttons, inputs, inline code */
  --radius-card: 6px;    /* embedded content: code blocks, images, cards */
  --radius-panel: 8px;   /* floating menus, dropdowns, the main pane */
```

Replace it with:

```css
  /* one radius scale for the whole chrome (pkm-9kye); not re-declared by
   * the dark blocks since geometry doesn't change with theme */
  --radius-pill: 999px;  /* actions: buttons, ghost icon buttons, search fields */
  --radius-field: 7px;   /* text inputs, selects, textareas */
  --radius-control: 4px; /* inline code, block rows, badges, thumbs */
  --radius-card: 6px;    /* embedded content: code blocks, images, cards */
  --radius-panel: 8px;   /* floating menus, dropdowns, the main pane */
```

Note the `--radius-control` comment no longer claims buttons and inputs — they have their own tokens now.

- [ ] **Step 4: Make the buttons pills**

Find:

```css
.btn-secondary { background: var(--color-bg-subtle);
  border: 1px solid var(--color-border-input); border-radius: var(--radius-control);
  color: var(--color-text-secondary); cursor: pointer; padding: 4px 12px; }
.btn-secondary:hover:not(:disabled) { background: var(--color-selected-bg);
  color: var(--color-text); }
.btn-secondary:disabled { opacity: 0.35; cursor: default; }
/* destructive action (confirm dialogs, Files' Delete, ...) */
.btn-danger { background: var(--color-error); border: 1px solid var(--color-error);
  border-radius: var(--radius-control); color: #fff; cursor: pointer;
  padding: 4px 12px; }
.btn-danger:hover { opacity: 0.9; }
```

Replace with:

```css
.btn-secondary { background: var(--color-bg-subtle);
  border: 1px solid var(--color-border); border-radius: var(--radius-pill);
  color: var(--color-text-secondary); cursor: pointer; padding: 5px 14px;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease; }
.btn-secondary:hover:not(:disabled) { background: var(--color-selected-bg);
  border-color: var(--color-border-strong); color: var(--color-text); }
.btn-secondary:disabled { opacity: 0.35; cursor: default; }
/* destructive action (confirm dialogs, Files' Delete, ...) */
.btn-danger { background: var(--color-error); border: 1px solid var(--color-error);
  border-radius: var(--radius-pill); color: #fff; cursor: pointer;
  padding: 5px 14px;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease; }
.btn-danger:hover { opacity: 0.9; }
/* themed keyboard focus; without this Chrome paints its default blue ring,
 * which clashes with the palette (pkm-0wg9) */
.btn-secondary:focus-visible, .btn-danger:focus-visible {
  outline: 2px solid var(--color-link); outline-offset: 1px; }
```

- [ ] **Step 5: Update the two existing assertions this deliberately invalidates**

Three earlier assertions pin the button values you just changed. They are not
regressions — the design moves those declarations — so update them rather than
reverting the CSS.

In the `describe("visual consistency (pkm-9kye)"` block, find:

```ts
  test("secondary buttons share one style definition", () => {
    const btn = ruleFor(".btn-secondary");
    expect(btn).toContain("background: var(--color-bg-subtle);");
    expect(btn).toContain("border: 1px solid var(--color-border-input);");
    expect(btn).toContain("border-radius: var(--radius-control);");
```

Replace those three expectations with (leave the two `.show-more`/`.composer-send`
lines that follow them untouched):

```ts
  test("secondary buttons share one style definition", () => {
    const btn = ruleFor(".btn-secondary");
    expect(btn).toContain("background: var(--color-bg-subtle);");
    // border lightened and the radius became a pill in pkm-0wg9
    expect(btn).toContain("border: 1px solid var(--color-border);");
    expect(btn).toContain("border-radius: var(--radius-pill);");
```

In the `describe("form control tokens (pkm-mrru)"` block, find:

```ts
  test("the button tokens carry their own geometry, so bare call sites look right", () => {
    for (const selector of [".btn-secondary", ".btn-danger"]) {
      expect(ruleFor(selector)).toContain("padding: 4px 12px;");
    }
  });
```

Replace with:

```ts
  test("the button tokens carry their own geometry, so bare call sites look right", () => {
    for (const selector of [".btn-secondary", ".btn-danger"]) {
      // widened for the pill shape in pkm-0wg9
      expect(ruleFor(selector)).toContain("padding: 5px 14px;");
    }
  });
```

- [ ] **Step 6: Run the whole file to verify it passes**

Run: `cd web && pnpm vitest run src/styles.test.ts`
Expected: PASS — all 30+ tests. The pkm-9kye assertions that `--radius-control: 4px` and that `.inline-code` uses `var(--radius-control)` must still be green; if either fails you changed `--radius-control`, which this plan forbids.

- [ ] **Step 7: Commit**

```bash
git add web/src/styles.css web/src/styles.test.ts
git commit -m "feat(web): pill buttons with hover and themed focus ring (pkm-0wg9)"
```

---

### Task 2: Pill-shaped call sites that need adjusting

**Files:**
- Modify: `web/src/styles.css` (`.reference-link-button` ~line 541, `.assistant-input` block ~line 780, `.composer-send` inside the `@media (max-width: 600px)` block ~line 716)
- Test: `web/src/styles.test.ts`

**Interfaces:**
- Consumes: `--radius-pill` from Task 1.
- Produces: nothing later tasks depend on.

Two call sites are too tight to read as pills, and one stretches. `.assistant-input` is `display: flex` with the default `align-items: stretch`, so its Send button grows to the textarea's full height — as a pill that becomes a tall lozenge. `.composer` already sets `align-items: flex-end`, so it needs no such fix.

- [ ] **Step 1: Write the failing test**

Append these tests inside the `describe("control polish (pkm-0wg9)"` block from Task 1:

```ts
  test("compact pill call sites get enough horizontal room", () => {
    expect(ruleFor(".reference-link-button")).toContain("padding: 1px 10px;");
    expect(styles).toContain(".composer-send { padding: 6px 14px; }");
  });

  test("the assistant send button does not stretch into a lozenge", () => {
    expect(ruleFor(".assistant-input .btn-secondary"))
      .toContain("align-self: flex-end;");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/styles.test.ts -t "control polish"`
Expected: FAIL with `Missing CSS rule for .assistant-input .btn-secondary`.

- [ ] **Step 3: Widen the two compact call sites**

Find:

```css
.reference-link-button { flex-shrink: 0; font-size: 12px; padding: 1px 8px; }
```

Replace with:

```css
.reference-link-button { flex-shrink: 0; font-size: 12px; padding: 1px 10px; }
```

Find (inside the `@media (max-width: 600px)` block):

```css
  .composer-send { padding: 6px 12px; }
```

Replace with:

```css
  .composer-send { padding: 6px 14px; }
```

- [ ] **Step 4: Stop the assistant Send button stretching**

Find:

```css
.assistant-input textarea { flex: 1; resize: none; border: 1px solid var(--color-border-input); border-radius: var(--radius-control); padding: 6px 8px; background: inherit; color: inherit; font: inherit; }
```

Insert a new rule immediately **after** it:

```css
/* .assistant-input is a flex row with the default align-items: stretch, so
 * Send would grow to the textarea's height and the pill would read as a tall
 * lozenge (pkm-0wg9) */
.assistant-input .btn-secondary { align-self: flex-end; }
```

Leave the `textarea` rule itself alone for now — Task 4 rewrites it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web && pnpm vitest run src/styles.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/styles.css web/src/styles.test.ts
git commit -m "fix(web): give compact pills room and stop Send stretching (pkm-0wg9)"
```

---

### Task 3: A fill-only danger token

**Files:**
- Modify: `web/src/styles.css` (three theme blocks: `:root` ~line 46, the `@media (prefers-color-scheme: dark)` block's `:root:not([data-theme="light"])` ~line 102, and `:root[data-theme="dark"]` ~line 149; plus `.btn-danger`)
- Test: `web/src/styles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `--color-error-fill`.

`--color-error` is `#ff6b6b` in dark — tuned for error *text* on a dark background. As a solid button fill behind white text it reads as bright coral, and the pill shape amplifies it. Give the fill its own token and leave `--color-error` doing text.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("control polish (pkm-0wg9)"` block:

```ts
  test("the danger button fills with a token tuned for fills, not text", () => {
    const danger = ruleFor(".btn-danger");
    expect(danger).toContain("background: var(--color-error-fill);");
    expect(danger).toContain("border: 1px solid var(--color-error-fill);");
    // light keeps today's red; dark gets a deep red instead of coral
    expect(ruleFor(":root")).toContain("--color-error-fill: #c23030;");
    expect(ruleFor(':root:not([data-theme="light"])'))
      .toContain("--color-error-fill: #a83a3a;");
    expect(ruleFor(':root[data-theme="dark"]'))
      .toContain("--color-error-fill: #a83a3a;");
    // --color-error keeps its own job: error text and the failed badge
    expect(ruleFor(".error")).toContain("color: var(--color-error);");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/styles.test.ts -t "danger button"`
Expected: FAIL — `.btn-danger` does not contain `background: var(--color-error-fill);`.

- [ ] **Step 3: Add the token to all three theme blocks**

In the base `:root`, find:

```css
  --color-error: #c23030;
```

Replace with:

```css
  --color-error: #c23030;
  /* solid-fill variant of --color-error. The dark --color-error is tuned for
   * error *text* on a dark background; as a button fill behind white text it
   * reads as bright coral, which the pill shape amplifies (pkm-0wg9). */
  --color-error-fill: #c23030;
```

In the dark media block, find the line inside `:root:not([data-theme="light"])`:

```css
    --color-error: #ff6b6b;
```

Replace with:

```css
    --color-error: #ff6b6b;
    --color-error-fill: #a83a3a;
```

In the explicit `:root[data-theme="dark"]` block, find:

```css
  --color-error: #ff6b6b;
```

Replace with:

```css
  --color-error: #ff6b6b;
  --color-error-fill: #a83a3a;
```

Note the two dark blocks use different indentation (4 spaces inside the media query, 2 spaces in the `[data-theme]` block). Match the surrounding lines exactly.

- [ ] **Step 4: Point `.btn-danger` at the new token**

Find:

```css
.btn-danger { background: var(--color-error); border: 1px solid var(--color-error);
  border-radius: var(--radius-pill); color: #fff; cursor: pointer;
  padding: 5px 14px;
```

Replace with:

```css
.btn-danger { background: var(--color-error-fill);
  border: 1px solid var(--color-error-fill);
  border-radius: var(--radius-pill); color: #fff; cursor: pointer;
  padding: 5px 14px;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web && pnpm vitest run src/styles.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/styles.css web/src/styles.test.ts
git commit -m "feat(web): fill-only --color-error-fill so dark Delete is not coral (pkm-0wg9)"
```

---

### Task 4: One field family

**Files:**
- Modify: `web/src/styles.css` (`.input-control` block ~line 215; `.nav-sidebar-add input` ~line 276; `.assistant-input textarea` ~line 780; `.composer textarea` inside the `@media (max-width: 600px)` block ~line 712)
- Modify: `web/src/components/SidebarNav.tsx:158`, `web/src/assistant/AssistantPanel.tsx:138`, `web/src/components/Composer.tsx:70`
- Test: `web/src/styles.test.ts`

**Interfaces:**
- Consumes: `--radius-field` from Task 1.
- Produces: `.input-control` as the one field class, applied by className rather than duplicated per-context in CSS. Task 5 groups `.search-field-input` into its colour declarations.

Three fields currently restate the same colours in their own rules. Instead of a CSS selector list, they take the `input-control` class in markup — the same lesson as pkm-mrru, one layer up. Their CSS rules keep only layout.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("control polish (pkm-0wg9)"` block:

```ts
  test("fields share one look, modelled on the Cmd-U search", () => {
    // one grouped rule so the two searches cannot drift apart; each class then
    // adds its own geometry
    const field = ruleFor(".input-control, .search-field-input");
    expect(field).toContain("background: var(--color-bg-subtle);");
    expect(field).toContain("border: 1px solid var(--color-border-strong);");
    expect(field).toContain("transition:");
    const focus = ruleFor(".input-control:focus, .search-field-input:focus");
    expect(focus).toContain("background: var(--color-bg-surface);");
    expect(focus).toContain("border-color: var(--color-border-input);");
    expect(ruleFor(".input-control"))
      .toContain("border-radius: var(--radius-field);");
  });

  test("bespoke field rules keep layout only, not colours", () => {
    for (const selector of [".nav-sidebar-add input",
                            ".assistant-input textarea"]) {
      const rule = ruleFor(selector);
      expect(rule).not.toContain("background:");
      expect(rule).not.toContain("border:");
      expect(rule).not.toContain("border-radius:");
    }
    expect(ruleFor(".composer textarea")).not.toContain("border:");
  });

  // the outline editor is a writing surface, not a form field
  test("the block editor gains no field chrome", () => {
    const editor = ruleFor(".block-input");
    expect(editor).not.toContain("background: var(--color-bg-subtle);");
    expect(editor).not.toContain("border: 1px solid");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/styles.test.ts -t "field"`
Expected: FAIL with `Missing CSS rule for .input-control, .search-field-input` — the grouped rule does not exist yet.

- [ ] **Step 3: Rewrite the field rule**

Find:

```css
/* the input counterpart of .btn-secondary (pkm-mrru): text/search/date inputs
 * and selects. There is no base input/select rule -- a blanket one would hit
 * checkboxes and the outline's own editors -- so form controls opt in by
 * class, the way buttons do. */
.input-control { font: inherit; padding: 4px 8px;
  border: 1px solid var(--color-border-input); border-radius: var(--radius-control);
  background: var(--color-bg); color: var(--color-text); }
.input-control::placeholder { color: var(--color-text-secondary); }
.input-control:focus-visible { outline: 2px solid var(--color-link);
  outline-offset: 1px; }
```

Replace with:

```css
/* the input counterpart of .btn-secondary (pkm-mrru): text/search/date inputs,
 * selects and textareas. There is no base input/select rule -- a blanket one
 * would hit checkboxes and the outline's own editors -- so form controls opt in
 * by class, the way buttons do. The look is modelled on the Cmd-U search so
 * every field in the app is the same object (pkm-0wg9); .block-input is
 * deliberately excluded, it is a writing surface not a field.
 * .search-field-input shares the colours here and takes its pill geometry in
 * the search-field block further down. */
.input-control, .search-field-input { font: inherit; color: var(--color-text);
  border: 1px solid var(--color-border-strong);
  background: var(--color-bg-subtle);
  transition: background 0.12s ease, border-color 0.12s ease; }
.input-control::placeholder, .search-field-input::placeholder {
  color: var(--color-text-secondary); }
.input-control:focus, .search-field-input:focus {
  background: var(--color-bg-surface);
  border-color: var(--color-border-input); }
.input-control { padding: 5px 9px; border-radius: var(--radius-field); }
/* the ring is .input-control's only: the top-bar search signals focus by
 * widening and keeps outline: none */
.input-control:focus-visible { outline: 2px solid var(--color-link);
  outline-offset: 1px; }
```

`.search-field-input` is named here before any element uses it — Task 5 adds its
geometry and Task 5/6 add the markup. A class with no elements is harmless, and
grouping now means no assertion has to be rewritten later.

- [ ] **Step 4: Strip the duplicated colours from the three bespoke rules**

Find:

```css
.nav-sidebar-add input { font: inherit; padding: 4px 6px; border: 1px solid var(--color-border-input);
  border-radius: var(--radius-control); background: var(--color-bg); color: var(--color-text); }
```

Replace with (layout only — the colours now come from `.input-control`):

```css
.nav-sidebar-add input { padding: 4px 6px; }
```

Find:

```css
.assistant-input textarea { flex: 1; resize: none; border: 1px solid var(--color-border-input); border-radius: var(--radius-control); padding: 6px 8px; background: inherit; color: inherit; font: inherit; }
```

Replace with:

```css
.assistant-input textarea { flex: 1; resize: none; padding: 6px 8px; }
```

Find (inside the `@media (max-width: 600px)` block):

```css
  .composer textarea { width: 100%; font: inherit; resize: none;
    border: 1px solid var(--color-border-input); border-radius: var(--radius-control); padding: 6px 8px;
    background: var(--color-bg-surface); color: var(--color-text); }
```

Replace with:

```css
  .composer textarea { width: 100%; resize: none; padding: 6px 8px; }
```

- [ ] **Step 5: Add the class in the three components**

`web/src/components/SidebarNav.tsx` — find:

```tsx
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
                 disabled={busy} placeholder="Add page…" aria-label="New sidebar entry title" />
```

Replace with:

```tsx
          <input className="input-control" value={newTitle}
                 onChange={(e) => setNewTitle(e.target.value)}
                 disabled={busy} placeholder="Add page…" aria-label="New sidebar entry title" />
```

`web/src/assistant/AssistantPanel.tsx` — find:

```tsx
        <textarea
          placeholder="Ask about your notes…"
```

Replace with:

```tsx
        <textarea
          className="input-control"
          placeholder="Ask about your notes…"
```

`web/src/components/Composer.tsx` — find:

```tsx
        <textarea ref={taRef} aria-label="Add to this page" rows={1}
```

Replace with:

```tsx
        <textarea ref={taRef} className="input-control"
                  aria-label="Add to this page" rows={1}
```

- [ ] **Step 6: Update the pkm-mrru field assertion this invalidates**

In the `describe("form control tokens (pkm-mrru)"` block, find:

```ts
  test("text inputs and selects share one .input-control style", () => {
    const input = ruleFor(".input-control");
    expect(input).toContain("font: inherit;");
    expect(input).toContain("padding: 4px 8px;");
    expect(input).toContain("border: 1px solid var(--color-border-input);");
    expect(input).toContain("border-radius: var(--radius-control);");
    expect(input).toContain("background: var(--color-bg);");
    expect(input).toContain("color: var(--color-text);");
  });
```

Replace with (the field look moved to the Cmd-U search's values in pkm-0wg9;
the new assertions in the pkm-0wg9 block now cover the colours, so this test
keeps only what is still true here):

```ts
  test("text inputs and selects share one .input-control style", () => {
    // colours live in the grouped rule shared with .search-field-input
    // (pkm-0wg9); this class keeps its own geometry
    const shared = ruleFor(".input-control, .search-field-input");
    expect(shared).toContain("font: inherit;");
    expect(shared).toContain("color: var(--color-text);");
    const input = ruleFor(".input-control");
    expect(input).toContain("padding: 5px 9px;");
    expect(input).toContain("border-radius: var(--radius-field);");
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/styles.test.ts src/components src/assistant src/views`
Expected: PASS. If a component test asserts on a textarea's className, add `input-control` to its expectation rather than removing the class.

- [ ] **Step 8: Commit**

```bash
git add web/src/styles.css web/src/styles.test.ts web/src/components/SidebarNav.tsx web/src/assistant/AssistantPanel.tsx web/src/components/Composer.tsx
git commit -m "feat(web): one field family modelled on the Cmd-U search (pkm-0wg9)"
```

---

### Task 5: Extract the search field

**Files:**
- Modify: `web/src/styles.css` (`.top-bar-search`, `.top-bar-search-icon`, `.top-bar-search-input` and its `:focus`/`::placeholder` ~lines 342-353)
- Modify: `web/src/components/SearchBar.tsx:184-186`
- Test: `web/src/styles.test.ts`

**Interfaces:**
- Consumes: `--radius-pill` from Task 1, the field colours from Task 4.
- Produces: `.search-field` (relative wrapper), `.search-field-icon` (absolutely-positioned magnifier), `.search-field-input` (pill input). Task 6 uses all three.

The top bar's search is the reference look, but it lives entirely in `.top-bar-search*` rules so `/files` cannot reuse it. Split the reusable part out; the top bar keeps only its width behaviour.

**This task moves two declarations that existing tests assert.** `styles.test.ts` currently asserts `.top-bar-search-input` contains `border-radius: 999px;` (in the pkm-absu block). The pill now comes from `.search-field-input`, so that assertion moves. Update it — do not add the radius back to keep an old test green.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("control polish (pkm-0wg9)"` block:

```ts
  test("the search field look is shared, not duplicated per call site", () => {
    expect(ruleFor(".search-field")).toContain("position: relative;");
    expect(ruleFor(".search-field-icon")).toContain("position: absolute;");
    const input = ruleFor(".search-field-input");
    expect(input).toContain("border-radius: var(--radius-pill);");
    expect(input).toContain("padding: 4px 12px 4px 30px;");
    // both searches share the field colours
    expect(styles).toContain(".input-control, .search-field-input {");
  });

  test("the top bar keeps only its own width behaviour", () => {
    const topBar = ruleFor(".top-bar-search-input");
    expect(topBar).toContain("width: 220px;");
    expect(topBar).toContain("transition: width 0.15s");
    expect(topBar).not.toContain("border-radius:");
    expect(ruleFor(".top-bar-search-input:focus")).toContain("width: 320px;");
    // pkm-absu: the hint chip hides via an adjacent-sibling selector, so the
    // kbd must stay immediately after the input
    expect(styles).toContain(".top-bar-search-input:focus + .top-bar-search-hint,");
  });
```

Then update the existing pkm-absu assertion. Find:

```ts
  test("the search input is a rounded pill", () => {
    expect(ruleFor(".top-bar-search-input")).toContain("border-radius: 999px;");
  });
```

Replace with:

```ts
  // the pill moved to the shared .search-field-input class (pkm-0wg9) so the
  // /files search is the same object, not a lookalike
  test("the search input is a rounded pill", () => {
    expect(ruleFor(".search-field-input"))
      .toContain("border-radius: var(--radius-pill);");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/styles.test.ts`
Expected: FAIL with `Missing CSS rule for .search-field`.

- [ ] **Step 3: Extract the search-field rules**

Task 4 already grouped `.search-field-input` into the field colours, so nothing
in that block needs touching here — only its geometry and the top bar remain.

Find:

```css
.top-bar-search { position: relative; }
.top-bar-search-icon { position: absolute; left: 9px; top: 50%;
  transform: translateY(-50%); display: flex; pointer-events: none;
  color: var(--color-text-secondary); }
.top-bar-search-input { width: 220px; box-sizing: border-box; padding: 4px 44px 4px 30px;
  border: 1px solid var(--color-border-strong); border-radius: 999px;
  background: var(--color-bg-subtle); color: var(--color-text);
  font-size: 14px; outline: none; transition: width 0.15s; }
.top-bar-search-input::placeholder { color: var(--color-text-secondary); }
.top-bar-search-input:focus { width: 320px; background: var(--color-bg-surface);
  border-color: var(--color-border-input); }
```

Replace with:

```css
/* the search field, shared by the Cmd-U search and /files (pkm-0wg9): one
 * object, so the two cannot drift apart. Colours come from the field group
 * above; the icon sits inside the pill's left padding. */
.search-field { position: relative; display: flex; }
.search-field-icon { position: absolute; left: 9px; top: 50%;
  transform: translateY(-50%); display: flex; pointer-events: none;
  color: var(--color-text-secondary); }
.search-field-input { width: 100%; box-sizing: border-box;
  padding: 4px 12px 4px 30px; border-radius: var(--radius-pill);
  font-size: 14px; outline: none; }
/* top-bar-only: the width growth on focus, and room on the right for the ⌘U
 * hint chip. Everything else is .search-field-input. */
.top-bar-search-input { width: 220px; padding-right: 44px;
  transition: width 0.15s, background 0.12s ease, border-color 0.12s ease; }
.top-bar-search-input:focus { width: 320px; }
```

`.top-bar-search-input` must keep `width: 220px` **after** `.search-field-input`'s `width: 100%` in source order so it wins — the replacement above already does that.

- [ ] **Step 4: Compose the classes in SearchBar**

`web/src/components/SearchBar.tsx` — find:

```tsx
    <div className="top-bar-search" ref={wrapRef}>
      <span className="top-bar-search-icon"><SearchIcon /></span>
      <input ref={inputRef} className="top-bar-search-input" placeholder="Search…"
```

Replace with:

```tsx
    <div className="search-field top-bar-search" ref={wrapRef}>
      <span className="search-field-icon"><SearchIcon /></span>
      <input ref={inputRef} className="search-field-input top-bar-search-input"
             placeholder="Search…"
```

Do **not** reorder anything else in this component. The `<kbd className="top-bar-search-hint">` must stay the input's immediate next sibling.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/styles.test.ts src/components/TopBar.test.tsx src/components/SearchBar`
Expected: PASS. `TopBar.test.tsx` references `top-bar-search` — it should still pass because that class is still present on the wrapper. If it queries `.top-bar-search-icon`, update the selector to `.search-field-icon`.

- [ ] **Step 6: Commit**

```bash
git add web/src/styles.css web/src/styles.test.ts web/src/components/SearchBar.tsx
git commit -m "refactor(web): extract the shared .search-field look from the top bar (pkm-0wg9)"
```

---

### Task 6: /files reuses the search field

**Files:**
- Modify: `web/src/views/Files.tsx:224-227` (the search input) and its import block
- Modify: `web/src/styles.css` (`.files-search` ~line 763)
- Test: `web/src/views/Files.test.tsx`

**Interfaces:**
- Consumes: `.search-field`, `.search-field-icon`, `.search-field-input` from Task 5; `SearchIcon` from `web/src/components/icons.tsx` (already an exported component, no props).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

In `web/src/views/Files.test.tsx`, find the test added by pkm-mrru:

```tsx
  it("styles the filter widgets with the shared input token (pkm-mrru)",
     async () => {
    render(<Files />);
    await screen.findByText(/no files match/i);
    for (const name of ["Search files", "Type", "From", "To", "Linked"]) {
      expect(screen.getByLabelText(name)).toHaveClass("input-control");
    }
  });
```

Replace it with:

```tsx
  it("styles the filter widgets with the shared tokens (pkm-mrru, pkm-0wg9)",
     async () => {
    render(<Files />);
    await screen.findByText(/no files match/i);
    for (const name of ["Type", "From", "To", "Linked"]) {
      expect(screen.getByLabelText(name)).toHaveClass("input-control");
    }
    // the search box is the same object as the Cmd-U search, icon and all
    const search = screen.getByLabelText("Search files");
    expect(search).toHaveClass("search-field-input");
    expect(search.closest(".search-field")).not.toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/views/Files.test.tsx -t "shared tokens"`
Expected: FAIL — the element has class `input-control files-search`, not `search-field-input`.

- [ ] **Step 3: Wrap the search input**

In `web/src/views/Files.tsx`, add the icon import next to the existing component imports:

```tsx
import { SearchIcon } from "../components/icons";
```

Then find:

```tsx
        <input type="search" className="input-control files-search"
               value={filters.q} placeholder="Search files"
               aria-label="Search files"
               onChange={(e) => update({ q: e.target.value })} />
```

Replace with:

```tsx
        <div className="search-field files-search">
          <span className="search-field-icon"><SearchIcon /></span>
          <input type="search" className="search-field-input"
                 value={filters.q} placeholder="Search files"
                 aria-label="Search files"
                 onChange={(e) => update({ q: e.target.value })} />
        </div>
```

- [ ] **Step 4: Move the sizing onto the wrapper**

`.files-search` is now the wrapper, which is the flex item of `.files-filters`. Find:

```css
.files-search { flex: 1 1 200px; max-width: 320px; }
```

It needs no change — the same declarations apply, now to the wrapper. Confirm it reads exactly as above; if an earlier task altered it, restore it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/views/Files.test.tsx`
Expected: PASS, all 15 tests. The `passes filters to the search request` test drives this input by label and must still work.

- [ ] **Step 6: Commit**

```bash
git add web/src/views/Files.tsx web/src/views/Files.test.tsx web/src/styles.css
git commit -m "feat(web): /files search is the same field as the Cmd-U search (pkm-0wg9)"
```

---

### Task 7: Ghost buttons and the assistant's model select

**Files:**
- Modify: `web/src/styles.css` (the `.top-bar-menu-button, .sidebar-toggle-button, .help-button` rule ~line 333)
- Modify: `web/src/assistant/AssistantPanel.tsx:89`
- Test: `web/src/styles.test.ts`

**Interfaces:**
- Consumes: `--radius-pill` from Task 1, `.input-control` from Task 4.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("control polish (pkm-0wg9)"` block:

```ts
  test("ghost icon buttons get a round hover chip", () => {
    const ghost = ruleFor(
      ".top-bar-menu-button, .sidebar-toggle-button, .help-button");
    expect(ghost).toContain("border-radius: var(--radius-pill);");
    // pkm-absu: transparent border, not none, so hover doesn't shift layout
    expect(ghost).toContain("border: 1px solid transparent;");
  });
```

And add this to the existing `describe("AssistantPanel"` block in
`web/src/assistant/AssistantPanel.test.tsx`. That file already mocks
`useAssistant` via a hoisted `state` object and renders with `open`, so no new
fixture is needed:

```tsx
  test("the model select is styled as a field (pkm-0wg9)", () => {
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByLabelText(/model/i)).toHaveClass("input-control");
  });
```

`getByLabelText(/model/i)` is the same query the existing "model select is
disabled" test uses, so it is known to resolve to the `<select>`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/styles.test.ts -t "ghost icon"`
Expected: FAIL — the rule does not contain `border-radius: var(--radius-pill);`.

- [ ] **Step 3: Round the ghost buttons**

Find:

```css
.top-bar-menu-button, .sidebar-toggle-button, .help-button { display: flex; align-items: center;
  background: none; cursor: pointer; border: 1px solid transparent;
  border-radius: var(--radius-control); padding: 5px 8px; color: var(--color-text-secondary); }
```

Replace with:

```css
.top-bar-menu-button, .sidebar-toggle-button, .help-button { display: flex; align-items: center;
  background: none; cursor: pointer; border: 1px solid transparent;
  border-radius: var(--radius-pill); padding: 5px 8px; color: var(--color-text-secondary); }
```

- [ ] **Step 4: Give the model select the field class**

`web/src/assistant/AssistantPanel.tsx` — find:

```tsx
          <select
            value={assistant.model}
```

Replace with:

```tsx
          <select
            className="input-control"
            value={assistant.model}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && pnpm vitest run src/styles.test.ts src/assistant`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/styles.css web/src/styles.test.ts web/src/assistant/
git commit -m "feat(web): round ghost buttons, model select joins the field family (pkm-0wg9)"
```

---

### Task 8: Verify against the running app, then close the bean

**Files:**
- Modify: `.beans/pkm-0wg9--*.md`
- No source changes expected. If verification finds a problem, fix it here with its own test and commit.

**Interfaces:**
- Consumes: everything above.
- Produces: a green `pnpm verify` and a completed bean.

- [ ] **Step 1: Run the full suite**

Run: `cd web && pnpm verify`
Expected: PASS — typecheck, unit coverage, lint, FCIS, budgets, and 46 Playwright E2E specs. Nothing in this plan changes behaviour, so any E2E failure is a real regression: investigate before proceeding.

If port 8975 is in use, a scratch server is still running from an earlier session — stop it first, Playwright's webServer needs that port.

- [ ] **Step 2: Build and launch a scratch server**

Follow `.claude/skills/verify`. Summary:

```bash
cd web && pnpm build
SC="$(mktemp -d -t pkm-0wg9)"   # any disposable dir outside the repo
cd ../server && uv run python -m pkm.server.setup --data-dir "$SC" \
  --password testpw --insecure-cookie --web-dist ../web/dist
# then patch $SC/config.json so web_dist is the absolute path to web/dist
uv run python -m pkm.server.run --data-dir "$SC" --port 8976 --host 127.0.0.1
```

Upload a few assets so `/files` has cards — POST each to `/api/assets` with a
session cookie from `POST /api/login`. Assets are content-addressed, so
identical bytes dedupe to one row: vary the pixels to get distinct cards.

- [ ] **Step 3: Check every surface in both themes**

Drive with agent-browser. Before each screenshot after a rebuild, unregister the
service worker **and** clear its caches, or you will screenshot a stale bundle:

```js
(async () => {
  const rs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(rs.map(r => r.unregister()));
  const ks = await caches.keys();
  await Promise.all(ks.map(k => caches.delete(k)));
})()
```

Note `agent-browser set media <light|dark>` reloads the page, so set the theme
before injecting or asserting anything.

Confirm, in light and dark:

- `/files` — the filter search and the top-bar search are visually identical (pill, magnifier, same fill and border); toolbar buttons are pills; select a file and check Delete is a deep red, not coral; open the delete confirm and check Cancel/Delete files still read correctly.
- Sidebar "Edit" — the up/down/remove buttons are circles; the "Add page…" field matches the other fields.
- Assistant panel — Send is a pill, not a tall lozenge; the model select looks like a field; the textarea matches.
- An outline page with backlinks — "Show more", the linked-refs filter toggle, and an unlinked reference's "Link" button all read as pills.
- Top bar — ghost buttons have a round hover chip; the search still grows on focus and the ⌘U chip still hides when focused.
- Tab through the `/files` toolbar — the focus ring is the app's link colour, not Chrome's blue.
- Narrow the viewport to 375px wide and confirm the `/files` toolbar wraps sanely with the wider button padding.

- [ ] **Step 4: Clean up the scratch environment**

```bash
agent-browser --session <name> close
pkill -f "pkm.server.run --data-dir $SC"
rm -rf "$SC"
```

- [ ] **Step 5: Update and complete the bean**

Run `beans show pkm-0wg9` first, then `beans update pkm-0wg9 -s completed --body "..."`
passing the original description with its todos checked plus a
`## Summary of Changes` section recording all five of these:

1. `--radius-pill: 999px` and `--radius-field: 7px` added; `--radius-control`
   stayed 4px because `.inline-code`, `.block-row`, `.block-ref:hover`,
   `.math-error`, `.file-thumb` and `.file-badge` share it.
2. `--color-error` is text-only; `--color-error-fill` is the button fill, deep
   red in dark because the text-tuned `#ff6b6b` reads as coral behind white.
3. The search look is one shared `.search-field*` class group that the top bar
   and `/files` both compose — not two lookalikes that can drift.
4. Fields joined `.input-control` by className instead of restating its colours
   per context (`.nav-sidebar-add input`, `.assistant-input textarea`,
   `.composer textarea`, the assistant's model select).
5. `.block-input` is deliberately excluded and a test guards that.

- [ ] **Step 6: Commit**

```bash
git add .beans/
git commit -m "chore(beans): complete pkm-0wg9 control styling polish"
```

---

## Notes for the implementer

- `styles.test.ts`'s `ruleFor(selector)` regex-matches `selector { ... }` and returns the **first** match's body. It escapes regex metacharacters, so `ruleFor(':root[data-theme="dark"]')` works. It throws `Missing CSS rule for <selector>` when the rule does not exist — that is the expected failure mode for a new rule.
- Because `ruleFor` returns only the first match, keep one rule per selector. Do not add a second `.btn-secondary { }` block later in the file.
- CSS specificity matters throughout: several call sites override the token padding, and they win either by later source order (equal specificity) or higher specificity. If a button looks wrong after Task 1, check for an override rather than adding `!important` — the codebase has none and should stay that way.
- Do not add `padding` back to `.show-more`; pkm-mrru deliberately moved it into `.btn-secondary` and a test asserts its absence.
