# Remount Keeps the Pending Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a remote batch reparents the focused block (or one of its ancestors) within the same page, the remounted textarea resumes the unflushed draft instead of showing the tree's text, so nothing typed before the move is lost.

**Architecture:** A reparent moves the block to a different React render site (`EditableBlockTree.tsx` renders top-level rows and children from two separate `map`s), so its `BlockInput` unmounts and a new one mounts. React delivers no blur for the removed node, so `useOutline`'s `pendingRef` still holds the draft while the new `useBlockDraft` starts clean on the tree's text; the next keystroke then replaces the draft's text (`captureDraft`, same uid). The fix adds one query to the `OutlineHandlers` port, `pendingDraft(uid)`, which `useOutline` answers from `pendingRef`. `BlockInput` asks it once at mount, and `useBlockDraft` starts from that text, dirty, with the caret at its end. The draft's base is untouched: `pendingRef` keeps it (`captureDraft` keeps `prev.base` for the same uid), and a textarea that starts dirty never calls `onDraftStart`, so `shownRef` is not overwritten with the remounted tree text.

**Tech Stack:** React 18, TypeScript, Vitest + Testing Library (jsdom), Playwright.

**Spec:** No spec section. The spec is bean pkm-sfp1 (`beans show pkm-sfp1`) plus finding P1 and the re-reviews in the F3 adversarial review (`/private/tmp/claude-501/-Users-arthur-code-llm-pkm/410bb397-f861-4e8b-96bb-6f1cfbb3396c/scratchpad/review-pkm-impk.md`; a copy is not in the repo, so the bean body is the durable spec). Read `docs/architecture/frontend-editor.md` § "Drafts and commit points" before starting.

## Global Constraints

- Run `beans prime` at session start. Work only inside your worktree root, on branch `fix/pkm-sfp1-remount-keeps-pending-draft`; run `git status -sb` before every commit to confirm you are in the worktree, not the main checkout.
- TDD: every fix's failing test goes red, for the stated reason, before the fix. A test that already passes before the fix says so in its step.
- Every runtime file keeps its FCIS header (`// pattern: Functional Core` / `// pattern: Imperative Shell`). All files this plan changes are Imperative Shell, or type-only (`handlers.ts`). `pnpm check:fcis` forbids a Core file importing a value from a Shell module.
- Code and test comments state the rule and carry NO bean id. Commit messages may carry the id.
- Editor rule: text edits ride the draft/key-edit path, never tree-direct. This fix changes only what a mounting textarea shows and whether it starts dirty; it writes nothing to the tree.
- The draft's base must stay the text the user originally typed over, never the remounted tree's text. Every test that flushes asserts `base_text_hash: sha256Hex(<original text>)`.
- Docs land in the same branch: a prose note in `docs/architecture/frontend-editor.md` § "Drafts and commit points", and one row in `docs/troubleshooting.md`. Any `docs/architecture/` edit goes through the `architecture-docs` skill; run `node .claude/skills/architecture-docs/check-docs.mjs <files>`.
- No route or docstring change: no openapi/type regeneration.
- The composed real-browser test is a task of its own (Task 2).
- The orchestrator runs the full Playwright suite and `perf/check.sh` after merge. Do NOT run them. Run only the one new e2e spec, alone, on the port you are given.
- Never write the two-word phrase that starts "load" and ends "bearing".
- Sibling wave-2 beans may touch the same files: pkm-9u3y (strips bean ids from comments, including in `useBlockDraft.ts`, `useOutline.ts`, `handlers.ts`, `BlockInput.tsx`), pkm-xjew (docs corrections, `frontend-editor.md`), and every wave-2 bean adds a row to `docs/troubleshooting.md`. Keep edits local to the lines named here so merges stay mechanical.

## Review Focus

1. **Caret after the remount.** The old textarea's caret is not tracked. The new textarea puts the caret at the end of the resumed draft, not at `focus.cursor` (the offset from the original click, usually the old text's length, which would land the next keystroke in the middle of the user's own typing). Pinned in Task 1's first test.
2. **One remote batch both moves and edits the focused block.** The textarea keeps the draft and the flush still hashes the original text, so the server keeps the remote text as a conflict copy. Pinned in Task 1.
3. **An ancestor, not the block, is reparented.** The focused descendant remounts too, and its draft must resume just the same: the fix keys on the uid at mount, not on the batch's ops. Pinned in Task 1.
4. **A flush-held draft (caret mid `[[ref`) is remounted.** It must resume without being flushed (no timer is armed for it), and blur must still ship it with its base. Pinned in Task 1.
5. **Cmd+Z on a resumed draft.** The undo path flushes the resumed draft, then `settle()` adopts the undone text; the resumed draft must not hold the textarea dirty past the undo. Pinned in Task 1.

---

### Task 1: The remounted textarea resumes the pending draft

**Files:**
- Modify: `web/src/outline/handlers.ts` (new member after `onDraftChange`)
- Modify: `web/src/outline/useOutline.ts` (the `handlers` `useMemo`, next to `onDraftStart` / `onDraftChange`, currently around lines 323-341)
- Modify: `web/src/outline/useBlockDraft.ts` (`BlockDraftOptions`; the `draft` state, `initialCursorRef` and `dirtyRef` initialisers, currently lines 71-85)
- Modify: `web/src/components/BlockInput.tsx` (the `useBlockDraft({...})` call, currently lines 50-59)
- Modify test fakes that build a literal `OutlineHandlers`: `web/src/components/BlockInput.test.tsx`, `web/src/components/EditableBlockTree.test.tsx`, `web/src/components/AutocompletePopup.test.tsx` (add `pendingDraft: vi.fn(() => null)`). The `Proxy` fakes in `EditableBlockTree.focus.test.tsx` and `EditableBlockTree.memo.test.tsx` return `vi.fn()` (which returns `undefined`); `BlockInput` normalises that, see Step 5.
- Test: `web/src/views/EditablePage.test.tsx` (new tests next to the "remote cross-page move" draft tests, around lines 726-820), `web/src/components/BlockInput.test.tsx`

**Interfaces:**
- Produces, in `OutlineHandlers`:
  ```ts
  /** The text of the unflushed draft for `uid`, or null when none is pending.
   * A textarea mounting for that block resumes it: a remote batch that
   * reparents the block (or an ancestor) remounts the textarea with no blur,
   * so the draft is still pending and the tree does not hold its text. */
  pendingDraft(uid: string): string | null;
  ```
- Produces, in `BlockDraftOptions`:
  ```ts
  /** Called once, at mount: the pending draft this textarea resumes, or null.
   * A resumed draft starts dirty, so the tree's text does not replace it and
   * its first edit reports no new draft start (the draft keeps its base). */
  resume(): string | null;
  ```

- [ ] **Step 1: Write the failing component tests in `web/src/views/EditablePage.test.tsx`**

Use the existing `mount`, `focusBlock`, `textbox`, `undoKey`, `heldRefDraft`, `HELD_TEXT_OP` helpers. Declare one constant next to `CROSS_PAGE_MOVE`:

```ts
const SAME_PAGE_MOVE = { op: "move", uid: "u1", parent_uid: "u2",
                         order_idx: 0, page_title: "Page" } as const;
```

Tests (each starts `vi.useFakeTimers(); stubFetch([["/api/titles", { titles: [] }]]);` unless it uses `heldRefDraft`):

```ts
test("a remote same-page move of the focused block keeps its draft on the remounted textarea", () => {
  const sync = mount();
  const ta = focusBlock("first");
  fireEvent.change(ta, { target: { value: "typed words" } });
  act(() => sync.emit({ client_id: "other", ts: 1, ops: [SAME_PAGE_MOVE] }));
  expect(ta.isConnected).toBe(false);            // the move remounted it
  expect(textbox().value).toBe("typed words");
  expect(textbox().selectionStart).toBe("typed words".length);
  fireEvent.change(textbox(), { target: { value: "typed words!" } });
  act(() => { vi.advanceTimersByTime(500); });
  expect(sync.sent).toEqual([
    [{ op: "update_text", uid: "u1", text: "typed words!",
       base_text_hash: sha256Hex("first"), page_title: "Page" }],
  ]);
});

test("a resumed draft goes clean once it flushes, and later remote text is adopted", () => {
  // focus "first", type "typed", emit SAME_PAGE_MOVE
  // expect(textbox().value).toBe("typed");
  // advance 500; expect(sync.sent).toEqual([[{ op: "update_text", uid: "u1", text: "typed",
  //   base_text_hash: sha256Hex("first"), page_title: "Page" }]]);
  // emit { op: "update_text", uid: "u1", text: "remote" } from "other"
  // expect(textbox().value).toBe("remote");
});

test("a remote batch that moves and edits the focused block keeps the draft and its base", () => {
  // focus "first", type "typed", emit ops [SAME_PAGE_MOVE,
  //   { op: "update_text", uid: "u1", text: "remote" }]
  // expect(textbox().value).toBe("typed");
  // advance 500; expect(sync.sent).toEqual([[{ op: "update_text", uid: "u1",
  //   text: "typed", base_text_hash: sha256Hex("first"), page_title: "Page" }]]);
});

test("a remote move of the focused block's parent keeps the draft on the remounted child", () => {
  // mount(makeSync(), [
  //   block("u1", "first", { order_idx: 0,
  //     children: [block("c1", "child", { order_idx: 0 })] }),
  //   block("u2", "second", { order_idx: 1 }),
  // ]);
  // focus "child", type "child typed", emit SAME_PAGE_MOVE (moves u1 under u2)
  // expect(textbox().value).toBe("child typed");
  // advance 500; expect(sync.sent).toEqual([[{ op: "update_text", uid: "c1",
  //   text: "child typed", base_text_hash: sha256Hex("child"), page_title: "Page" }]]);
});

test("a held draft survives a remote same-page move and still flushes on blur", () => {
  // const sync = makeSync(); heldRefDraft(sync); emit SAME_PAGE_MOVE
  // expect(textbox().value).toBe("see [[Fresh Idea]]");
  // advance 5000; expect(sync.sent).toEqual([]);   // still held
  // fireEvent.blur(textbox()); expect(sync.sent.flat()).toContainEqual(HELD_TEXT_OP);
});

test("Cmd+Z on a resumed draft shows the undone text", () => {
  // focus "first", type "typed", emit SAME_PAGE_MOVE, undoKey()
  // expect(textbox().value).toBe("first");
  // expect(sync.sent.flat()).toContainEqual({ op: "update_text", uid: "u1",
  //   text: "typed", base_text_hash: sha256Hex("first"), page_title: "Page" });
});
```

- [ ] **Step 2: Run them and see them fail for the stated reason**

Run: `cd web && pnpm vitest run src/views/EditablePage.test.tsx -t "resumed|remounted|remote same-page move|moves and edits"`
Expected: the first five FAIL at their first value assertion after the move, because the remounted textarea shows the tree's text (`"first"`, `"remote"`, `"child"`), not the draft. The Cmd+Z test PASSES before the fix (the undo path flushes `pendingRef` whatever the textarea shows): it is a pin that the resumed, dirty textarea still settles after an undo, not a red test.

- [ ] **Step 3: Add `pendingDraft(uid: string): string | null` to `OutlineHandlers` in `web/src/outline/handlers.ts`** with the doc comment from Interfaces.

- [ ] **Step 4: Implement `pendingDraft` in `useOutline`'s `handlers` `useMemo`**

It returns `pendingRef.current.text` when `pendingRef.current?.uid === uid`, else `null`. No state, no flush, no new deps.

- [ ] **Step 5: Add `resume` to `useBlockDraft` and wire it in `BlockInput`**

- `useBlockDraft`: call `resume()` exactly once, at mount (a lazy `useState` initialiser). When it returns a string: the `draft` state starts from it instead of `text`, `dirtyRef` starts `true`, and `initialCursorRef` starts at the resumed text's length instead of `cursor`. When it returns `null`, behaviour is unchanged. Update the `cursor` option's doc comment to say a resumed draft places the caret at its end. The existing mount-time adoption effect needs no change: a dirty draft is kept, and a resumed draft the tree already holds goes clean.
- `BlockInput`: pass `resume: () => handlers.pendingDraft(node.uid) ?? null`. The `?? null` is for handler fakes that return `undefined`.
- Add `pendingDraft: vi.fn(() => null)` to the three literal handler fakes listed under Files.

- [ ] **Step 6: Write the `BlockInput` unit test in `web/src/components/BlockInput.test.tsx`**

```ts
test("a textarea mounting over a pending draft shows it and keeps its base", () => {
  const h = handlers();
  vi.mocked(h.pendingDraft).mockImplementation(
    (uid) => (uid === "u1" ? "draft text" : null));
  const { rerender } = mount(h, 0);
  expect(focusedTextarea().value).toBe("draft text");
  expect(focusedTextarea().selectionStart).toBe("draft text".length);
  // Dirty from the start: a tree change does not replace it.
  rerender(inputElement(h, { ...NODE, text: "remote" }));
  expect(focusedTextarea().value).toBe("draft text");
  // Its first edit starts no new draft, so the pending draft keeps its base.
  fireEvent.change(focusedTextarea(), { target: { value: "draft text!" } });
  expect(h.onDraftStart).not.toHaveBeenCalled();
  expect(h.onDraftChange).toHaveBeenCalledWith("u1", "draft text!");
});
```

Run: `cd web && pnpm vitest run src/components/BlockInput.test.tsx -t "pending draft"` — Expected: PASS (it was written after the hook change; it pins the hook's contract directly).

- [ ] **Step 7: Run the Step 1 tests and the neighbouring suites**

Run: `cd web && pnpm vitest run src/views src/outline src/components`
Expected: all PASS, including every existing draft/flush test in `EditablePage.test.tsx` and `EditablePage.draftFlush.test.tsx`. Then `pnpm typecheck && pnpm lint && pnpm check:fcis` — clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/outline/handlers.ts web/src/outline/useOutline.ts \
  web/src/outline/useBlockDraft.ts web/src/components/BlockInput.tsx \
  web/src/components/BlockInput.test.tsx web/src/components/EditableBlockTree.test.tsx \
  web/src/components/AutocompletePopup.test.tsx web/src/views/EditablePage.test.tsx
git commit -m "fix(pkm-sfp1): a remounted textarea resumes the pending draft"
```

---

### Task 2: Real-browser check: a remote reparent under a draft

jsdom does not model what Chromium does when the focused element is removed. This spec confirms, in a real browser, that the reparent remounts the textarea with no blur and that the fix resumes the draft. It uses a flush-held `#tag` draft, so no debounce timer races the remote op.

**Files:**
- Create: `web/e2e/remote-move-draft.spec.ts`

**Interfaces:**
- Consumes: `test`, `expect` from `./fixtures`; `waitForServerText` from `./server-state`. Copy the local `login` helper pattern from `e2e/edit.spec.ts` (wait for `.ws-banner` count 0).

- [ ] **Step 1: Write the spec**

Test name: `"a remote reparent of the block being typed in keeps the typed text"`. Steps, with `stamp = Date.now()`, `title = \`Remote Move Draft ${stamp}\``, `tag = \`SfpHeld${stamp}\``, uids of 32 chars or fewer built from the stamp:
1. `login(page)`; `POST /api/pages { title }`; `POST /api/ops` with `client_id: "e2e-remote-move"`, a unique `batch_id`, and two `create` ops (`u1` "first" order 0, `u2` "second" order 1, `parent_uid: null`, `page_title: title`).
2. `page.goto(/page/<encoded title>)`; click the text "first"; `page.keyboard.type(\` #${tag}\`)` (caret at the end, mid-tag, so the draft is held).
3. `POST /api/ops` from the same other client id: `{ op: "move", uid: u1, parent_uid: u2, order_idx: 0, page_title: title }`.
4. `await expect(page.locator(".block-children textarea.block-input")).toBeFocused()` (the remount happened and the new textarea took focus), then `toHaveValue(\`first #${tag}\`)`.
5. `page.keyboard.type("x")`; blur by clicking `h1.page-title`; `waitForServerText(page, title, \`first #${tag}x\`)`.
6. `finally`: `DELETE /api/page/<title>` and `DELETE /api/page/<tag>x` (the flush creates the tag's page).

- [ ] **Step 2: Run it against the pre-fix code and record the result**

Temporarily restore the four runtime files from `main`: `git checkout main -- web/src/outline/handlers.ts web/src/outline/useOutline.ts web/src/outline/useBlockDraft.ts web/src/components/BlockInput.tsx`. Build with `cd web && pnpm exec vite build` (not `pnpm build`: its `tsc` would reject the test fakes' new member), then run:
`cd web && E2E_PORT=<your port> node tooling/runPlaywright.mjs e2e/remote-move-draft.spec.ts`
Expected: FAIL at step 4's `toHaveValue` (the textarea shows `"first"`). Restore the files with `git checkout HEAD -- <the same four files>` and confirm `git status -sb` is clean. If it PASSES pre-fix, Chromium delivered a blur that flushed the draft: record that on the bean and keep the spec as a guard.

- [ ] **Step 3: Run it on the fix**

Run: `cd web && pnpm build && E2E_PORT=<your port> node tooling/runPlaywright.mjs e2e/remote-move-draft.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/e2e/remote-move-draft.spec.ts
git commit -m "test(pkm-sfp1): real-browser check that a remote reparent keeps the draft"
```

---

### Task 3: Docs

**Files:**
- Modify: `docs/architecture/frontend-editor.md` § "Drafts and commit points" (the paragraph that ends "…so nothing else would flush it.", currently around line 194)
- Modify: `docs/troubleshooting.md` (the frontend-editor table, next to the two pkm-impk rows around lines 59-60)

- [ ] **Step 1: Invoke the `architecture-docs` skill** and follow it for the edit below.

- [ ] **Step 2: Add the note to § "Drafts and commit points"**

What it must say (wording is yours, keep it short, no bean id): a remote batch that reparents the focused block or one of its ancestors remounts its textarea, again with no blur, while the draft is still pending. `BlockInput` asks `handlers.pendingDraft(uid)` at mount, and `useBlockDraft` resumes that text dirty with the caret at its end, so the tree's text does not replace it and the draft keeps its base. Put it next to the existing sentence about a remote removal unmounting with no blur, not in a new section.

- [ ] **Step 3: Add the troubleshooting row**

| Symptom | Cause | Where | Ref |
|---|---|---|---|
| Text typed just before another device moved the block within the same page is lost; only what was typed after the move is saved | The move remounted the textarea with no blur, and the new one showed the tree's text while the draft was still pending, so the next keystroke replaced the draft. A mounting textarea resumes the pending draft for its block, dirty, with the draft's base kept | [frontend-editor.md § Drafts and commit points](architecture/frontend-editor.md#drafts-and-commit-points) | pkm-sfp1 |

- [ ] **Step 4: Check the docs**

Run: `node .claude/skills/architecture-docs/check-docs.mjs docs/architecture/frontend-editor.md docs/troubleshooting.md`
Expected: no findings. Also confirm "about thirty named callbacks" in § "Which way the editor's dependencies point" still reads true (it does with one more member; leave it).

- [ ] **Step 5: Commit** (docs-only; no test run needed)

```bash
git add docs/architecture/frontend-editor.md docs/troubleshooting.md
git commit -m "docs(pkm-sfp1): add the remount resume to drafts and commit points; troubleshooting row"
```

---

### Task 4: Verification and bean close-out

- [ ] **Step 1: Web gates**

Run: `cd web && pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`
Expected: all clean; coverage thresholds met. Server is untouched: no server run.

- [ ] **Step 2: The new e2e spec, alone**

Run: `cd web && E2E_PORT=<your port> node tooling/runPlaywright.mjs e2e/remote-move-draft.spec.ts`
Expected: PASS. Do not run the full suite or `perf/check.sh`.

- [ ] **Step 3: Bean close-out**

Tick the three checklist items on pkm-sfp1. Append `## Summary of Changes`: the `pendingDraft` port query, `useBlockDraft`'s `resume` (dirty start, caret at end, base untouched), the six component tests and the `BlockInput` pin, the e2e spec and its pre-fix result, the docs touched. Then `beans update pkm-sfp1 -s completed`. Check `git status -sb`, then:

```bash
git add .beans/
git commit -m "chore(pkm-sfp1): close out"
```
