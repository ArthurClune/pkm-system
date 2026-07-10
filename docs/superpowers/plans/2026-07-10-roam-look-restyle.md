# Roam-look Restyle Implementation Plan (pkm-n2kv)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the web app to the user's Roam look — warm grey-blue canvas, white content card, orange page links, purple external links, muted tags, disc bullets — in both light and dark themes, with no behavioural changes.

**Architecture:** Almost everything is token/rule edits in `web/src/styles.css` (the app's single plain-CSS file, already token-based with three theme blocks). The only markup change is the bullet span in the two outline renderers, which gains a `closed` class and loses its `•` text.

**Tech Stack:** Plain CSS custom properties, React + TypeScript, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-10-roam-look-restyle-design.md`

## Global Constraints

- Work on branch `bean/pkm-n2kv` (create from `main`; use a worktree if the main checkout is busy).
- Plain CSS only — no preprocessor, no new dependencies.
- `styles.css` has THREE theme blocks: `:root` (light), `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`, and `:root[data-theme="dark"]`. The two dark blocks MUST stay identical to each other — every dark edit is made twice.
- No behavioural changes: drag-and-drop, collapse, focus, navigation all keep working; component files keep their existing `// pattern:` headers.
- After every commit, push (`git push -u origin bean/pkm-n2kv` the first time).
- Verification commands: `cd web && pnpm test -- --run` and `cd web && pnpm typecheck`.

---

### Task 1: Palette tokens + link/tag/selection colours

**Files:**
- Modify: `web/src/styles.css:17-58` (light tokens), `:60-100` and `:102-140` (dark blocks), `:153-155` (anchors), `:234-235` (tags), `:243-244` (block-ref token usage untouched here)

**Interfaces:**
- Produces: new tokens `--color-link`, `--color-link-ext`, `--color-tag`, `--color-bullet`, `--color-bullet-ring`, `--color-selection-bg` — consumed by Tasks 4 and 5. Token `--color-ref-dashed` is REMOVED (Task 5 removes its last consumer; this task removes the token and temporarily inlines nothing — see Step 1 note).

- [ ] **Step 1: Edit the light `:root` block**

Replace the non-hljs part of `:root` (styles.css lines 17–39) with:

```css
:root {
  --color-bg: #f8f9fb;
  --color-bg-subtle: #f2f5f8;
  --color-bg-surface: #ffffff;
  --color-bg-sidebar: #fbfcfd;
  --color-border: #dbe4e8;
  --color-border-subtle: #e9eef2;
  --color-border-strong: #c8d5dc;
  --color-border-input: #c8d5dc;
  --color-text: #3f4758;
  --color-text-muted: #7086a9;
  --color-text-faint: #a3b2c9;
  --color-text-secondary: #5d6f8f;
  --color-accent: #ec6f35;
  --color-link: #ec6f35;
  --color-link-ext: #7056f2;
  --color-tag: #9dafca;
  --color-bullet: #e3ecf2;
  --color-bullet-ring: #d8e5ee;
  --color-error: #c23030;
  --color-highlight-bg: #fcc1786d;
  --color-selection-bg: #fcc1786d;
  --color-selected-bg: #ebf1f5;
  --color-focus-bg: #faf3ec;
  --color-ac-selected-bg: #eef4f8;
  --color-ref-dashed: #b3c2ce;
  --color-banner-bg: #bf7326;
  --color-banner-text: #ffffff;
  --shadow-rgb: 63, 71, 88;
```

(hljs vars below stay as they are. `--color-ref-dashed` survives until Task 5 deletes its consumer; Task 5 then deletes the token from all three blocks.)

- [ ] **Step 2: Edit BOTH dark blocks identically**

In `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {...} }` AND `:root[data-theme="dark"] {...}`, keep all existing neutral values (`--color-bg*`, `--color-border*`, `--color-text*`, error, banner, selected/ac backgrounds, `--shadow-rgb`, hljs) and change/add ONLY these lines in each block:

```css
    --color-accent: #ff9d5c;
    --color-link: #ff9d5c;
    --color-link-ext: #a394f8;
    --color-tag: #6f80a0;
    --color-bullet: #39434d;
    --color-bullet-ring: #4a5866;
    --color-highlight-bg: #ff913c48;
    --color-selection-bg: #ff913c55;
    --color-focus-bg: #2a251f;
```

- [ ] **Step 3: Rewire anchors, tags, and selection**

Replace `a { color: var(--color-accent); text-decoration: none; }` (line 153) with:

```css
a { color: var(--color-link-ext); font-weight: 600; text-decoration: none; }
a.page-link { color: var(--color-link); }
a.tag { color: var(--color-tag); font-weight: 400; }
::selection { background: var(--color-selection-bg); }
```

Then update the existing `.tag` rules (lines 234–235): delete `.tag { color: var(--color-text-faint); }` (superseded by `a.tag` above) and change the hover to `.tag:hover { color: var(--color-link); }`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: PASS (CSS-only change; nothing asserts on colours).

- [ ] **Step 5: Commit and push**

```bash
git add web/src/styles.css
git commit -m "style: Roam palette tokens — orange links, purple external, muted tags (pkm-n2kv)"
git push -u origin bean/pkm-n2kv
```

---

### Task 2: Card layout for the main pane (resolves pkm-7cbq)

**Files:**
- Modify: `web/src/styles.css` — `.content-area`/`.main-pane` (lines 191–193), `.top-bar` (200–201), phone breakpoint block (346–358)

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces: `--pane-width` / `--pane-left` custom properties on `.content-area` (used by both `.top-bar` and `.main-pane`).

- [ ] **Step 1: Restyle the pane as a card**

Replace the `.content-area` and `.main-pane` rules with:

```css
.content-area { flex: 1; min-width: 0; display: flex; flex-direction: column;
  /* card geometry shared by .top-bar and .main-pane; --pane-left leans the
   * card left so the gutter is ~1/3 of what centering would give (pkm-7cbq) */
  --pane-width: min(860px, calc(100% - 32px));
  --pane-left: max(16px, calc((100% - 860px) / 6)); }
.main-pane { flex: 1; min-width: 0; width: var(--pane-width);
  margin: 10px auto 40px var(--pane-left);
  padding: 30px 50px 120px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
  box-shadow: 0 1px 3px rgba(var(--shadow-rgb), 0.05); }
```

Note: `%` inside these custom properties resolves at the point of use; both consumers are direct children of `.content-area`, so both resolve against the same container.

- [ ] **Step 2: Align the top bar with the card**

Replace the `.top-bar` rule (lines 200–201) with:

```css
.top-bar { display: flex; justify-content: flex-end; align-items: center; gap: 8px;
  width: var(--pane-width); margin: 0 auto 0 var(--pane-left); padding: 8px 4px; }
```

- [ ] **Step 3: Drop the card chrome on phones**

In the existing `@media (max-width: 600px)` block, replace the `.top-bar` and `.main-pane` lines with:

```css
  .top-bar { width: auto; margin: 0; padding: 8px 16px; }
  .main-pane { width: auto; margin: 0; padding: 24px 16px 120px;
    border: none; border-radius: 0; box-shadow: none; }
```

(The later `.composer` media block's `.main-pane { padding-bottom: 96px; }` override stays as is.)

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add web/src/styles.css
git commit -m "style: main pane as card on grey canvas; left gutter ~1/3 (pkm-n2kv, pkm-7cbq)"
git push
```

---

### Task 3: Heading typography

**Files:**
- Modify: `web/src/styles.css:229-231` (heading block-text sizes), `:194` (.page-title)

**Interfaces:** none new.

- [ ] **Step 1: Apply the Roam heading scale**

Replace lines 229–231 with:

```css
h1.block-text { font-size: 1.8rem; font-weight: 600; }
h2.block-text { font-size: 1.6rem; font-weight: 600; }
h3.block-text { font-size: 1.4rem; font-weight: 400; color: var(--color-text-secondary); }
```

And make `.page-title` explicit about weight:

```css
.page-title { font-size: 26px; font-weight: 600; margin: 0 0 12px; }
```

- [ ] **Step 2: Run tests and typecheck**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit and push**

```bash
git add web/src/styles.css
git commit -m "style: Roam heading scale, H3 lighter not bolder (pkm-n2kv)"
git push
```

---

### Task 4: Disc bullets with collapsed-ring affordance

**Files:**
- Modify: `web/src/components/BlockTree.tsx:29`, `web/src/components/EditableBlockTree.tsx:83-90`, `web/src/styles.css:226` (.bullet)
- Test: `web/src/components/BlockTree.test.tsx`, `web/src/components/EditableBlockTree.test.tsx`

**Interfaces:**
- Produces: `.bullet.closed` class present iff the block is collapsed AND has children. Drag behaviour (`draggable`, `onDragStart` on the span) unchanged — the dnd tests in `EditableBlockTree.dnd.test.tsx` must keep passing untouched.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/components/BlockTree.test.tsx`:

```tsx
it("bullet shows the closed ring only when collapsed with children", () => {
  const { container } = renderTree([
    block("uid_a1", "parent", { collapsed: true, children: [block("uid_a2", "child")] }),
    block("uid_a3", "leaf", { collapsed: true }),
  ]);
  expect(container.querySelector('[data-uid="uid_a1"] .bullet.closed')).not.toBeNull();
  expect(container.querySelector('[data-uid="uid_a3"] .bullet.closed')).toBeNull();
});
```

Append to `web/src/components/EditableBlockTree.test.tsx` (uses the shared `block` helper from `../test-helpers` and the file's existing `handlers()`):

```tsx
test("bullet shows the closed ring only when collapsed with children", () => {
  const blocks = [
    block("p1", "parent", { collapsed: true, order_idx: 0,
                            children: [block("c1", "child")] }),
    block("p2", "collapsed leaf", { collapsed: true, order_idx: 1 }),
  ];
  const { container } = render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree blocks={blocks} focus={null} handlers={handlers()}
                         readOnly={false} />
    </MemoryRouter>);
  expect(container.querySelector('[data-uid="p1"] .bullet.closed')).not.toBeNull();
  expect(container.querySelector('[data-uid="p2"] .bullet.closed')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm test -- --run BlockTree`
Expected: the two new tests FAIL (`.bullet.closed` not found); everything else passes.

- [ ] **Step 3: Add the `closed` class and drop the glyph**

`BlockTree.tsx` line 29, replace `<span className="bullet">•</span>` with:

```tsx
<span className={"bullet" + (hasChildren && collapsed ? " closed" : "")} />
```

`EditableBlockTree.tsx` lines 83–90, replace the span with (keeping the drag props exactly):

```tsx
<span className={"bullet" + (hasChildren && node.collapsed ? " closed" : "")}
      draggable={!readOnly}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", node.uid);
        e.dataTransfer.effectAllowed = "move";
        handlers.onDragStartBlock(node.uid);
      }} />
```

- [ ] **Step 4: Restyle the bullet in CSS**

Replace `.bullet { color: var(--color-text-muted); margin-right: 8px; flex-shrink: 0; font-size: 11px; }` (styles.css line 226) with:

```css
.bullet { box-sizing: content-box; width: 5px; height: 5px; flex-shrink: 0;
  align-self: flex-start; margin: 5px 8px 0 0;
  border: 4px solid transparent; border-radius: 50%;
  background-color: var(--color-bullet); background-clip: content-box; }
.bullet.closed { border-color: var(--color-bullet-ring); }
```

(`align-self: flex-start` + `margin-top` because the row is baseline-aligned and an empty span has no baseline; 5px centres the 13px box on the 22.5px base line-height. The existing `.bullet[draggable="true"] { cursor: grab; }` rule stays.)

- [ ] **Step 5: Run the full web suite**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: PASS, including all of `EditableBlockTree.dnd.test.tsx`.

- [ ] **Step 6: Commit and push**

```bash
git add web/src/components/BlockTree.tsx web/src/components/EditableBlockTree.tsx \
        web/src/components/BlockTree.test.tsx web/src/components/EditableBlockTree.test.tsx \
        web/src/styles.css
git commit -m "style: disc bullets with collapsed ring affordance (pkm-n2kv)"
git push
```

---

### Task 5: Block-ref tick bar + backlink cards

**Files:**
- Modify: `web/src/styles.css:243-244` (.block-ref), `:286-287` (.backlink-item/.query-item), token blocks (remove `--color-ref-dashed`)

**Interfaces:**
- Consumes: `--color-link` from Task 1.

- [ ] **Step 1: Restyle block refs**

Replace `.block-ref { border-bottom: 1px dashed var(--color-ref-dashed); }` with:

```css
.block-ref::before { content: ""; display: inline-block; width: 2px; height: 10px;
  border-radius: 2px; background: var(--color-link); margin-right: 6px; }
```

(`.block-ref.unresolved { color: var(--color-text-muted); }` stays.) Then delete the now-unused `--color-ref-dashed` line from ALL THREE token blocks.

- [ ] **Step 2: Backlink/query items as cards**

Replace the `.backlink-item, .query-item` rule (lines 286–287) with:

```css
.backlink-item, .query-item { margin: 8px 0; padding: 8px;
  border: 1px solid var(--color-border-subtle); border-radius: 6px;
  background: var(--color-bg-subtle); }
```

- [ ] **Step 3: Run tests and typecheck**

Run: `cd web && pnpm test -- --run && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit and push**

```bash
git add web/src/styles.css
git commit -m "style: block-ref tick bar, backlink items as cards (pkm-n2kv)"
git push
```

---

### Task 6: Visual verification, tuning, bean completion

**Files:**
- Modify: `web/src/styles.css` (tuning only, if needed)
- Modify: `.beans/pkm-n2kv--roam-look-restyle-palette-card-layout-typography-b.md`, `.beans/pkm-7cbq--reduce-left-margin-on-main-content-in-default-view.md`

- [ ] **Step 1: Run the app and screenshot both themes at three widths**

Start the dev stack: server `cd server && uv run python -m pkm.server.run --data-dir data --host 127.0.0.1` (port 8974, matching the Vite proxy in `web/vite.config.ts`), web `cd web && pnpm dev`. Using the agent-browser skill, screenshot a content-rich page AND the journal view at ~1400px, ~900px, and ~500px, in light and dark (toggle via the theme control or `document.documentElement.dataset.theme = "dark"`).

Check specifically: card contrast against the canvas in dark mode; the closed-bullet ring is visible but subtle; orange page links vs purple external links are distinguishable in both themes; H3 reads lighter than H2; the phone view is full-bleed with no stray card border; the search modal and right sidebar still look coherent on the grey canvas; bullet vertical alignment against single-line and heading rows.

- [ ] **Step 2: Tune values if needed**

Nudge only token values or the bullet `margin-top` — no structural changes. If the left-lean formula looks wrong in practice, adjust the `/ 6` divisor (spec target: left gutter ≈ 1/3 of the old centered gutter). Re-run `pnpm test -- --run && pnpm typecheck` after any edit. Commit tuning as `style: visual tuning after screenshot review (pkm-n2kv)` and push.

- [ ] **Step 3: Complete the beans**

Tick all checklist items in the pkm-n2kv bean body, then:

```bash
beans update pkm-n2kv --status completed
beans update pkm-7cbq --status completed
```

Add a line to pkm-7cbq's body first noting it was resolved by the pkm-n2kv card layout. Commit both bean files: `git commit -m "beans: complete pkm-n2kv and pkm-7cbq" && git push`.

- [ ] **Step 4: Finish the branch**

Use the superpowers:finishing-a-development-branch skill (expected outcome: `git merge --no-ff bean/pkm-n2kv` into `main`, push).
