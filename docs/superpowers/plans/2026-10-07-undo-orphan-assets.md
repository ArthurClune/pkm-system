# Undo Releases Orphaned Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Undoing an upload deletes the uploaded file from the asset store once redo is no longer possible, provided nothing references it.

**Architecture:** The server gains a conditional delete (`?if_unreferenced=true`) that refuses with 409 while any block references the asset. The client tags each history entry with the assets its upload freshly created; when a new edit discards redo entries, `undoManager` hands their assets to a new `sync/assetRelease.ts`, which waits for the undo's and the clearing edit's writes to be delivered and then sends the conditional delete. A `pagehide` hook does the same best-effort with `keepalive`.

**Tech Stack:** FastAPI + SQLite (server, pytest), React + TypeScript (web, vitest, Playwright).

**Spec:** `docs/superpowers/specs/2026-10-07-undo-orphan-assets-design.md`

## Global Constraints

- Worktree: `/Users/arthur/code/llm/pkm/.claude/worktrees/undo-orphan-assets`, branch `fix/pkm-w4ts-undo-orphan-assets`. Never touch `/Users/arthur/code/llm/pkm` directly.
- Query param name is exactly `if_unreferenced`; 409 when referenced, 404 unknown/malformed, 200 `{"deleted": true, "refs_removed": 0}` when deleted. Without the flag the route is unchanged.
- Fresh = upload response `existing: false`. A dedup hit is never released.
- No retry, no persisted state, no UI for the release. 200/404/409 are final; network errors are logged with `console.warn` and dropped.
- FCIS headers on every runtime file; no bean ids in code or comments; commits `fix(pkm-w4ts): ...` ending `Co-Authored-By: Claude <model> <noreply@anthropic.com>`; never a claude.ai URL in a commit message.
- Playwright on `E2E_PORT=8982`; never port 8974.

## Review Focus

1. Undo, then drop/paste the **same** file again elsewhere, then any edit: the file must survive (the re-upload is a dedup hit, the new block references it, the delete waits for that edit's delivery and gets 409). Pinned in Task 4 (unit) and Task 6 (e2e).
2. Undo, redo, then edit: nothing is released (the entry left the redo stack by redo, not by discard). Pinned in Task 4.
3. Undo of an upload on a page that is no longer mounted (the dispatch waits on a page read): the release must still wait for that undo's delivery, not fire early. Pinned in Task 4.
4. Several undos in a row (upload A, upload B, undo, undo, edit): both entries are discarded and both assets released. Pinned in Task 4.
5. A `/upload` that mixes a fresh upload and a dedup hit in one batch tags only the fresh sha. Pinned in Task 5.

---

### Task 1: Server conditional delete

**Files:**
- Modify: `server/src/pkm/server/routes_assets.py` (`delete_asset`, ~line 103)
- Test: `server/tests/test_asset_delete.py`
- Regenerate: `web/src/api/openapi.json`, `web/src/api/types.d.ts`
- Docs: `docs/architecture/backend.md` (API table row for `DELETE /api/assets/{sha256}`, ~line 782), `docs/architecture/files-and-assets.md` (Delete bullet)

**Interfaces:**
- Produces: `DELETE /api/assets/{sha256}?if_unreferenced=true` → 409 `{"detail": "asset is referenced"}` | 404 | 200 `{"deleted": true, "refs_removed": 0}`.

- [ ] **Step 1: Write failing tests** in `test_asset_delete.py`, reusing `_upload`, `_create_block`, `_block_text`, `_asset_path`:
  - `test_if_unreferenced_deletes_an_orphan`: upload, `DELETE ...?if_unreferenced=true` → 200, body `{"deleted": True, "refs_removed": 0}`, file gone, `assets` row gone.
  - `test_if_unreferenced_refuses_a_referenced_asset`: upload, create a block whose text is `f"![pic.png]({a['url']})"`, conditional delete → 409; block text unchanged; file and row still present.
  - `test_if_unreferenced_unknown_is_404`: random 64-hex sha → 404; `"not-a-sha"` → 404.
  - `test_without_flag_still_strips`: existing strip behaviour unchanged with a referenced asset (one assertion that `refs_removed == 1`, guards against the flag defaulting on).
- [ ] **Step 2: Run** `cd server && uv run pytest -q tests/test_asset_delete.py` → the new tests FAIL (422/200 instead of 409 etc.).
- [ ] **Step 3: Implement** `if_unreferenced: bool = False` on `delete_asset`. When set: `db.execute("BEGIN IMMEDIATE")` before the row lookup; if `referencing_blocks(db, sha)` is non-empty, `db.rollback()` and raise `HTTPException(409, "asset is referenced")`; otherwise delete the row, commit, unlink, `notify.nudge_threadpool`, return `{"deleted": True, "refs_removed": 0}`. Keep the strip path untouched. Extend the docstring with one paragraph: the flag's meaning, that check and delete share one write transaction, and that undo history is its caller.
- [ ] **Step 4: Run** the test file → PASS; then `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check` → all clean (`tests/test_openapi_sync.py` will fail until Step 5).
- [ ] **Step 5: Regenerate** `cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json && cd ../web && pnpm gen-types`; re-run `cd server && uv run pytest -q tests/test_openapi_sync.py` → PASS.
- [ ] **Step 6: Docs.** `backend.md` API row: append "; `?if_unreferenced=true` instead refuses with 409 while any block references it, and strips nothing". `files-and-assets.md` Delete bullet: one sentence on the conditional mode and that undo history (`sync/assetRelease.ts`) is its only caller.
- [ ] **Step 7: Commit** the route, test, openapi.json, types.d.ts and both docs.

### Task 2: History entries carry fresh assets; recordEntry reports discards

**Files:**
- Modify: `web/src/outline/history.ts` (`HistoryEntry`, `recordEntry`)
- Modify: `web/src/outline/undoManager.ts` (`recordHistory` adapts to the new return; behaviour unchanged in this task)
- Modify: `web/src/outline/useOutline.ts` (`run()` records `freshAssets: []` for now)
- Test: `web/src/outline/history.test.ts`; fix any test literal of `HistoryEntry` that now needs `freshAssets: []`

**Interfaces:**
- Produces:
  - `HistoryEntry.freshAssets: readonly Sha256Hex[]`
  - `recordEntry(state: HistoryState, entry: HistoryEntry): { state: HistoryState; discarded: HistoryEntry[] }` — `discarded` is the redo stack it cleared, in stack order.

- [ ] **Step 1: Failing tests** in `history.test.ts`:
  - `recordEntry returns the redo entries it clears`: state with redo `[r1, r2]` → `discarded` equals `[r1, r2]`, new `state.redo` is `[]`.
  - `recordEntry with an empty redo discards nothing`: `discarded` is `[]`.
  - `HISTORY_CAP trimming is not a discard`: 101 records with empty redo → every `discarded` is `[]`.
  - `freshAssets survives undo and redo moves`: record entry with `freshAssets: ["a".repeat(64)]`, `takeUndo` then `takeRedo` → same array on the entry.
- [ ] **Step 2: Run** `cd web && pnpm test:unit -- src/outline/history.test.ts` → FAIL.
- [ ] **Step 3: Implement** the type and the new return; update `undoManager.recordHistory` to use `.state` (signature unchanged here), and `run()` to pass `freshAssets: []`.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test:unit` → PASS.
- [ ] **Step 5: Commit.**

### Task 3: `sync/assetRelease.ts`

**Files:**
- Create: `web/src/sync/assetRelease.ts` (`// pattern: Imperative Shell`)
- Test: `web/src/sync/assetRelease.test.ts`

**Interfaces:**
- Consumes: `DeliveryOutcome` from `sync/opQueue.ts`; `Sha256Hex` from `api/brands.ts`.
- Produces:
  - `releaseUrl(sha: Sha256Hex): string` → `` `/api/assets/${sha}?if_unreferenced=true` ``
  - `releaseAssets(shas: readonly Sha256Hex[], waitFor: readonly Promise<DeliveryOutcome>[], doFetch?: typeof fetch): Promise<void>` — awaits every `waitFor`; if any is `{status: "failed"}` returns without fetching; otherwise sends `DELETE releaseUrl(sha)` for each sha in order (`credentials: "same-origin"`); 200/404/409 final, other statuses and thrown errors `console.warn`ed, never thrown.
  - `releaseOnUnload(shas: readonly Sha256Hex[], doFetch?: typeof fetch): void` — fire-and-forget `DELETE` with `keepalive: true` per sha, errors swallowed.
- Uses plain `fetch`, not `apiFetch`: `apiFetch` falls back to the offline shim, which has no asset routes.

- [ ] **Step 1: Failing tests** (inject a `vi.fn` fetch):
  - waits: with an unresolved `waitFor` promise, no fetch has happened after a microtask flush; resolving it `{status: "delivered"}` → one `DELETE` per sha, URLs in order, method `DELETE`.
  - any `failed` outcome → zero fetches.
  - fetch resolving 409, 404, 500 and a fetch that rejects → `releaseAssets` resolves, never rejects; 500 and the rejection each produce one `console.warn`.
  - `releaseOnUnload` → one call per sha with `keepalive: true`, method `DELETE`; a throwing fetch does not throw out.
- [ ] **Step 2: Run** `pnpm test:unit -- src/sync/assetRelease.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (coverage for the new file at the enforced threshold).
- [ ] **Step 5: Commit.**

### Task 4: undoManager releases discarded entries' assets

**Files:**
- Modify: `web/src/outline/undoManager.ts`
- Modify: `web/src/components/UndoRedoKeys.tsx` (install the unload hook beside `setHistoryNavigator`)
- Test: `web/src/outline/undoManager.test.ts`

**Interfaces:**
- Consumes: Task 2's `recordEntry` return and `freshAssets`; Task 3's `releaseAssets`, `releaseOnUnload`; `WriteTicket`/`DeliveryOutcome` from `sync/opQueue.ts`.
- Produces:
  - `recordHistory(entry: HistoryEntry, write?: WriteTicket): void` — on discards, for each discarded entry with non-empty `freshAssets` and an undo receipt, calls `releaseAssets(entry.freshAssets, [receipt.delivered, write.delivered])` (omit `write.delivered` when `write` is absent).
  - `installUnloadRelease(target?: Window): () => void` — `pagehide` listener: for each redo-stack entry with `freshAssets` whose receipt `isDelivered` is true, `releaseOnUnload(entry.freshAssets)`. Returns the remover.
  - Test seam: `setAssetReleaser({ release, releaseOnUnload })` returning a restore function, mirroring `setHistoryPageLoader`; `resetHistory()` also clears receipts.
- Internal: `dispatch(...)` returns `Promise<DeliveryOutcome>` — mounted path: the enqueued ticket's `delivered`; chained path: a promise settled with that dispatch's ticket's `delivered`, or `{status: "failed", error}` when the dispatch throws or its epoch is stale. `performUndo` stores an `UndoReceipt { delivered: Promise<DeliveryOutcome>; isDelivered: boolean }` in a module `WeakMap<HistoryEntry, UndoReceipt>`, flipping `isDelivered` when `delivered` resolves `delivered`. `performRedo` deletes the entry's receipt. Keep `history.ts` free of promises: receipts live only here. The receipt replaces the spec's separate `historyIdle()` wait: a chained undo's receipt only settles once that dispatch has enqueued and delivered, which is the same guarantee.

- [ ] **Step 1: Failing tests** in `undoManager.test.ts` (fake `HistoryDispatch` whose `enqueue` returns tickets with controllable `delivered`; releaser seam spied):
  - `undo then a new edit releases the entry's fresh assets after both deliveries`: record E(freshAssets `[s]`), undo, record F with ticket T → releaser called once with `[s]` and the two promises (undo's and T's).
  - `undo then redo then an edit releases nothing`.
  - `entries without freshAssets are never released`.
  - `two undone uploads are both released by one edit` (Review Focus 4).
  - `an undo dispatched to an unmounted page releases only after that dispatch's delivery` (Review Focus 3): page loader seam returns a deferred tree; the undo receipt promise is still pending until the chained enqueue's ticket delivers.
  - `undo then re-upload of the same file waits for the clearing edit` (Review Focus 1): the releaser receives the clearing edit's `delivered`; with it unresolved, the real `releaseAssets` (fetch spied) has not fetched.
  - `pagehide releases only undos already delivered`: two redo entries, one receipt delivered → `releaseOnUnload` called once with that entry's assets.
- [ ] **Step 2: Run** `pnpm test:unit -- src/outline/undoManager.test.ts` → FAIL.
- [ ] **Step 3: Implement**; in `useOutline.run()` pass the `write` ticket as `recordHistory`'s second argument; in `UndoRedoKeys.tsx` add `useEffect(() => installUnloadRelease(), [])`.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test:unit` → PASS (`useOutline.undo.test.tsx` included).
- [ ] **Step 5: Commit.**

### Task 5: Upload paths tag fresh assets

**Files:**
- Modify: `web/src/outline/useOutline.ts` (`run` options, `onFiles`, `onDropFiles`, `appendBlock`, `Outline` interface)
- Modify: `web/src/components/Composer.tsx` (`onSend` signature; track fresh photo shas)
- Test: `web/src/outline/useOutline.undo.test.tsx` (or a new `useOutline.freshAssets.test.tsx`), `web/src/components/Composer.test.tsx`

**Interfaces:**
- Consumes: Task 2's `freshAssets` field; Task 4's `recordHistory(entry, write)`.
- Produces:
  - `run(fn, opts?: { freshAssets?: readonly Sha256Hex[] })` records `opts.freshAssets ?? []`.
  - `appendBlock(text: string, freshAssets?: readonly Sha256Hex[]): void`
  - `Composer` prop `onSend: (text: string, freshAssets?: readonly Sha256Hex[]) => void`; on send it passes the `sha256` of each `existing: false` photo uploaded into this draft whose `url` still appears in the sent text, then clears its list.

- [ ] **Step 1: Failing tests** (mock `uploadAsset`; read the recorded entry via the history seam or by spying `recordHistory`):
  - `/upload of a fresh file records its sha` (`onFiles`, one file, `existing: false`).
  - `a mixed batch records only the fresh sha` (Review Focus 5): two files, one `existing: true`.
  - `a dedup-only upload records no fresh assets`.
  - `onDropFiles records the fresh shas of every block it creates`.
  - `appendBlock passes freshAssets through`.
  - Composer: pick photo (`existing: false`), send → `onSend` called with `[sha]`; a photo whose markdown was deleted from the draft before sending is not passed; a dedup-hit photo is not passed.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `onFiles`/`onDropFiles` collect `info.sha256` where `!info.existing` alongside the markdown they already build, and pass them to their single `run()`.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test:unit` → PASS.
- [ ] **Step 5: Commit.**

### Task 6: End-to-end, docs, gates

**Files:**
- Create: `web/e2e/undo-upload-release.spec.ts`
- Modify: `docs/architecture/frontend-editor.md` (undo/history section: one short note — fresh uploads are released once redo is gone; receipts and the two deliveries the release waits for; pagehide best-effort)
- Modify: bean `pkm-w4ts` checklist

- [ ] **Step 1: Write the spec** (own page via `POST /api/pages`, delete in `afterEach`; reuse the synthetic-`DataTransfer` drop from `e2e/file-drop.spec.ts`, with unique PNG bytes per test so the store has no prior copy):
  - `undo then an edit deletes the dropped file`: drop → block with image; `Meta+z`; create an unrelated block via the UI (click into the last block, End, Enter, type `x`, Escape); `expect.poll` `page.request.get(<asset url>)` status → 404 (`page.request`, not the page, so the service worker's asset cache is bypassed).
  - `undo, redo, edit keeps the file`: … → poll stays 200 after the edit's text reaches the server (`waitForServerText` pattern).
  - `undo then dropping the same file elsewhere keeps it`: drop, `Meta+z`, drop the same bytes at another gap → after the second drop's block reaches the server, `GET` is 200.
- [ ] **Step 2: Run** `cd web && E2E_PORT=8982 pnpm e2e -- undo-upload-release` → PASS (the spec is written against finished Tasks 1-5; if one fails, debug the product, not the spec).
- [ ] **Step 3: Docs** (`architecture-docs` skill): the `frontend-editor.md` note; grep the docs for any enumeration of `HistoryEntry` fields or undo behaviour that changed.
- [ ] **Step 4: Gates** (pipefail): `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`; `cd web && E2E_PORT=8982 pnpm verify`. The orchestrator runs `proptest/check.sh` and `perf/check.sh` serially afterwards.
- [ ] **Step 5: Commit** spec, docs, bean.
