# pkm-69sl Cursor Position Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cross-block ArrowUp and ArrowDown navigation place the caret at the destination block's text end while preserving horizontal boundary navigation.

**Architecture:** Keep navigation policy in the existing `useOutline` hook. Change only its `FocusTarget.cursor` calculation: ArrowRight enters at the destination start, while ArrowUp, ArrowDown, and ArrowLeft enter at the destination end.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Playwright

## Global Constraints

- Pointer and touch focus continue to place the caret at the clicked block's text end.
- ArrowUp and ArrowDown place the caret at the destination block's text end.
- ArrowLeft retains destination-end behavior; ArrowRight retains destination-start behavior.
- Empty destination blocks remain at cursor `0` because their text length is zero.
- Do not change focus timing, pointer events, component APIs, or unrelated outline behavior.
- Runtime files must retain their FCIS pattern declaration.

---

### Task 1: Correct Cross-Block Caret Placement

**Files:**
- Modify: `web/src/views/EditablePage.test.tsx:219-232`
- Modify: `web/src/outline/useOutline.ts:279-289`

**Interfaces:**
- Consumes: `OutlineHandlers.onArrow(uid: string, dir: "up" | "down" | "left" | "right"): void`, `visibleNeighbor`, and `findNode`.
- Produces: unchanged `FocusTarget` shape `{ uid: string; cursor: number }`, with vertical directions selecting the destination text end.

- [ ] **Step 1: Update the integration test with the desired directional behavior**

Replace the existing `boundary arrows move editor focus to the visible neighbour` test in `web/src/views/EditablePage.test.tsx` with:

```tsx
test("boundary arrows use text end vertically and preserve horizontal entry", () => {
  mount();
  let ta = focusBlock("second");
  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowUp" });
  ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(ta).toHaveValue("first");
  expect(ta.selectionStart).toBe(5);

  fireEvent.keyDown(ta, { key: "ArrowDown" });
  ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(ta).toHaveValue("second");
  expect(ta.selectionStart).toBe(6);

  ta.setSelectionRange(0, 0);
  fireEvent.keyDown(ta, { key: "ArrowLeft" });
  ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(ta).toHaveValue("first");
  expect(ta.selectionStart).toBe(5);

  fireEvent.keyDown(ta, { key: "ArrowRight" });
  ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(ta).toHaveValue("second");
  expect(ta.selectionStart).toBe(0);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web
pnpm exec vitest run src/views/EditablePage.test.tsx -t "boundary arrows use text end vertically and preserve horizontal entry"
```

Expected: FAIL on the ArrowDown assertion because `selectionStart` is `0` instead of `6`.

- [ ] **Step 3: Implement the minimal cursor rule**

In `web/src/outline/useOutline.ts`, replace the `setFocus` cursor expression inside `onArrow` with:

```ts
      setFocus({
        uid: to,
        cursor: dir === "right" ? 0 : (node?.text.length ?? 0),
      });
```

This makes both vertical directions land at text end, preserves ArrowLeft at end and ArrowRight at start, and naturally gives empty blocks cursor `0`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
cd web
pnpm exec vitest run src/views/EditablePage.test.tsx src/components/EditableBlockTree.test.tsx
```

Expected: both test files pass, including the corrected boundary-arrow integration test and existing pointer/empty-block caret tests.

- [ ] **Step 5: Run complete web verification**

Run:

```bash
cd web
pnpm verify
```

Expected: typecheck, lint, FCIS check, enforced unit coverage, build, and Playwright E2E all pass.

- [ ] **Step 6: Record implementation and verification in the bean**

From the repository root, use `beans update pkm-69sl` to check off the failing-test, implementation, and verification items. Append this summary without completing the bean yet:

```markdown
## Summary of Changes

- Changed vertical cross-block navigation to place the caret at the destination block's text end.
- Preserved ArrowLeft destination-end and ArrowRight destination-start behavior.
- Added integration coverage for vertical and horizontal boundary-arrow caret placement.
- Verified with the focused editor tests and the complete `web/pnpm verify` suite.
```

- [ ] **Step 7: Commit and push the implementation**

```bash
git add web/src/views/EditablePage.test.tsx web/src/outline/useOutline.ts .beans/pkm-69sl--cursor-position.md
git commit -m "fix(pkm-69sl): place vertical navigation caret at block end"
git push
```

Expected: the implementation and current bean state are pushed to `origin/fix/pkm-69sl-cursor-position`.

- [ ] **Step 8: Complete the bean after the implementation is pushed**

Use `beans update pkm-69sl` to check off `Commit, push, and complete bean`, then set the status to `completed`. Confirm there are no unchecked checklist items.

- [ ] **Step 9: Commit and push bean completion**

```bash
git add .beans/pkm-69sl--cursor-position.md
git commit -m "chore(pkm-69sl): complete cursor position bean"
git push
```

Expected: the completed bean is pushed to `origin/fix/pkm-69sl-cursor-position`.
