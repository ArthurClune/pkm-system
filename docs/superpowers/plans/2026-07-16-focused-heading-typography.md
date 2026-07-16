# Focused Heading Typography Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make focused heading blocks retain their H1/H2/H3 typography so the existing `Ctrl-Alt-0/1/2/3` heading shortcuts show their effect immediately.

**Architecture:** Keep the functional keyboard policy and `set_heading` operation path unchanged. The imperative editor shell derives a CSS class from the live optimistic `node.heading`, and shared CSS selectors give focused textareas exactly the same size and weight as unfocused heading elements.

**Tech Stack:** React 18, TypeScript, CSS, Vitest, Testing Library, pnpm

## Global Constraints

- Keep the exact existing `Ctrl-Alt-0/1/2/3` bindings and read-only behavior unchanged.
- Focused H1, H2, and H3 blocks must use the same font size and weight as their unfocused forms.
- `Ctrl-Alt-0` must restore ordinary body typography.
- Focus, caret, selection, raw markup, autocomplete state, focus background, and sync behavior must remain unchanged.
- Do not add server, schema, API, or operation changes.
- Preserve the existing `// pattern: Imperative Shell` declaration in `EditableBlockTree.tsx`; CSS and tests are FCIS-exempt.
- Follow test-driven development: observe the focused-typography tests fail before editing runtime code or CSS.

---

## File Structure

- `web/src/components/EditableBlockTree.tsx`: derive the focused textarea's heading class from `node.heading`.
- `web/src/components/EditableBlockTree.test.tsx`: verify initially focused H1/H2/H3 blocks expose the corresponding typography class.
- `web/src/views/EditablePage.test.tsx`: verify real Ctrl-Alt shortcut wiring updates focused styling immediately, queues `set_heading`, preserves text, and clears styling with `0`.
- `web/src/styles.css`: share each existing heading size/weight declaration with its focused textarea class.
- `web/src/styles.test.ts`: pin focused and unfocused heading typography to the same CSS declaration.
- `.beans/pkm-ofec--use-ctrl-cmd-digit-shortcuts-for-heading-levels.md`: track test, implementation, verification, and completion evidence.

### Task 1: Preserve heading typography in the focused editor

**Files:**
- Modify: `web/src/components/EditableBlockTree.tsx:322-323,590-591`
- Test: `web/src/components/EditableBlockTree.test.tsx:54-61`
- Test: `web/src/views/EditablePage.test.tsx:95-140`
- Modify: `web/src/styles.css:321-324`
- Test: `web/src/styles.test.ts:149-162`
- Modify: `.beans/pkm-ofec--use-ctrl-cmd-digit-shortcuts-for-heading-levels.md`

**Interfaces:**
- Consumes: `BlockInput`'s existing `node: BlockNode`, where `node.heading` is `number | null`; `useOutline`'s existing optimistic `onSetHeading(uid, heading)` handler; existing `.block-input` and `h1/h2/h3.block-text` selectors.
- Produces: textarea classes `heading-1`, `heading-2`, and `heading-3`; no new TypeScript exports or operation types.

- [ ] **Step 1: Add failing component, interaction, and CSS tests**

Add this test after `the focused block is a textarea with the raw markdown` in `web/src/components/EditableBlockTree.test.tsx`:

```tsx
test.each([
  [1, "heading-1"],
  [2, "heading-2"],
  [3, "heading-3"],
] as const)("a focused heading %i retains the %s typography class",
            (heading, className) => {
  const h = handlers();
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
      <EditableBlockTree
        blocks={[block("heading", "Heading", { heading })]}
        focus={{ uid: "heading", cursor: 0 }} handlers={h} readOnly={false} />
    </MemoryRouter>,
  );

  expect(focusedTextarea()).toHaveClass("block-input", className);
});
```

Add this test after `stale initial rerender while its scoped write is unsettled keeps optimistic heading` in `web/src/views/EditablePage.test.tsx`:

```tsx
test("Ctrl-Alt heading shortcuts update focused typography immediately", () => {
  const sync = mount();
  let ta = focusBlock("first");

  for (const level of [1, 2, 3] as const) {
    fireEvent.keyDown(ta, {
      key: String(level), code: `Digit${level}`,
      ctrlKey: true, altKey: true,
    });
    ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta).toHaveClass(`heading-${level}`);
    expect(ta).toHaveValue("first");
  }

  fireEvent.keyDown(ta, {
    key: "0", code: "Digit0", ctrlKey: true, altKey: true,
  });
  ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(ta).not.toHaveClass("heading-1", "heading-2", "heading-3");
  expect(ta).toHaveValue("first");
  expect(sync.sent).toEqual([
    [{ op: "set_heading", uid: "u1", heading: 1 }],
    [{ op: "set_heading", uid: "u1", heading: 2 }],
    [{ op: "set_heading", uid: "u1", heading: 3 }],
    [{ op: "set_heading", uid: "u1", heading: null }],
  ]);
});
```

Replace the `typography hierarchy (pkm-b68q)` block in `web/src/styles.test.ts` with:

```ts
describe("typography hierarchy (pkm-b68q, pkm-ofec)", () => {
  test("displayed and focused headings share the same scale and weight", () => {
    for (const [selector, size] of [
      ["h1.block-text, .block-input.heading-1", "1.4rem"],
      ["h2.block-text, .block-input.heading-2", "1.25rem"],
      ["h3.block-text, .block-input.heading-3", "1.1rem"],
    ] as const) {
      const rule = ruleFor(selector);
      expect(rule).toContain(`font-size: ${size};`);
      expect(rule).toContain("font-weight: 600;");
    }
  });

  test("h3 heading blocks are not de-emphasised below body text", () => {
    const h3 = ruleFor("h3.block-text, .block-input.heading-3");
    expect(h3).not.toContain("font-weight: 400;");
    expect(h3).not.toContain("color: var(--color-text-secondary);");
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the red state**

Run:

```bash
cd web
pnpm exec vitest run \
  src/components/EditableBlockTree.test.tsx \
  src/views/EditablePage.test.tsx \
  src/styles.test.ts
```

Expected: FAIL. The component and interaction tests report missing `heading-1`/`heading-2`/`heading-3` classes, and `styles.test.ts` reports a missing combined heading selector. Existing operation assertions should still pass, confirming that the shortcut behavior itself is intact.

- [ ] **Step 3: Derive and apply the focused heading class**

In `BlockInput` in `web/src/components/EditableBlockTree.tsx`, add the class derivation immediately after the function opens and before the hook declarations:

```tsx
  const headingClass =
    node.heading === 1 ? " heading-1" :
    node.heading === 2 ? " heading-2" :
    node.heading === 3 ? " heading-3" : "";
```

Then replace the textarea opening with this class-aware form, leaving every event handler and prop unchanged:

```tsx
      <textarea ref={ref} className={`block-input${headingClass}`}
                rows={1} value={draft} readOnly={readOnly}
                onChange={onChange} onKeyDown={onKeyDown}
                onBlur={() => handlers.onBlurBlock(node.uid)}
                onPaste={onPaste} onDrop={onDrop}
                onCompositionStart={onCompositionStart}
                onCompositionEnd={onCompositionEnd} />
```

This explicit mapping makes null and unsupported values fall back to plain typography and changes only the DOM class, so React keeps the same textarea instance and editor state.

- [ ] **Step 4: Share heading typography with focused inputs**

Replace the three heading declarations in `web/src/styles.css` with:

```css
h1.block-text, .block-input.heading-1 { font-size: 1.4rem; font-weight: 600; }
h2.block-text, .block-input.heading-2 { font-size: 1.25rem; font-weight: 600; }
h3.block-text, .block-input.heading-3 { font-size: 1.1rem; font-weight: 600; }
```

Do not change `.block-input`, `.block-row.focused`, heading sizes, heading weights, or line-height rules.

- [ ] **Step 5: Run the focused tests and verify the green state**

Run:

```bash
cd web
pnpm exec vitest run \
  src/components/EditableBlockTree.test.tsx \
  src/views/EditablePage.test.tsx \
  src/styles.test.ts
```

Expected: all three test files pass. The interaction test remains focused throughout all four shortcuts, keeps the raw text `first`, observes each class immediately, and records exactly four `set_heading` batches.

- [ ] **Step 6: Run the complete web release gate**

Run from the repository worktree root:

```bash
cd web
pnpm verify
```

Expected: exit 0 from TypeScript typecheck, ESLint, FCIS checks, enforced unit coverage, production build, and Playwright E2E. Do not mark the bean complete if any stage fails.

- [ ] **Step 7: Record implementation and verification evidence in the bean**

Run from the repository worktree root:

```bash
beans update pkm-ofec --body-replace-old "- [ ] Add failing tests first" \
  --body-replace-new "- [x] Add failing tests first"
beans update pkm-ofec --body-replace-old "- [ ] Implement shortcut behavior" \
  --body-replace-new "- [x] Implement shortcut behavior"
beans update pkm-ofec --body-replace-old "- [ ] Run required verification" \
  --body-replace-new "- [x] Run required verification"
beans update pkm-ofec --body-append $'## Summary of Changes\n\nConfirmed the Ctrl-Alt shortcut and set_heading pipeline were already working. Focused H1/H2/H3 textareas now receive live heading classes and share the exact displayed heading size and weight; Ctrl-Alt-0 removes the class and restores body typography without changing text or focus. Component, real-handler interaction, CSS, and full web verification cover the fix.'
```

Expected: the bean remains `in-progress`, with implementation and verification checklist items checked and a concrete summary appended.

- [ ] **Step 8: Commit and push the verified implementation**

Run:

```bash
git add \
  web/src/components/EditableBlockTree.tsx \
  web/src/components/EditableBlockTree.test.tsx \
  web/src/views/EditablePage.test.tsx \
  web/src/styles.css \
  web/src/styles.test.ts \
  .beans/pkm-ofec--use-ctrl-cmd-digit-shortcuts-for-heading-levels.md
git diff --cached --check
git commit -m "fix(web): preserve heading typography while editing (pkm-ofec)"
git push
```

Expected: the implementation commit is created on `fix/pkm-ofec-heading-focus` and pushed to `origin/fix/pkm-ofec-heading-focus`.

- [ ] **Step 9: Complete the bean and push its final metadata commit**

Run:

```bash
beans update pkm-ofec --body-replace-old "- [ ] Update bean summary and complete" \
  --body-replace-new "- [x] Update bean summary and complete"
beans update pkm-ofec --status completed \
  --body-replace-old "- [ ] Commit and push changes" \
  --body-replace-new "- [x] Commit and push changes"
git add .beans/pkm-ofec--use-ctrl-cmd-digit-shortcuts-for-heading-levels.md
git commit -m "chore(beans): mark pkm-ofec completed"
git push
git status --short --branch
```

Expected: `pkm-ofec` is completed with no unchecked checklist items, the metadata commit is pushed, and git reports a clean branch tracking `origin/fix/pkm-ofec-heading-focus`.
