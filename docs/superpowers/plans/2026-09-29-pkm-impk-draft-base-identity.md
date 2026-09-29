# A draft carries its own base identity (pkm-impk) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor draft records the text it was typed over, so its flush carries the hash of that text (not of whatever the tree holds at flush time) and still ships when a remote batch has taken the block out of this outline.

**Architecture:** The draft grows from `{ uid, text }` to `{ uid, text, base }`. A pure `captureDraft` (outlineState.ts) sets `base` on the first change and keeps it; a pure `pendingTextOps(pending, blocks, pageTitle)` stamps `base_text_hash`/`page_title` from it and emits the op whether or not the block is still present. `useOutline.ts` wires both in, strips the stamps before recording undo history, and flushes a live draft before adopting a new parent `initial`. The server is unchanged: it already classifies a hashed edit to a missing block as an orphan edit and lands it on today's daily note.

**Tech Stack:** TypeScript, React 18, vitest + Testing Library (web); Python, pytest (server contract pin only).

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md` § F3 (plus § Shared rules, § Verification per branch). Finding: `docs/2026-09-29-sync-subsystem-review-consolidated.md` § F3. Bean: `pkm-impk` (parent epic `pkm-a4t2`).

## Global Constraints

- Run `beans prime` at session start. Work only inside your worktree root; run `git status -sb` before every commit to confirm you are on the feature branch in the worktree, not the main checkout.
- TDD: every fix's failing test is run and seen red before the fix is written. Contract pins that already pass say so in their step.
- Every runtime file keeps its `// pattern: Functional Core` or `// pattern: Imperative Shell` header. The new pure logic goes in `web/src/outline/outlineState.ts` and `web/src/outline/baseTextHash.ts` (both Functional Core); `useOutline.ts` stays a thin Imperative Shell caller.
- Code comments state the rule. They carry no bean id (no `pkm-xxxx` in any comment you write or rewrite). Commit messages may carry `pkm-impk`.
- Editor text edits ride the draft/key-edit path, never tree-direct. This plan changes only what a flush emits; do not add any path that writes the focused block's text to the tree directly.
- Docs in the same branch: `frontend-editor.md § Drafts and commit points` and its rules table, `sync-and-offline.md § Conflicts at push time` (order independence; D7's "Nothing is discarded" sentence scoped), the `backend.md` shared-fixtures table (new fixture), and one row in `docs/troubleshooting.md` (symptom, cause, owning section, bean id). Every `docs/architecture/` edit is made under the `architecture-docs` skill.
- A new shared fixture (`shared/fixtures/draft_flush.json`) is consumed by both suites; keep both green. `missing_targets.json` is NOT changed: its case `hashed-update_text-on-missing-block-lands-as-orphan-edit` already pins the hashed missing-block op on both sides (`web/src/replica/missingTarget.test.ts`, `server/tests/test_ops_core.py::test_classify_missing_target_matches_shared_fixture`).
- No route or contract change: no `openapi.json` regen.
- Verification: `cd web && pnpm verify` (use `set -o pipefail` if piping), `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check` (a server test file changes), then `perf/check.sh` (auto picks both sides because `server/tests/` changes; the side name is `frontend`, not `web`). AGENTS.md rules for regression / unstable / stale baseline apply.

## Verified code facts (at af5b95d3)

- Draft capture: `web/src/outline/useOutline.ts:294-306` `onDraftChange` sets `pendingRef.current = { uid, text }` (`:295`); `pendingRef` declared `:100`; `TEXT_DEBOUNCE_MS = 500` (`:40`); a held draft returns before arming the timer (`:304`).
- Flush: `takePendingTextOps` (`:160-170`) clears `pendingRef` then calls `pendingTextOps(pending, blocksRef.current)`; the stale "would doom the whole batch" comment is `:167-168`. `run()` (`:174-216`) stamps with `stampBaseTextHashes(pre, pageTitle, ops)` (`:189`) and records `ops` (unstamped) in history (`:207-214`).
- `pendingTextOps` is `web/src/outline/outlineState.ts:342-350`; returns `[]` for a missing node (`:348`); docstring `:338-341`. Tests `outlineState.test.ts:334-353`; the loss is pinned at `:346-349`.
- `stampBaseTextHashes` (`baseTextHash.ts:40-42`, `:57-71`) stamps only an undefined field and still applies a pre-stamped op to its walking tree (`:74`), so a later op on the same uid in the batch chains from the draft text.
- `applyOps` skips an unknown uid (`tree.ts:236`); a remote cross-page move removes the block from the source outline (`tree.ts:253-256`).
- Undo history records unstamped ops on purpose; `undoManager.dispatch` stamps at replay (`undoManager.ts:93-117`), and `stampBaseTextHashes` keeps a supplied hash. Guarded by `useOutline.undo.test.tsx:137` "run() records UNSTAMPED ops, so a redo hashes the current text".
- **Not named in the spec or the bean:** two component tests also pin the F3 loss and must be inverted: `web/src/views/EditablePage.test.tsx:356` "focused block with a pending draft keeps the draft; it wins on flush" (asserts `base_text_hash: sha256Hex("remote")`) and `:523` "draft for a remotely-deleted block is dropped, not flushed" (asserts `sent` is `[]`).
- Server: `ops_core.classify_text_edit` (`ops_core.py:268-278`) gives identical / clean / conflict; check 5 (`:705-712`) keeps the incoming text and lands the overwritten one under a daily-note header. Existing pins: `test_live_conflict_goes_to_daily_note_not_the_page`, `test_orphan_conflict_names_hinted_page` (`server/tests/test_ops_endpoint.py:355`, `:403`).

### The `initial`-change effect: trace result

`useOutline.ts:145-158` clears `pendingRef` without flushing when a parent passes an `initial` that is not the session snapshot. Every production parent passes the snapshot array itself, so the effect normally exits at `:154`:

- `PageView.tsx:43-45` and `EditableSidebarPanel.tsx:34` pass `payload.blocks`, which `useOutlinePageLoad.ts:108-111` and `:131-135` set to `handle.getSnapshot().blocks`.
- `Journal.tsx:112` sets `blocks: session.getSnapshot().blocks`, passed at `:217`.

The effect is still reachable with a live draft. `publish` replaces the snapshot synchronously (`outlineSessions.ts:177-183`) on every `applyRemote` (`:634-646`) and `applyLocal` (`:618-627`). A WebSocket batch is its own task and can land between the parent's `setState` and the passive effect. The effect then sees `initial !== snapshot` and drops the draft. That window opens on each parent re-publish that can happen mid-typing: PageView's resync reload (`PageView.tsx:27-28`), a parent-read election (`useOutlinePageLoad.ts:170-172`), and Journal's in-place head reload after `reset`. **Outcome: reachable, through a narrow race, so the draft is flushed first (Task 3).** Flushing before `beginAuthoritativeRead` makes the draft a relevant write. `transitionOutline` then defers the parent tree until that write settles (`outlineState.ts:222-237`, `:290-301`), so the typed text is not overwritten locally.

## Review Focus

1. Keystrokes after a remote update keep the original base. The base must not be recaptured on each change. Test: Task 2, "keystrokes after a remote update keep the draft's first base".
2. The next draft after a flush takes the flushed text as its base, not the previous draft's base. Test: Task 2, "the draft after a flush bases on the flushed text".
3. A redo of a flushed draft must hash the tree at replay time. If history recorded the stamped op, the redo would carry the old base hash and land a spurious `[[conflict]]`. Test: the existing `useOutline.undo.test.tsx:137` must stay green; Task 2 adds the strip that keeps it green.
4. A user types, then deletes back to the original text, while a remote edit lands underneath. Nothing is sent, so the remote edit is not reverted. Test: Task 1, "drops a draft typed back to its base, even over a remote edit".
5. Enter (split) straight after a remote update under a draft. The batch's text op carries the base hash, and the create follows it. Test: Task 2, "Enter after a remote update under a draft stamps the split batch with the base".

---

### Task 1: Pure draft core: `captureDraft`, `pendingTextOps` with base, `withoutStamps`

**Files:**
- Modify: `web/src/outline/outlineState.ts:338-350`
- Modify: `web/src/outline/baseTextHash.ts` (add one export)
- Test: `web/src/outline/outlineState.test.ts:334-353`, `web/src/outline/baseTextHash.test.ts`

**Interfaces:**
- Produces (outlineState.ts):
  - `export interface PendingDraft { uid: string; text: string; base: string | null }`. `base` is the tree text when the draft started, or `null` when the tree lacked the block at that moment.
  - `export function captureDraft(prev: PendingDraft | null, uid: string, text: string, blocks: BlockNode[]): PendingDraft`. Keeps `prev.base` when `prev?.uid === uid`; otherwise `base = findNode(blocks, uid)?.text ?? null`.
  - `export function pendingTextOps(pending: PendingDraft | null, blocks: BlockNode[], pageTitle: string): UpdateTextOp[]`. Returns `[]` when `pending` is null, when `text === base`, or when the node is present with `node.text === text`. Otherwise it returns one op `{ op: "update_text", uid, text, page_title: pageTitle }`, plus `base_text_hash: sha256Hex(base)` when `base !== null`, whether or not the node is present. (With `base === null`, `stampBaseTextHashes` behaves as it does today.)
- Produces (baseTextHash.ts): `export function withoutStamps(op: UpdateTextOp): UpdateTextOp`. Returns a copy with neither `base_text_hash` nor `page_title`.

- [ ] **Step 1: Write the failing tests** in the existing `pendingTextOps` block of `outlineState.test.ts`. Import `sha256Hex` from `../replica/sha256`. Pass `"Page"` as `pageTitle` in every call. Update the existing calls to the new draft shape:
  - "flushes a changed pending draft before a structural op": `({uid:"u1", text:"typed", base:"old"}, [block("u1","old")], "Page")` → `[{ op:"update_text", uid:"u1", text:"typed", base_text_hash: sha256Hex("old"), page_title:"Page" }]`.
  - "drops a no-op pending draft whose text is unchanged": `base:"same"`, tree `"same"` → `[]`.
  - Invert `:346` and rename it "flushes a draft whose block a remote batch deleted, stamped with its base": `({uid:"gone", text:"typed", base:"old"}, [block("u1","old")], "Page")` → `[{ op:"update_text", uid:"gone", text:"typed", base_text_hash: sha256Hex("old"), page_title:"Page" }]`.
  - "has nothing to flush without a pending draft": `(null, [block("u1","old")], "Page")` → `[]`.
  - New "stamps the base, not the tree, when a remote edit landed under the draft": `({u1, text:"typed", base:"old"}, [block("u1","remote")])` → `base_text_hash: sha256Hex("old")`.
  - New "drops a draft typed back to its base, even over a remote edit": `({u1, text:"old", base:"old"}, [block("u1","remote")])` → `[]`.
  - New "drops a draft a remote edit already made": `({u1, text:"same", base:"old"}, [block("u1","same")])` → `[]`.
  - New "a draft with no captured base carries page_title and no hash": `({uid:"gone", text:"typed", base:null}, [], "Page")` → `[{ op:"update_text", uid:"gone", text:"typed", page_title:"Page" }]`, and `ops[0]` has no `base_text_hash` property.
  - New `describe("captureDraft")`:
    - "captures the tree text as base on the first change": `(null,"u1","a",[block("u1","old")])` → `{uid:"u1", text:"a", base:"old"}`.
    - "keeps the base across later changes even when the tree moved on": `({uid:"u1",text:"a",base:"old"},"u1","ab",[block("u1","remote")])` → `{uid:"u1", text:"ab", base:"old"}`.
    - "recaptures for a different block": `({uid:"u1",text:"a",base:"old"},"u2","x",[block("u1","old"),block("u2","two")])` → `{uid:"u2", text:"x", base:"two"}`.
    - "records a null base for a block the tree lacks": `(null,"gone","x",[])` → `{uid:"gone", text:"x", base:null}`.
  - `baseTextHash.test.ts`, new "withoutStamps drops both stamps and keeps the op": `withoutStamps({op:"update_text", uid:"a", text:"t", base_text_hash:"h", page_title:"P"})` equals `{op:"update_text", uid:"a", text:"t"}`.

- [ ] **Step 2: Run them and confirm they fail**
  Run: `cd web && pnpm vitest run src/outline/outlineState.test.ts src/outline/baseTextHash.test.ts`
  Expected: FAIL. `captureDraft` and `withoutStamps` are not exported; the stamped expectations and the inverted missing-block case fail.

- [ ] **Step 3: Implement** `PendingDraft`, `captureDraft` and the new `pendingTextOps` in `outlineState.ts`, and `withoutStamps` in `baseTextHash.ts`. Import `UpdateTextOp` from `../api/ops` and `sha256Hex` from `../replica/sha256`. Rewrite the `pendingTextOps` docstring to say the rule: the op carries the hash of the text the draft was typed over. It ships when the block is gone, because the server lands an edit to a missing block on today's daily note. It is suppressed only when nothing changed, or when the tree already holds the text. Remove "would doom the whole batch".

- [ ] **Step 4: Run them and confirm they pass** (same command). Expected: PASS. Do not commit: `pnpm typecheck` now fails at the `useOutline.ts` call sites, and Task 2's commit carries Task 1 along with it.

---

### Task 2: Wire the base into `useOutline`; invert the component tests

**Files:**
- Modify: `web/src/outline/useOutline.ts:100`, `:160-170`, `:174-216`, `:269-273`, `:294-306`
- Modify (comment only): `web/src/outline/useBlockDraft.ts:67-71`
- Test: `web/src/views/EditablePage.test.tsx:356-376`, `:523-534`, plus new tests beside them

**Interfaces:**
- Consumes: `PendingDraft`, `captureDraft`, `pendingTextOps(pending, blocks, pageTitle)`, `withoutStamps` from Task 1.
- Produces: `takePendingTextOps(): UpdateTextOp[]`. Its ops are already stamped from the draft's base.

- [ ] **Step 1: Write the failing tests** in `EditablePage.test.tsx`. Use its `mount`, `focusBlock`, `heldRefDraft`, `HELD_TEXT_OP`, fake timers and the `stubFetch([["/api/titles", { titles: [] }]])` stub. Remote batches come from `sync.emit({ client_id: "other", ts: 1, ops: [...] })`. A cross-page move is `{ op: "move", uid: "u1", parent_uid: null, order_idx: 0, page_title: "Elsewhere" }`. A tab hide is the `visibilityState`/`visibilitychange` sequence from "hiding the tab flushes the pending draft immediately".
  - Invert `:356`, renamed "a remote update under a debounced draft: the flush carries the draft's base hash". The textarea still reads `"typed"` after the emit. After 500 ms, `sent` equals `[[{ op:"update_text", uid:"u1", text:"typed", base_text_hash: sha256Hex("first"), page_title:"Page" }]]`. Replace its LWW comments with the rule.
  - Invert `:523`, renamed "a debounced draft whose block a remote batch deleted still flushes". Type `"kept draft"`, emit `{op:"delete", uid:"u1"}`, advance 500 ms. `sent` equals `[[{ op:"update_text", uid:"u1", text:"kept draft", base_text_hash: sha256Hex("first"), page_title:"Page" }]]`.
  - New "a held draft under a remote update flushes on blur with its base hash": `heldRefDraft(sync)`, emit `update_text u1 "remote"`, `fireEvent.blur(ta)`. `sent.flat()` contains `HELD_TEXT_OP`.
  - New "a held draft whose block a remote batch deleted flushes on tab hide": `heldRefDraft(sync)`, emit a delete of u1, hide the tab. `sent.flat()` contains `HELD_TEXT_OP`.
  - New "a debounced draft whose block a remote cross-page move took still flushes": type `"moved draft"`, emit the move, advance 500 ms. `sent` equals `[[{ op:"update_text", uid:"u1", text:"moved draft", base_text_hash: sha256Hex("first"), page_title:"Page" }]]`.
  - New "a held draft whose block a remote cross-page move took flushes on tab hide": `heldRefDraft(sync)`, emit the move, hide the tab. `sent.flat()` contains `HELD_TEXT_OP`.
  - New (Review Focus 1) "keystrokes after a remote update keep the draft's first base": change to `"t1"`, emit `update_text u1 "remote"`, change to `"t12"`, advance 500 ms. The single op carries `base_text_hash: sha256Hex("first")`.
  - New (Review Focus 2) "the draft after a flush bases on the flushed text": change to `"one"`, advance 500 ms, change to `"one two"`, advance 500 ms. `sent[1][0]` has `base_text_hash: sha256Hex("one")`. (This guard passes before the fix too.)
  - New (Review Focus 5) "Enter after a remote update under a draft stamps the split batch with the base": change to `"first!"`, emit `update_text u1 "remote"`, `setSelectionRange(6, 6)`, press Enter. `sent[0][0]` equals `{ op:"update_text", uid:"u1", text:"first!", base_text_hash: sha256Hex("first"), page_title:"Page" }`, and `sent[0][1]` matches `{ op:"create", page_title:"Page" }`.

- [ ] **Step 2: Run them and confirm they fail**
  Run: `cd web && pnpm vitest run src/views/EditablePage.test.tsx`
  Expected: FAIL. The update cases show `sha256Hex("remote")`; the delete and move cases show `sent` empty; the split case shows the remote hash.

- [ ] **Step 3: Implement in `useOutline.ts`**
  - `pendingRef` becomes `useRef<PendingDraft | null>(null)`.
  - In `onDraftChange`: `pendingRef.current = captureDraft(pendingRef.current, uid, text, blocksRef.current)`. The timer and hold logic are unchanged.
  - `takePendingTextOps` returns `UpdateTextOp[]` and calls `pendingTextOps(pending, blocksRef.current, pageTitle)`. Add `pageTitle` to its deps. Replace the `:167-168` comment with the rule: the draft ships even when its block has left the tree; its hash is of the text it was typed over.
  - In `run()`: the history entry records `[...textOps.map(withoutStamps), ...result.ops]`, not `ops`. Extend the existing "Deliberately the UNSTAMPED ops" comment: the flushed text op arrives already stamped with the draft's base, so its stamps are stripped here. `invertOps(pre, pageTitle, ops)` and the enqueue path are unchanged.
  - Rewrite the remote-batch comment (`:269-273`): the tree takes remote text under a draft, the textarea keeps the draft, and the flush carries the hash of the draft's base. The server therefore keeps the other text as a conflict copy, whichever edit arrives first. Rewrite the parenthetical in `useBlockDraft.ts:67-71` the same way ("the draft's flush carries its base hash, so the server keeps the remote text as a conflict copy" in place of "last-write-wins").

- [ ] **Step 4: Run the tests and confirm they pass**
  Run: `cd web && pnpm vitest run src/views/EditablePage.test.tsx src/outline && pnpm typecheck`
  Expected: PASS. `useOutline.undo.test.tsx:137` "run() records UNSTAMPED ops..." must pass. If it fails with `sha256Hex("alpha")` in place of `sha256Hex("two")`, the history strip is missing.

- [ ] **Step 5: Commit**
  ```bash
  git add web/src/outline/outlineState.ts web/src/outline/outlineState.test.ts web/src/outline/baseTextHash.ts web/src/outline/baseTextHash.test.ts web/src/outline/useOutline.ts web/src/outline/useBlockDraft.ts web/src/views/EditablePage.test.tsx
  git commit -m "fix(pkm-impk): a draft carries its base; its flush stamps that hash and ships when the block is gone"
  ```

---

### Task 3: Flush a live draft before adopting a new parent `initial`

**Files:**
- Modify: `web/src/outline/useOutline.ts:142-158` (move the effect below `flushNow`, `:218-220`)
- Test: `web/src/outline/useOutline.reconciliation.test.tsx`

**Interfaces:**
- Consumes: `flushNow` (existing).

- [ ] **Step 1: Write the failing test** "a new parent tree flushes a live draft before adopting it" in `useOutline.reconciliation.test.tsx`, using its `Harness`.
  - Setup: `stubFetch([["/api/page/", pagePayload("Page A", [block("a", "server A")])]])` and `sync = makeSync("connected", { settled: () => new Promise(() => undefined) })`.
  - Render with `initial=[block("a","old A")]`. In `act`: `onFocusBlock("a", 0)`, then `onDraftChange("a", "typed", true)` (held, so no timer is involved).
  - Rerender with a fresh `initial=[block("a","server A")]`.
  - Assert `sync.sent` equals `[[{ op:"update_text", uid:"a", text:"typed", base_text_hash: sha256Hex("old A"), page_title:"Page A" }]]`.
  - Then `act(() => outline.handlers.onBlurBlock("a"))`. `sync.sent` still has length 1: the draft was consumed, not duplicated.

- [ ] **Step 2: Run it and confirm it fails**
  Run: `cd web && pnpm vitest run src/outline/useOutline.reconciliation.test.tsx`
  Expected: FAIL. `sent` is `[]`, because the effect nulls `pendingRef`.

- [ ] **Step 3: Implement.** Move the `receivedInitialRef` effect below `flushNow`. Replace `pendingRef.current = null` with a `flushNow()` call placed after the `!handle` and snapshot-identity early returns and before `beginAuthoritativeRead("parent")`. Deps: `[initial, flushNow]`; the `receivedInitialRef` guard makes a re-run with an unchanged `initial` a no-op. Comment the rule: a parent tree never discards a draft. Flushing first makes the draft a relevant write, so the parent tree is deferred until that write settles.

- [ ] **Step 4: Run the tests and confirm they pass**
  Run: `cd web && pnpm vitest run src/outline src/views && pnpm typecheck`
  Expected: PASS, including `EditablePage.test.tsx`'s two "stale initial rerender" tests (`:64`, `:99`).

- [ ] **Step 5: Record the trace on the bean.** Run `beans update pkm-impk --body-append -` with a `## Initial-effect trace` section. It is the "trace result" paragraph above, condensed to the file:line evidence plus "reachable via a narrow race; now flushes first". Tick that checklist item.

- [ ] **Step 6: Commit**
  ```bash
  git add web/src/outline/useOutline.ts web/src/outline/useOutline.reconciliation.test.tsx .beans/
  git commit -m "fix(pkm-impk): a new parent tree flushes a live draft instead of dropping it"
  ```

---

### Task 4: Composed test across the editor/server boundary

The web half renders the real `EditablePage`: textarea, `useBlockDraft`, `useOutline`, the outline session, a remote batch through the sync feed, and stamping at `sync.enqueue`. The server half posts the exact op the web half asserts. One shared fixture binds the two halves.

**Files:**
- Create: `shared/fixtures/draft_flush.json`
- Create: `web/src/views/EditablePage.draftFlush.test.tsx`
- Modify: `server/tests/test_ops_endpoint.py` (after `test_orphan_conflict_names_hinted_page`, `:403-410`)

**Interfaces:**
- Fixture, exactly: `{"page_title": "Machine Learning", "uid": "uid_b1", "base": "base words", "remote": "remote words", "draft": "draft words"}`. `uid` and `page_title` are the conftest seed's block and page. `base` is plain text because the seed's `Tags:: #AI` renders split across elements, which `getByText` cannot click. The server half first sets the block to `base` with one clean edit.
- The wire op both halves use: `{ op: "update_text", uid, text: draft, base_text_hash: sha256(base), page_title }`.

- [ ] **Step 1: Write the web half.** In `EditablePage.draftFlush.test.tsx`, load the fixture with `readFileSync(new URL("../../../shared/fixtures/draft_flush.json", import.meta.url), "utf-8")`, the pattern in `replica/missingTarget.test.ts:16-18`. Mount `EditablePage` with `title=page_title` and `initial=[block(uid, base)]` under `MemoryRouter` + `SyncContext`, with fake timers and the `/api/titles` stub. Click the block, change the textarea to `draft`, then:
  - "a remote update under a draft ships the fixture's wire op": emit `update_text uid remote`, advance 500 ms, `sent` equals `[[wireOp]]`.
  - "a remote delete under a draft ships the same wire op": emit `delete uid`, advance 500 ms, `sent` equals `[[wireOp]]`.

- [ ] **Step 2: Red-check the web half against the unfixed code.** The fix is already committed, so `git stash` would find nothing to save. Restore the pre-branch sources instead:
  Run: `F="web/src/outline/outlineState.ts web/src/outline/useOutline.ts web/src/outline/baseTextHash.ts"; git checkout "$(git merge-base HEAD main)" -- $F && (cd web && pnpm vitest run src/views/EditablePage.draftFlush.test.tsx); git checkout HEAD -- $F`
  Expected: both FAIL (the first with `sha256Hex("remote words")`, the second with `sent` empty). Afterwards `git status -sb` shows only the new test and fixture as changes.

- [ ] **Step 3: Write the server half** in `test_ops_endpoint.py`. Load `Path(__file__).parents[2] / "shared" / "fixtures" / "draft_flush.json"`. Build `remote_op = {"op":"update_text","uid":uid,"text":remote,"base_text_hash":text_hash(base)}` and `draft_op` = the wire op with `text_hash(base)`.
  - `@pytest.mark.parametrize("order", ["remote_first", "draft_first"])` `test_draft_flush_keeps_both_texts_whichever_arrives_first(client, order)`:
    - First set the block to the fixture's base with a clean edit: `_post(client, {"op":"update_text","uid":uid,"text":base,"base_text_hash":text_hash("Tags:: #AI")}, client_id="seed")`. Assert `base in _ml_texts(client)` and `_conflicts(client) == []`.
    - Post the two ops in `order` with `_post(..., client_id="other")` and `_post(..., client_id="editor")`; both return 200.
    - The second op's text is in `_ml_texts(client)`.
    - `_conflicts(client) == [("[[conflict]] [[Machine Learning]] — overwritten by ((uid_b1))", [first op's text])]`.
  - `test_draft_flush_after_delete_lands_on_the_daily_note(client)`: set the base the same way, then post `{"op":"delete","uid":uid}` as `"other"`, then `draft_op`; expect 200 and `_conflicts(client) == [("[[conflict]] [[Machine Learning]]" + ORPHAN_SUFFIX, [draft])]`.

- [ ] **Step 4: Run both halves**
  Run: `cd server && uv run pytest -q tests/test_ops_endpoint.py -k draft_flush` then `cd web && pnpm vitest run src/views/EditablePage.draftFlush.test.tsx`
  Expected: PASS on both. The server half is a contract pin and passes on first run, since the server is unchanged.

- [ ] **Step 5: Commit**
  ```bash
  git add shared/fixtures/draft_flush.json web/src/views/EditablePage.draftFlush.test.tsx server/tests/test_ops_endpoint.py
  git commit -m "test(pkm-impk): composed draft-flush fixture pinned by the editor and the ops route"
  ```

---

### Task 5: Docs

Invoke the `architecture-docs` skill before editing `docs/architecture/`. Verify each claim against the code as merged in Tasks 1-4.

**Files:**
- Modify: `docs/architecture/frontend-editor.md` § Drafts and commit points (`:162-181`) and § Rules an edit must not break, row `:157`
- Modify: `docs/architecture/sync-and-offline.md` § Conflicts at push time (`:229-258`)
- Modify: `docs/architecture/backend.md` shared-artifacts table (`:600-608`)
- Modify: `docs/troubleshooting.md` § Editor table (`:52-67`)

- [ ] **Step 1: frontend-editor.md § Drafts and commit points.** Add a short paragraph or table covering:
  - the draft's shape `{ uid, text, base }`, with `base` set at the first change and kept;
  - what the flush sends: `base_text_hash` of `base` plus `page_title`, even when the block has left the tree through a remote delete or cross-page move;
  - when it sends nothing: `text === base`, or the tree already holds the text;
  - the flushed text op is recorded in undo history with its stamps stripped;
  - a new parent `initial` flushes the draft first.
  Rewrite rules-table row `:157`: its "what breaks" cell becomes "without the draft's base, the flush hashes the remote text and overwrites it with no conflict copy".

- [ ] **Step 2: sync-and-offline.md § Conflicts at push time.** Add one sentence, linked to `frontend-editor.md#drafts-and-commit-points`: an editor flush hashes the text the user typed over, so two concurrent edits from the same base keep both texts whichever arrives first (the later one wins, the earlier one becomes the conflict copy). Scope D7: "Nothing is discarded: conflict blocks are ordinary blocks, …" becomes a statement about conflict blocks only, e.g. "A conflict copy is never discarded: …". Leave the stale-delete gap note to pkm-xjew.

- [ ] **Step 3: backend.md table.** Add a row: `shared/fixtures/draft_flush.json` | hand-maintained case | `tests/test_ops_endpoint.py` | `web/src/views/EditablePage.draftFlush.test.tsx`: the op an editor draft flushes is the op the ops route's conflict and orphan paths are tested with. `missing_targets.json` is also missing from this table; add it only if pkm-xjew has not claimed it (check that bean's body), otherwise leave it.

- [ ] **Step 4: troubleshooting.md, one row under § Editor.**
  - Symptom: another device's edit to a block vanishes with no `[[conflict]]` copy; or text typed just before another device deleted or moved the block is lost.
  - Cause: the draft kept no base, so the flush hashed the tree that already held the remote text, and a draft whose block had left the tree emitted nothing. The draft now records its base; the flush stamps it and ships even when the block is gone.
  - Where: `[frontend-editor.md § Drafts and commit points](architecture/frontend-editor.md#drafts-and-commit-points)`.
  - Ref: `pkm-impk`.

- [ ] **Step 5: Update pkm-xjew.** Use `beans update pkm-xjew --body-replace-old/--body-replace-new` on its D7 bullet to say the sentence scoping landed with pkm-impk and only the stale-delete open-gap note remains.

- [ ] **Step 6: Commit** (a docs-only commit needs no test run).
  ```bash
  git add docs/architecture/frontend-editor.md docs/architecture/sync-and-offline.md docs/architecture/backend.md docs/troubleshooting.md .beans/
  git commit -m "docs(pkm-impk): draft base identity; order-independent text conflicts; D7 scoped to conflict copies"
  ```
  The commit message body says what was corrected (rules-table row, D7) versus what was added (drafts paragraph, fixture row, troubleshooting row).

---

### Task 6: Verification, perf, bean close-out

- [ ] **Step 1: Web gate.** Run `cd web && set -o pipefail && pnpm verify 2>&1 | tail -40`. Expected: exit 0; typecheck, unit coverage and Playwright all pass. Known load-sensitive e2e flakes: re-run them alone before calling them flakes.
- [ ] **Step 2: Server gate.** Run `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`. Expected: all pass, coverage enforced.
- [ ] **Step 3: Perf.** Run `perf/check.sh` (auto; both sides, because `server/tests/` changed).
  - Regression: read your diff along the regressed path, fix, re-run; bring it to Arthur only if it survives.
  - Unstable: file a bean against the harness and carry on.
  - Stale baseline: `--rebaseline`.
  - Lost or reclassified: `--bootstrap`.
  Commit any baseline file the check rewrites (improvements). Keep the table for the review package.
- [ ] **Step 4: Bean close-out.** Tick every checklist item on pkm-impk. Append `## Summary of Changes`: the draft shape, the flush rule, the history strip, the initial-effect flush, the two extra component tests that pinned the loss, the composed fixture, the docs touched, and the perf result. Then `beans update pkm-impk -s completed`. Commit the bean file: `git add .beans/ && git commit -m "chore(pkm-impk): close out"`. Check `git status -sb` first.
