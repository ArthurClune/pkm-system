# Cmd-B / Cmd-I Bold & Italic Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cmd-B / Cmd-I toggle `**bold**` / `__italic__` around the selection (or insert an empty marker pair at the caret) in the block editor, via a generalized meta-wrap shortcut table.

**Architecture:** A new pure transform `toggleEmphasis` in the functional core (`web/src/outline/keyEdits.ts`), dispatched from a new `META_WRAP_EDITS` table in `web/src/outline/keyboardPolicy.ts` that replaces the one-off Cmd-K branch. The existing `key-edit` decision path in the shell (`EditableBlockTree.tsx`) executes it unchanged — no shell edits.

**Tech Stack:** TypeScript, React, vitest (unit), Playwright (e2e). Spec: `docs/superpowers/specs/2026-07-20-bold-italic-shortcuts-design.md`. Bean: `pkm-kkpe`.

## Global Constraints

- Work in a git worktree on branch `pkm-kkpe-bold-italic` (superpowers:using-git-worktrees); run everything from the worktree root.
- Grammar is Roam-style (`web/src/grammar/tokenize.ts`): `**` = bold, `__` = italic. Do not touch the grammar.
- Modifier convention: Meta-only, Shift/Ctrl/Alt excluded (`!ctrlKey && !altKey && !shiftKey`).
- Both files carry `// pattern: Functional Core` — keep all logic pure; no DOM access.
- Check `git status -sb` before every commit (parallel sessions can switch the shared checkout's branch — worktrees avoid this, but verify anyway).
- Verification before completion: `cd web && pnpm verify` must pass (typecheck, unit coverage, Playwright e2e).
- Commit the bean file `.beans/pkm-kkpe--cmd-bcmd-i-bolditalic-toggle-shortcuts.md` (checklist updates) together with code changes.

---

### Task 1: `toggleEmphasis` pure transform

**Files:**
- Modify: `web/src/outline/keyEdits.ts` (append after `wrapLink`, ~line 85)
- Test: `web/src/outline/keyEdits.test.ts`

**Interfaces:**
- Consumes: `TextSelection` (existing interface in `keyEdits.ts`).
- Produces: `export function toggleEmphasis(text: string, selStart: number, selEnd: number, marker: "**" | "__"): TextSelection` — Task 2 imports this by name.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/outline/keyEdits.test.ts` (extend the existing import line to include `toggleEmphasis`):

```ts
describe("toggleEmphasis", () => {
  it("wraps a selection and keeps the inner text selected", () => {
    // select "bold" in "make bold now" (5..9)
    expect(toggleEmphasis("make bold now", 5, 9, "**"))
      .toEqual({ text: "make **bold** now", selStart: 7, selEnd: 11 });
    expect(toggleEmphasis("make bold now", 5, 9, "__"))
      .toEqual({ text: "make __bold__ now", selStart: 7, selEnd: 11 });
  });

  it("unwraps when the markers sit just outside the selection", () => {
    // "make **bold** now" with "bold" selected (7..11)
    expect(toggleEmphasis("make **bold** now", 7, 11, "**"))
      .toEqual({ text: "make bold now", selStart: 5, selEnd: 9 });
  });

  it("unwraps when the selection includes the markers", () => {
    // "make **bold** now" with "**bold**" selected (5..13)
    expect(toggleEmphasis("make **bold** now", 5, 13, "**"))
      .toEqual({ text: "make bold now", selStart: 5, selEnd: 9 });
  });

  it("does not treat a bare marker-only selection as wrapped", () => {
    // "**" selected (0..2): startsWith and endsWith overlap — must wrap, not strip
    expect(toggleEmphasis("**", 0, 2, "**"))
      .toEqual({ text: "******", selStart: 2, selEnd: 4 });
  });

  it("only unwraps matching markers", () => {
    // italic markers around the selection, toggling bold: wrap, don't strip
    expect(toggleEmphasis("__it__", 2, 4, "**"))
      .toEqual({ text: "__**it**__", selStart: 4, selEnd: 6 });
  });

  it("inserts an empty pair at a bare caret with the caret centered", () => {
    expect(toggleEmphasis("ab", 1, 1, "**"))
      .toEqual({ text: "a****b", selStart: 3, selEnd: 3 });
    expect(toggleEmphasis("", 0, 0, "__"))
      .toEqual({ text: "____", selStart: 2, selEnd: 2 });
  });

  it("deletes an empty pair when the caret sits between it", () => {
    // "a**|**b" caret at 3
    expect(toggleEmphasis("a****b", 3, 3, "**"))
      .toEqual({ text: "ab", selStart: 1, selEnd: 1 });
  });

  it("handles carets at the text boundaries without wrapping negative slices", () => {
    expect(toggleEmphasis("x", 0, 0, "**"))
      .toEqual({ text: "****x", selStart: 2, selEnd: 2 });
    expect(toggleEmphasis("x", 1, 1, "**"))
      .toEqual({ text: "x****", selStart: 3, selEnd: 3 });
  });

  it("wraps a selection at the very start and end of the text", () => {
    expect(toggleEmphasis("hi", 0, 2, "__"))
      .toEqual({ text: "__hi__", selStart: 2, selEnd: 4 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && pnpm test:unit src/outline/keyEdits.test.ts`
Expected: FAIL — `toggleEmphasis` is not exported.

- [ ] **Step 3: Implement `toggleEmphasis`**

Append to `web/src/outline/keyEdits.ts`:

```ts
/** Cmd-B / Cmd-I: toggle an emphasis marker pair ("**" bold, "__" italic —
 * Roam-style, matching grammar/tokenize.ts) around the selection. A wrapped
 * selection (markers just outside, or included in the selection) unwraps;
 * anything else wraps, keeping the inner text selected so toggles stack and
 * a second press undoes. A bare caret inserts an empty pair with the caret
 * centered; pressed again there, it deletes the pair. */
export function toggleEmphasis(
  text: string, selStart: number, selEnd: number, marker: "**" | "__",
): TextSelection {
  const m = marker.length;
  const inner = text.slice(selStart, selEnd);

  if (selStart !== selEnd) {
    // Selection includes the markers: strip them, keep the inner selected.
    if (inner.length >= 2 * m && inner.startsWith(marker) && inner.endsWith(marker)) {
      const stripped = inner.slice(m, -m);
      return {
        text: text.slice(0, selStart) + stripped + text.slice(selEnd),
        selStart, selEnd: selStart + stripped.length,
      };
    }
    // Markers just outside the selection: remove them, keep it selected.
    if (selStart >= m && text.slice(selStart - m, selStart) === marker
        && text.slice(selEnd, selEnd + m) === marker) {
      return {
        text: text.slice(0, selStart - m) + inner + text.slice(selEnd + m),
        selStart: selStart - m, selEnd: selEnd - m,
      };
    }
    // Wrap, keeping the inner text selected (like autoPairBracket's wrap).
    return {
      text: text.slice(0, selStart) + marker + inner + marker + text.slice(selEnd),
      selStart: selStart + m, selEnd: selEnd + m,
    };
  }

  // Bare caret between an empty pair: delete the pair.
  if (selStart >= m && text.slice(selStart - m, selStart) === marker
      && text.slice(selStart, selStart + m) === marker) {
    return {
      text: text.slice(0, selStart - m) + text.slice(selStart + m),
      selStart: selStart - m, selEnd: selStart - m,
    };
  }
  // Bare caret: insert an empty pair with the caret centered.
  return {
    text: text.slice(0, selStart) + marker + marker + text.slice(selStart),
    selStart: selStart + m, selEnd: selStart + m,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && pnpm test:unit src/outline/keyEdits.test.ts`
Expected: PASS (all, including existing autoPairBracket/wrapLink tests).

- [ ] **Step 5: Tick the bean checklist item and commit**

Tick `- [ ] toggleEmphasis in keyEdits.ts (TDD)` → `- [x]` in the bean (use `beans update pkm-kkpe --body-replace-old ... --body-replace-new ...`), then:

```bash
git status -sb   # confirm the worktree branch pkm-kkpe-bold-italic
git add web/src/outline/keyEdits.ts web/src/outline/keyEdits.test.ts .beans/pkm-kkpe--cmd-bcmd-i-bolditalic-toggle-shortcuts.md
git commit -m "feat(editor): toggleEmphasis core transform for Cmd-B/Cmd-I (pkm-kkpe)"
```

---

### Task 2: META_WRAP_EDITS policy table + modifier-convention comment

**Files:**
- Modify: `web/src/outline/keyboardPolicy.ts` (imports ~line 9, Cmd-K branch at lines 110–112, convention comment near the top of `decideEditorKey`)
- Test: `web/src/outline/keyboardPolicy.test.ts`

**Interfaces:**
- Consumes: `toggleEmphasis(text, selStart, selEnd, marker)` and `wrapLink(text, selStart, selEnd)` from `./keyEdits` (Task 1).
- Produces: unchanged `KeyDecision` union — `{ type: "key-edit", edit: TextSelection }` for Meta+K/B/I. No consumer changes.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/outline/keyboardPolicy.test.ts` (uses the existing `input(...)` helper):

```ts
describe("decideEditorKey meta-wrap shortcuts (Cmd-K/B/I)", () => {
  it("Cmd-B toggles bold as a key-edit", () => {
    expect(decideEditorKey(input({
      key: "b", metaKey: true, draft: "make bold now", selStart: 5, selEnd: 9,
    }))).toEqual({
      type: "key-edit",
      edit: { text: "make **bold** now", selStart: 7, selEnd: 11 },
    });
  });

  it("Cmd-I toggles italic as a key-edit", () => {
    expect(decideEditorKey(input({
      key: "i", metaKey: true, draft: "word", selStart: 0, selEnd: 4,
    }))).toEqual({
      type: "key-edit",
      edit: { text: "__word__", selStart: 2, selEnd: 6 },
    });
  });

  it("Cmd-K still wraps a link", () => {
    expect(decideEditorKey(input({
      key: "k", metaKey: true, draft: "text", selStart: 0, selEnd: 4,
    }))).toEqual({
      type: "key-edit",
      edit: { text: "[text]()", selStart: 7, selEnd: 7 },
    });
  });

  it("ignores the chord when Ctrl, Alt or Shift is also held", () => {
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      expect(decideEditorKey(input({
        key: "b", metaKey: true, draft: "x", selStart: 0, selEnd: 1, ...extra,
      }))).toEqual({ type: "none" });
      // Cmd-Shift-K no longer link-wraps (reserved for future chords)
      expect(decideEditorKey(input({
        key: "k", metaKey: true, draft: "x", selStart: 0, selEnd: 1, ...extra,
      }))).toEqual({ type: "none" });
    }
  });

  it("does nothing without Meta (Ctrl-B stays an emacs textarea binding)", () => {
    expect(decideEditorKey(input({
      key: "b", ctrlKey: true, draft: "x", selStart: 0, selEnd: 1,
    }))).toEqual({ type: "none" });
  });

  it("is read-only gated", () => {
    expect(decideEditorKey(input({
      key: "b", metaKey: true, readOnly: true, draft: "x", selStart: 0, selEnd: 1,
    }))).toEqual({ type: "none" });
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd web && pnpm test:unit src/outline/keyboardPolicy.test.ts`
Expected: FAIL — Cmd-B/Cmd-I return `{ type: "none" }`, and Cmd-Shift-K currently returns a key-edit.

- [ ] **Step 3: Implement the table**

In `web/src/outline/keyboardPolicy.ts`:

1. Extend the keyEdits import:

```ts
import { autoPairBracket, BRACKET_CHARS, toggleEmphasis, wrapLink,
         type TextSelection } from "./keyEdits";
```

2. Above `decideEditorKey`, next to the `NONE` constant, add:

```ts
// Modifier convention: letter-chord editing shortcuts are Meta-only with
// Ctrl/Alt/Shift excluded — Ctrl+letter is left to the emacs-style textarea
// bindings macOS provides (Ctrl-K kill-line, Ctrl-B back-char, ...), and
// Shift chords stay free for future shortcuts. Only shortcuts mirroring a
// system-wide convention (undo/redo, todo-cycle on Enter) accept Meta or
// Ctrl so they also work on non-Mac keyboards.
const META_WRAP_EDITS: Record<string,
  (text: string, selStart: number, selEnd: number) => TextSelection> = {
  k: wrapLink,
  b: (t, s, e) => toggleEmphasis(t, s, e, "**"),
  i: (t, s, e) => toggleEmphasis(t, s, e, "__"),
};
```

3. Replace the Cmd-K branch (lines 110–112):

```ts
  if (i.metaKey && !i.ctrlKey && !i.altKey && i.key.toLowerCase() === "k") {
    return { type: "key-edit", edit: wrapLink(i.draft, pos, i.selEnd) };
  }
```

with:

```ts
  const wrapEdit = META_WRAP_EDITS[i.key.toLowerCase()];
  if (wrapEdit && i.metaKey && !i.ctrlKey && !i.altKey && !i.shiftKey) {
    return { type: "key-edit", edit: wrapEdit(i.draft, pos, i.selEnd) };
  }
```

- [ ] **Step 4: Run the full unit suite to verify it passes**

Run: `cd web && pnpm test:unit`
Expected: PASS — including all pre-existing keyboardPolicy tests (none exercise Cmd-Shift-K as a link wrap; if one does, that expectation changes to `{ type: "none" }` per the spec).

- [ ] **Step 5: Tick the bean checklist item and commit**

Tick `- [x] META_WRAP_EDITS table in keyboardPolicy.ts + convention comment`, then:

```bash
git status -sb
git add web/src/outline/keyboardPolicy.ts web/src/outline/keyboardPolicy.test.ts .beans/pkm-kkpe--cmd-bcmd-i-bolditalic-toggle-shortcuts.md
git commit -m "feat(editor): Cmd-B/Cmd-I bold+italic via META_WRAP_EDITS table (pkm-kkpe)"
```

---

### Task 3: Playwright e2e + full verification

**Files:**
- Modify: `web/e2e/edit.spec.ts` (append a test; reuse its `login`, `input`, `caretToEnd` helpers)

**Interfaces:**
- Consumes: the running app with Tasks 1–2 applied; `waitForServerText` from `web/e2e/server-state.ts`.
- Produces: nothing downstream — final gate.

- [ ] **Step 1: Write the e2e test**

Append to `web/e2e/edit.spec.ts`:

```ts
test("Cmd-B bolds the selection and renders <strong> (pkm-kkpe)", async ({ page }) => {
  // unique page: the e2e DB is shared across specs/retries, and today's
  // journal must stay untouched (other specs assume its state)
  const title = `BoldKey${Date.now()}`;
  await login(page);
  const createRes = await page.request.post("/api/pages", { data: { title } });
  expect(createRes.ok()).toBeTruthy();
  await page.goto(`/page/${encodeURIComponent(title)}`);
  await page.getByText("Click to start writing…").click();

  await input(page).fill("make bold now");
  // select "bold" (5..9) and toggle
  await input(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 9));
  await input(page).press("Meta+b");
  await expect(input(page)).toHaveValue("make **bold** now");
  // toggle straight back off (selection stays on the inner text), then on again
  await input(page).press("Meta+b");
  await expect(input(page)).toHaveValue("make bold now");
  await input(page).press("Meta+b");
  await input(page).press("Escape"); // blur: flushes the draft op

  await waitForServerText(page, title, "make **bold** now");
  await expect(page.locator(".block-text strong", { hasText: "bold" })).toBeVisible();
});
```

- [ ] **Step 2: Run the spec (requires a fresh build — e2e serves web/dist)**

Run: `cd web && pnpm build && node tooling/runPlaywright.mjs e2e/edit.spec.ts` (this is what `pnpm e2e` runs; the wrapper handles server startup — pass `E2E_PORT` if 8975 clashes)
Expected: PASS (all edit.spec tests; the new one exercises wrap → unwrap → wrap → render).

- [ ] **Step 3: Full verification**

Run: `cd web && pnpm verify`
Expected: PASS — typecheck, unit coverage thresholds, lint/fcis/budgets, full Playwright suite, warning-free.

- [ ] **Step 4: Tick the remaining bean checklist items and commit**

Tick `- [x] Unit + policy tests, e2e for Cmd-B` and `- [x] verify: pnpm verify, server untouched`, then:

```bash
git status -sb
git add web/e2e/edit.spec.ts .beans/pkm-kkpe--cmd-bcmd-i-bolditalic-toggle-shortcuts.md
git commit -m "test(e2e): Cmd-B bold toggle round-trip (pkm-kkpe)"
```

---

### Task 4: Finish the branch

- [ ] **Step 1:** Invoke superpowers:requesting-code-review against the spec, address findings.
- [ ] **Step 2:** Invoke superpowers:finishing-a-development-branch — merge to main with `git merge --no-ff pkm-kkpe-bold-italic`, push, mark the bean completed with a `## Summary of Changes` section.
