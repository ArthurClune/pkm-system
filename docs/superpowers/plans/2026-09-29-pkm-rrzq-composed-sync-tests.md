# Composed sync tests (pkm-rrzq) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four composed tests the sync review found missing: a WS-level skipped-echo test, shared placement-state cases pinned on both sides, an e2e for a conflict landing and a skipped op reaching today's daily note, and an e2e that restarts the browser with an undelivered offline edit.

**Architecture:** Tests only. The placement cases extend `shared/fixtures/missing_targets.json` with a second table (`placement_state` + `placement_cases`) that the existing fixture readers on each side also read, applying the ops through the real apply path (server `ops_apply.apply_batch` on a fresh SQLite file, web `applyLocalOps` on sqlite-wasm). The e2e specs hold the browser's `POST /api/ops` in a `page.route` handler while a second "device" writes through `page.request`, and use `chromium.launchPersistentContext` so OPFS survives a real browser restart.

**Tech Stack:** pytest + FastAPI TestClient websockets; vitest (node env, sqlite-wasm); Playwright 1.61.

**Spec:** `docs/superpowers/specs/2026-09-29-sync-review-fixes-design.md` § "Tracked without design here" (Composed tests bullet); `docs/2026-09-29-sync-subsystem-review-consolidated.md` § Tests; bean pkm-rrzq.

## Global Constraints

- Tests only. If a test exposes a real bug: stop that item, file a bug bean under pkm-a4t2 with a repro, do not fix it here.
- Characterisation tests need no red-before-green, but every new test must fail under one deliberate mutation of the behaviour it guards (made, run, reverted, reported).
- Each e2e spec runs three times green, alone, on port 8982: `E2E_PORT=8982 node tooling/runPlaywright.mjs e2e/<spec>.spec.ts` after `pnpm build`.
- A spec that writes today's journal deletes exactly what it creates and leaves the page as it found it (top-level block set restored; the `conflict` page deleted only if the spec created it).
- Test comments state the rule and carry NO bean id. Commit messages may carry the id.
- Never write the two-word phrase that starts "load" and ends "bearing".
- Any `docs/architecture/` edit goes through the `architecture-docs` skill; run `node .claude/skills/architecture-docs/check-docs.mjs <files>`.
- A runtime-file comment touched (e.g. `missingTarget.ts`) keeps its `// pattern:` header.
- Final checks: server `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`; web `pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`; the two new e2e specs alone on 8982. Do NOT run the full Playwright suite or `perf/check.sh` (the orchestrator does, after merge).

## Review Focus

- A conflict entry and an orphan-edit entry land on a daily page other specs also write: cleanup must key on this spec's own stamped page title, never on "new blocks" alone. Owned by Task 3 (cleanup filters new top-level blocks by the stamped title).
- A session cookie lost across the restart would silently turn Task 4 into a login test: the spec logs in again if the relaunch lands on `/login`, so delivery is still what is asserted.
- An edit counted as pending while still in the in-memory lane would survive nothing: Task 4 waits for "pending" AND the absence of "only in memory" before closing the browser.
- A replayed create that a later pending move took elsewhere must not be re-paged: Task 2 pins that branch as its own placement case.
- An all-skipped batch must put no op on the socket at all, not only a mixed batch: Task 1 covers both.

---

### Task 1: WS-level test that skipped ops are absent from the echo

**Files:**
- Test: `server/tests/test_ws.py` (after `test_failed_batch_broadcasts_nothing`)

**Interfaces:** the `client` fixture and the existing `_frames_until_seq(ws)` helper in the same file (batch frame, then the `{"type": "seq"}` nudge).

- [ ] **Step 1: Write the tests**

`test_skipped_ops_are_absent_from_the_ws_echo(client)`: open `/api/ws`, POST a batch (`client_id="sender-skip"`) with `set_collapsed ghost_ws1`, `update_text ghost_ws1 "lost"`, `move uid_b3 -> parent ghost_ws2`, `move uid_b2 -> parent uid_b3` (a cycle: uid_b3 is uid_b2's child in the seed), and one live `set_collapsed uid_b1 True`. Assert the ack's skipped uids are `["ghost_ws1", "ghost_ws1", "uid_b3", "uid_b2"]`; the frames up to the seq nudge hold exactly one frame with `client_id == "sender-skip"`, whose `ops == [{"op": "set_collapsed", "uid": "uid_b1", "collapsed": True}]`.

`test_an_all_skipped_batch_puts_no_op_on_the_socket(client)`: a batch of only ghost ops; every non-seq frame before the nudge has `ops == []`.

- [ ] **Step 2: Run** `cd server && uv run pytest tests/test_ws.py -q -k skipped` → PASS.
- [ ] **Step 3: Mutation** In `ops_apply.apply_batch` make the broadcast append unconditional; both tests FAIL; revert.
- [ ] **Step 4: Commit** `test(pkm-rrzq): skipped ops are absent from the WS echo, asserted at the socket`

### Task 2: Placement-state cases in the shared fixture, pinned on both sides

**Files:**
- Modify: `shared/fixtures/missing_targets.json` (add `placement_state`, `placement_cases`)
- Test: `server/tests/test_ops_core.py` (beside `test_classify_missing_target_matches_shared_fixture`)
- Test: `web/src/replica/missingTarget.test.ts`
- Modify (comment only): `web/src/replica/missingTarget.ts` header ("Only skip-or-not is mirrored" becomes: the skip decision lives here, placement in `localOps.ts`; the fixture pins both)
- Docs: `docs/architecture/sync-and-offline.md` (the sentence naming what `missing_targets.json` pins), via the `architecture-docs` skill

**Fixture shape (both readers consume exactly this):**

```json
"placement_state": {
  "pages": [{"id": 1, "title": "AI"}, {"id": 2, "title": "ML"}],
  "blocks": [{"uid": "uid_p1", "page": "AI", "parent_uid": null, "order_idx": 0},
             {"uid": "uid_p2", "page": "ML", "parent_uid": null, "order_idx": 0},
             {"uid": "uid_c1", "page": "AI", "parent_uid": null, "order_idx": 1},
             {"uid": "uid_c1a", "page": "AI", "parent_uid": "uid_c1", "order_idx": 0}]},
"placement_cases": [{"name", "ops": [BlockOp], "replay": bool,
                     "replica_only": [block rows, same shape],
                     "expect": [{"uid", "page", "parent_uid", "order_idx"}],
                     "pages_absent": [title]}]
```

`replica_only` rows are the replica's own enqueue-time effects the server never received; the server ignores them, the replica inserts them and applies with `{ reapply: replay }`. Both sides must reach `expect` (compared by page title, since the replica mints negative page ids) and hold no page titled as any `pages_absent` entry.

Cases (names are the test ids):
1. `create-under-a-live-parent-lands-on-the-parent-page`: create uid_n1 `page_title "AI"` under uid_p2 → uid_n1 on ML under uid_p2 at 0.
2. `create-with-a-stale-hint-resolves-no-page`: same with `page_title "Gone Page"` → uid_n1 on ML; `pages_absent: ["Gone Page"]`.
3. `move-with-a-stale-hint-follows-the-parent`: move uid_c1 under uid_p2 at 0, `page_title "Gone Page"` → uid_c1 and uid_c1a on ML; `pages_absent: ["Gone Page"]`.
4. `cross-page-move-re-pages-the-subtree`: top-level move uid_c1 to 0 with `page_title "ML"` → uid_c1 ML top at 0, uid_c1a ML under uid_c1, uid_p2 shifted to 1.
5. `replayed-create-follows-a-parent-a-window-re-paged`: replay; replica_only uid_n1 (AI, under uid_p2, 0) and uid_n1a (AI, under uid_n1, 0); ops create uid_n1 under uid_p2, create uid_n1a under uid_n1 → both on ML.
6. `replayed-create-a-later-move-took-elsewhere-keeps-the-move`: replay; replica_only uid_n1 (AI, top, 2); ops create uid_n1 under uid_p2 (`page_title "AI"`), move uid_n1 to top 2 `page_title "AI"` → uid_n1 AI top at 2, uid_p2 unchanged.

- [ ] **Step 1: Add the fixture table and the two readers**

Server: `test_placement_matches_shared_fixture(case, tmp_path)` parametrized over `placement_cases` (ids = names): `init_db` a fresh file, `open_db`, insert `placement_state` (text = uid), `apply_batch(db, OpBatch(client_id="fixture", batch_id=..., ops=case["ops"]), NOW)`, then assert `(title, parent_uid, order_idx)` for each `expect` uid, and no page per `pages_absent`.

Web: `describe("placement agrees with the server", ...)` with `test.each(placement_cases)`: `openTestDb`, insert state then `replica_only`, `applyLocalOps(db, ops, 99, { reapply: replay })`, same assertions.

- [ ] **Step 2: Run** `cd server && uv run pytest tests/test_ops_core.py -q -k placement` and `cd web && pnpm exec vitest run src/replica/missingTarget.test.ts` → PASS on both.
- [ ] **Step 3: Mutations** (one per side): server `plan_op` create ignores the parent's page → cases 1, 2 fail; web `localOps.ts` reapply re-page branch removed → case 5 fails. Revert both.
- [ ] **Step 4: Comment + doc**: update the `missingTarget.ts` header and the `sync-and-offline.md` sentence; run `check-docs.mjs` on the doc.
- [ ] **Step 5: Commit** `test(pkm-rrzq): placement-state cases in missing_targets.json, pinned on both sides`

### Task 3: E2E, a conflict landing and a skipped op reach today's daily note

**Files:**
- Create: `web/e2e/conflict-landing.spec.ts`

**Mechanism:** a stamped page `Conflict Landing <stamp>` with blocks u1 `conflict base` and u2 `skip base`, created by a remote client (`POST /api/pages`, `POST /api/ops`, `client_id "e2e-remote-conflict"`). The browser opens it. `page.route("**/api/ops")` holds the browser's batch naming the target uid, runs the remote write through `page.request` (which page routes do not intercept), then `route.continue()`, keeping the response JSON.

- [ ] **Step 1: Write the spec**: two tests sharing a snapshot/cleanup helper run in `finally`:
  - before: today's title from `.journal-day h1.page-title` after login; `before` = top-level uids of `GET /api/page/<today>`; `conflictExisted` = `GET /api/page/conflict` ok.
  - cleanup: delete (one `/api/ops` batch of `delete`) every top-level block of today not in `before` whose text contains the stamped title; delete the stamped page; delete `conflict` only when `!conflictExisted`; then assert today's top-level uids equal `before`.
  - `a concurrent edit lands the overwritten text under a conflict header on today's note`: held batch is the browser's `update_text u1` (edit to `conflict base local`); the remote `update_text u1 "remote edit wins the race"` lands first. Assert: the server page shows `conflict base local`; today (server) has a top-level `[[conflict]] [[<title>]] — overwritten by ((u1))` with child `remote edit wins the race`; the Daily Notes view shows `remote edit wins the race`.
  - `an edit to a block another device deleted lands on today's note as an orphan edit`: held batch is `update_text u2` (edit to `skip base local`); the remote `delete u2` lands first. Assert: the held ack's `skipped` names u2 with reason `block_not_found`; the page view no longer shows the block; today (server) has `[[conflict]] [[<title>]] — edit to a block the server no longer has` with child `skip base local`; the Daily Notes view shows `skip base local`.
- [ ] **Step 2: Run** three times green on 8982.
- [ ] **Step 3: Mutations** (one per test; server-only, no rebuild): `classify_text_edit` never returns `"conflict"` → test 1 fails; the orphan-edit branch lands nothing → test 2 fails. Revert.
- [ ] **Step 4: Commit** `test(pkm-rrzq): e2e for a conflict landing and a skipped op on today's daily note`

### Task 4: E2E, an undelivered offline edit survives a browser restart

**Files:**
- Create: `web/e2e/offline-restart.spec.ts`

**Mechanism:** `chromium.launchPersistentContext(<profile dir>, { baseURL })` (baseURL from `test.info().project.use.baseURL`), `trackResponses` on each context, `context.routeWebSocket(/\/api\/ws$/)` steering as in `offline.spec.ts`. The profile directory is removed at the end.

- [ ] **Step 1: Write** `an edit made offline is delivered after the browser restarts`:
  - session 1: login, wait snapshot + changes and a controlling service worker; create page `Offline Restart <stamp>` through the search bar and wait for it on the server; go offline (flag + `setOffline` + close sockets); type `survives a restart <stamp>` into the empty page, Escape; wait for the banner to read `/\d+ changes? pending/` and not contain `only in memory`; assert the server does not have the text yet; `context.close()`.
  - session 2: relaunch the same profile with `offline: true` and sockets refused; open the page (log in again if on `/login`); the text renders from the replica and the banner still reads pending; go online; `waitForServerText(page, title, text)`; the banner clears.
  - finally: delete the page; close the context; remove the profile dir.
- [ ] **Step 2: Run** three times green on 8982.
- [ ] **Step 3: Mutation**: drop pending rows when the worker opens the replica, `pnpm build`, run → FAIL; revert and rebuild.
- [ ] **Step 4: Commit** `test(pkm-rrzq): e2e for an offline edit delivered after a browser restart`

### Task 5: Verify, bean, report

- [ ] Server: `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`.
- [ ] Web: `pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && pnpm build`; the two new specs alone on 8982.
- [ ] Tick the bean checklist (leave "verify, merge" to the orchestrator), add `## Summary of Changes`, mark completed, commit the bean file last.
