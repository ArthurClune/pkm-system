# Uploaded Files Each Go On Their Own Bullet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/upload`, an image paste, or a file drop onto the block being edited puts each upload in its own sibling block instead of splicing the links inline.

**Architecture:** A pure planner `planUploadBlocks` beside `planFileDropBlocks` in `web/src/outline/fileDrop.ts` turns (tree, current block, upload texts) into ops: an `update_text` filling the block when it is empty, plus `create`s straight after it. `useOutline`'s `handlers.onFiles` collects one markdown text per successful upload and applies the plan in one `run()`.

**Tech Stack:** React + TypeScript, vitest (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-upload-own-bullets-design.md`

## Global Constraints

- Work in the worktree `/Users/arthur/code/llm/pkm-upload-bullets` (branch `feat/upload-own-bullets`); every path below is relative to it.
- FCIS: `fileDrop.ts` stays `// pattern: Functional Core`; no I/O in it.
- Comment rules (`.githooks/pre-commit`): no bean ids, line numbers or plan pointers in code/test comments; comment lines at most 80 columns, code at most 120.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and never carry a session URL. Stage files by explicit path.
- Do NOT claim or update tasks in the task list. Do the work yourself, sequentially; no sub-agents.
- Drops between blocks (`onDropFiles`), `/goodlinks` and `/link-local-file` are unchanged.

## Review Focus

1. A paste into the block you are typing in, with text not yet flushed: the planner must see the flushed draft (it runs inside `run()`, which applies the draft first), so the block counts as non-empty and the typed text survives. Pinned by Task 2's "unflushed draft" test.
2. A block holding only whitespace counts as empty and is overwritten, not kept. Pinned in Task 1.
3. A block with children: new siblings land after the whole subtree, not as its first children. Pinned in Task 1.
4. Some uploads fail, others succeed: the successes still land as blocks, in upload order, and the banner names the failures. Pinned in Task 2.
5. The current block is deleted while uploads run: the blocks go to the end of the page and the page scrolls to the first. Pinned in Task 1 (plan) and Task 2 (scroll ref set).

---

### Task 1: `planUploadBlocks` planner

**Files:**
- Modify: `web/src/outline/fileDrop.ts`
- Test: `web/src/outline/fileDrop.test.ts`

**Interfaces:**
- Consumes: `planFileDropBlocks`, `FileDropPlan`, `DropTarget` (existing); `locate` from `./tree`; `orderIdxAfter`, `orderIdxAfterLast` from `./orderIdx`.
- Produces:
  ```ts
  export function planUploadBlocks(
    blocks: BlockNode[], pageTitle: CanonicalTitle, uid: BlockUid,
    texts: string[], uids: BlockUid[], focusedUid: BlockUid | null,
  ): FileDropPlan
  ```
  `uids` is index-aligned with `texts`; when the block is filled, `uids[0]` goes unused. `firstUid` is the uid of the block holding `texts[0]` (`uid` itself when filled). `fellBack` is true only when `uid` is gone.

- [ ] **Step 1: Write the failing tests** in a new `describe("planUploadBlocks")` in `fileDrop.test.ts`, reusing the file's `block`/`orderIdxOf`/`uidOf`/`canonicalTitleOf` helpers. Tree for all cases: root `A`(0), `B`(1) with child `B1`(0), `C`(2). Texts `["![x](/a)", "![y](/b)"]`, uids `n1`, `n2`.
  - `"adds every upload as a sibling after a block with text"`: on `A` → root texts `["A", "![x](/a)", "![y](/b)", "B", "C"]`; ops are exactly two `create`s with `parent_uid: null`; `A`'s text unchanged; `result.focus` null; `fellBack` false; `firstUid` `n1`.
  - `"places siblings after the block's whole subtree"`: on `B` → root texts `["A", "B", "![x](/a)", "![y](/b)", "C"]`, `B`'s children still `["B1"]`.
  - `"keeps a nested block's siblings at its depth"`: on `B1` → `B`'s children texts `["B1", "![x](/a)", "![y](/b)"]`, creates carry `parent_uid: "tuid-b"`.
  - `"fills an empty block with the first upload"`: `A` text `""` → first op `{ op: "update_text", uid: "tuid-a", text: "![x](/a)" }`, then one `create` (uid `n2`); root texts `["![x](/a)", "![y](/b)", "B", "C"]`; `firstUid` `"tuid-a"`.
  - `"treats a whitespace-only block as empty"`: `A` text `"  "` → same ops as above.
  - `"keeps the caret in a filled block that still owns focus"`: empty `A`, `focusedUid` `"tuid-a"` → `focus` `{ uid: "tuid-a", cursor: "![x](/a)".length }`; with `focusedUid` null → `focus` null; with text `"A"` and `focusedUid` `"tuid-a"` → `focus` null.
  - `"a single upload into a block with text becomes a new sibling"`: one text on `A` → one `create`, `A` unchanged.
  - `"falls back to the end of the page when the block is gone"`: uid `"tuid-gone"` → `fellBack` true, creates with `parent_uid: null` after `C`, `firstUid` `n1`.

- [ ] **Step 2: Run to verify they fail**
  Run: `cd web && pnpm vitest run src/outline/fileDrop.test.ts`
  Expected: FAIL, `planUploadBlocks` is not exported.

- [ ] **Step 3: Implement `planUploadBlocks`** in `fileDrop.ts`. Build the creates with `planFileDropBlocks` against target `{ parent_uid: located.parent?.uid ?? null, order_idx: orderIdxAfter(node.order_idx), page_title }` (gone block: `parent_uid: null`, `orderIdxAfterLast(blocks)`). When filling, prepend the `update_text` and re-run `applyOps` over the full op list from `blocks`. Update the module header comment to cover uploads into a block as well as drops. Doc comment on the function states the empty rule and the focus rule.

- [ ] **Step 4: Run to verify they pass**
  Run: `cd web && pnpm vitest run src/outline/fileDrop.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add web/src/outline/fileDrop.ts web/src/outline/fileDrop.test.ts && git commit -m "feat(upload): plan one block per upload into a block (pkm-tub8)"`

### Task 2: `onFiles` uses the planner

**Files:**
- Modify: `web/src/outline/useOutline.ts` (`handlers.onFiles`; move the `scrollToUidRef` declaration above the `handlers` `useMemo`)
- Modify: `web/src/outline/handlers.ts` (doc comment on `onFiles`: the boolean now means "something landed")
- Modify: `web/src/components/BlockInput.tsx` (`uploadFiles` local and its comment: rename `spliced` to `landed`; behaviour unchanged, it still calls `draft.settle()`)
- Test: `web/src/outline/useOutline.upload.test.tsx`

**Interfaces:**
- Consumes: `planUploadBlocks` (Task 1).
- Produces: `onFiles(uid, cursor, files): Promise<boolean>` — same signature; `cursor` is now unused by the planner but stays in the signature (callers unchanged). Resolves true when any upload landed.

- [ ] **Step 1: Rewrite the tests** in `useOutline.upload.test.tsx`. Update its header comment. Change the existing inline-splice expectations:
  - `"onFiles splices…"` → `"onFiles adds the upload as a new block after one with text"`: block `"hello"` stays `"hello"`; page has two root blocks, second text `![cat.png](${INFO.url})`.
  - `/upload dialog path` test: same new-block expectation, `focus` stays null.
  - `paste/drop path` test → `"a paste into a focused block with text leaves focus where it was"`: focus `{ uid: "tuid-u1", cursor: 5 }` unchanged, new sibling holds the image.
  - Add `"a paste into a focused empty block fills it and keeps the caret after it"`: block `""`, focused at 0 → its text is the markdown, `focus` `{ uid: "tuid-u1", cursor: markdown.length }`, one block on the page.
  - `"moving focus to another block during a slow upload"`: expect the new sibling and `focus` on `tuid-u2`.
  - Add `"several uploads become sibling blocks in upload order, one undo entry"`: stub `/api/assets` to return two infos in turn (`cat.png`, `dog.png`) → root texts `["hello", cat-md, dog-md]`; `sync.sent` has exactly one batch; after `handlers.onUndo()` (check the exact undo entry point in `useOutline.undo.test.tsx`) the page is back to `["hello"]`.
  - Add `"a failed upload among several still lands the others"`: first succeeds, second 500s → one new block, `uploadError` contains the failing name.
  - Add `"an unflushed draft keeps the block non-empty"`: focus empty block, `handlers.onDraftChange` (or the draft entry point `useOutline.draftHold.test.tsx` uses) with `"typed"`, then `onFiles` → block text `"typed"`, image in a new sibling.
  - Add `"a block deleted during the upload sends the blocks to the page end"`: delete the block mid-upload (as the slow-upload test defers fetch) → new block at the end of root.
  Keep the error-banner tests as they are.

- [ ] **Step 2: Run to verify the new expectations fail**
  Run: `cd web && pnpm vitest run src/outline/useOutline.upload.test.tsx`
  Expected: FAIL on the inline-splice assertions.

- [ ] **Step 3: Implement.** In `onFiles`: collect `texts: string[]` (one `assetMarkdown(info)` per success) instead of the space-joined string; mint `uids` with `newUid()`; inside `run()` call `planUploadBlocks(b, pageTitle, uid, texts, uids, focusRef.current?.uid ?? null)`, set `scrollToUidRef.current = plan.firstUid` when `plan.fellBack`, return `plan.result`, keep `{ freshAssets: fresh }`. Return true when `texts.length > 0`. Drop the now-unused `spliceUploadedMarkdown` import only if nothing else in the file uses it (`onGoodlinks` and `onLinkLocalFile` still do). Replace the long focus comment with one sentence pointing at the planner's focus rule.

- [ ] **Step 4: Run the outline tests and typecheck**
  Run: `cd web && pnpm vitest run src/outline src/components && pnpm typecheck`
  Expected: PASS. Any other test asserting the old inline splice for `onFiles` gets its expectation moved to the new shape, never deleted.

- [ ] **Step 5: Commit**
  `git add` the four files by path; `git commit -m "feat(upload): each upload into a block gets its own bullet (pkm-tub8)"`

### Task 3: E2E and docs

**Files:**
- Create: `web/e2e/upload-bullets.spec.ts`
- Modify: `docs/architecture/frontend-editor.md` (Files-drag table row "Over a textarea")
- Modify: `docs/keyboard.md` (`/upload` row)
- Modify: `.beans/pkm-tub8--uploaded-files-each-go-on-their-own-bullet.md` (tick items, summary)

- [ ] **Step 1: Write the spec**, following `e2e/paste.spec.ts`'s `login`/fresh-page pattern (create via `POST /api/pages` with seed blocks via `POST /api/ops`, delete the page in `afterEach`; unique PNG bytes per test as `undo-upload-release.spec.ts` does).
  - `"/upload with two images adds two sibling bullets"`: seed one block `"Photos"`; click it, type `/upload`, pick the command; `page.locator('input[type=file]').setInputFiles([...two PNG buffers...])`; poll `/api/page/<title>` until root texts are `["Photos", /^!\[a\.png\]/, /^!\[b\.png\]/]` and none has children.
  - `"pasting an image into an empty block fills it"`: empty seed block, focus it, dispatch a `ClipboardEvent("paste")` whose `DataTransfer` holds one PNG `File` → server root texts `[/^!\[p\.png\]/]`, one block.

- [ ] **Step 2: Run it**
  Run: `cd web && pnpm build && E2E_PORT=8975 node tooling/runPlaywright.mjs e2e/upload-bullets.spec.ts`
  Expected: PASS.

- [ ] **Step 3: Docs.** Invoke the `architecture-docs` skill. `frontend-editor.md`, "Over a textarea": `BlockInput` hands the files to `onFiles`, and `planUploadBlocks` puts each in its own sibling block (filling the block when empty). `keyboard.md` `/upload`: "Pick files to upload; each goes on its own bullet after this one (an empty block takes the first); an image shows inline". Check `files-and-assets.md` §`/goodlinks` still reads true (it borrows `/upload`'s pick-and-blur shape, not its splice).

- [ ] **Step 4: Full verification**
  Run: `set -o pipefail; cd web && pnpm verify`
  Expected: exit 0. Then `perf/check.sh frontend` from the repo root; a regression is investigated per AGENTS.md.

- [ ] **Step 5: Commit** spec, docs and bean by path: `git commit -m "test(upload): e2e for one bullet per upload; docs (pkm-tub8)"`
