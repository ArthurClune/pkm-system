# Maintainability Review (2026-11-09) Fixes: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what the 2026-11-09 maintainability review found: seven probable bugs, the rules that now live in several drifting copies, the property harnesses that copy the code they check, and the architecture docs that have regrown and in places contradict the code.

**Architecture:** Nineteen work packages (W1 to W19), each one branch and one child bean of epic `pkm-4gda`. Bugs and false doc statements go first. Each structural package then replaces copies of a rule with one owner (a core function, a helper, a session module) that both production code and the property harness call. Docs that a code change makes true or false are updated in that package's branch; the docs-only packages (W6, W18) handle the rest.

**Tech Stack:** Python 3.12 / FastAPI / SQLite (`server/`), TypeScript / React / vitest / fast-check / Playwright (`web/`), beans, the repo's own gates (`pnpm verify`, `pytest`, `perf/check.sh`, `proptest/check.sh`).

**Spec:** the eight review reports, kept locally (gitignored, never committed) in `docs/superpowers/handoffs/2026-11-09-maintainability-review/01-server-ops.md` to `08-docs.md`. This plan restates every finding it acts on with its file and symbol, so it stands alone on a clone without them. Reviewed at `main` @ 09e433e8.

## How to use this plan

- W1 to W6 are specified to task level here and can be executed directly.
- W7 to W18 fix the decisions (names, signatures, the red tests, the docs to touch). Each is large enough that its branch starts by writing its own task-level plan from its section (`superpowers:writing-plans`), committed beside this one. Plan example code is unreviewed code.
- W19 is deferred by ruling (see Global Constraints).

## Global Constraints

- Every package: its own worktree and branch; the bean is updated in that worktree; `git merge --no-ff` to `main`.
- Server verification: `cd server && uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`. Web verification: `cd web && pnpm verify` (never typecheck plus unit tests alone).
- `perf/check.sh` before merging any package that touches a request path, a query, or a render path (W2, W7, W8, W9, W10, W12, W13, W15). `proptest/check.sh` before merging any package that touches sync, ops, planning, outline edit commands, undo history or the assistant turn (W1, W2, W3, W7, W8, W9, W10, W12, W14).
- **Property tests for converted machines (Arthur, 2026-11-09):** property tests for a state machine remain the ideal, but a package that converts an implicit machine to an explicit one may merge without a new property suite. It must (a) keep every existing property suite green, updating a model where the machine it models changed, and (b) add the conversion to W19's list. A package that changes a machine an existing suite already covers (W3: the turn phase; W9, W10: the queue and sync suites) updates that suite's model in the same branch.
- Fix what property checks find; never exempt in `props/`.
- A route, query param, response model or route docstring change regenerates `web/src/api/openapi.json` and the types per backend.md § Generated artifacts and parity fixtures.
- Comments: no bean ids, line numbers, plan pointers or history narration; at most 80 columns. Never write "load-bearing".
- Docs edits under `docs/architecture/` go through the `architecture-docs` skill. A bug fix adds one row to `docs/troubleshooting.md`.
- Ports: never 8974. Scratch servers 8975; parallel spec runs take their own `E2E_PORT`.
- Do not re-propose: an editing-vs-selecting mode union in the outline; folding `usable` into `ReplicaState`; changing `OpsAck.applied`; removing the replay budget; a backlinks-only endpoint.

## Order and dependencies

```
W6 (docs corrections)        independent, first
W1 -> W7                     W7 absorbs W1's editRefusal into planCommand
W2 -> W13                    both touch routes_pages.py / routes_sidebar.py
W3 -> W14                    both touch claude_engine.py and the web chat machine
W4, W5, W16                  independent
W8 -> W9 -> W10 -> W11       serial: same files (opQueue, replicaSync, clientRuntime)
W12                          independent of W13 apart from store.py (W12 first)
W15                          after W4 (shared files: Files.tsx, PdfViewer, OfflineIndicator)
W17                          independent; its e2e typecheck step after W16
W18                          last of the docs work: after W2, W12, W13 (it moves their sections)
W19                          deferred
```

Parallel lanes that do not share files: {W1, W7}, {W2, W13, W12}, {W3, W14}, {W8..W11}, {W4, W15, W16}, {W17}, {W6, W18}.

## Review Focus

Failure modes no single task's tests exercise, most likely first. Each has its pinning test in the named package.

1. A refusal the user never sees: undo of a refused batch must put the entry back on the undo stack and show `BATCH_TOO_LARGE_NOTICE`, not drop it (W1, test 3).
2. A lost late caller after the `coalesce` conversion: a kick, pull or repair request that arrives after the run's last check but before it settles must get a run (W9, one test per converted site).
3. Lock contention on the first read of the day: `GET /api/journal` creating today while a batch holds the lock answers 503 with `Retry-After`, never 500, and never hangs past `BUSY_TIMEOUT_MS` (W2, test 2).
4. Stop during every phase of the turn, including while `query()` is still being written and while an interrupt is already in flight; the conversation survives and the next turn reads only its own messages (W3, steps 2 and 6). A stop the server never acknowledges must still free the panel (W3, step 8).
5. A doc anchor moved by W18 that a troubleshooting row, a code comment or `props/model.py` still cites (W18: `check-docs.mjs` plus `git grep 'backend.md#'`).

---

## W1: Undo, redo and cross-page drops judge batch size (`pkm-ey0s`)

**Problem.** `useOutline.ts` `commandRefusal` judges depth, text limits, batch size and titles. `undoManager.ts` `refusalNotice`/`textLimitRefusal` judge depth, text limits and titles only, and `dnd/DndContext.tsx` `DndProvider.drop`'s cross-page branch judges nothing. Deleting a block with more than `MAX_OPS_PER_BATCH` descendants is one op; its undo is one `create` per node, which the server answers 422 and the queue discards.

**Files:**
- Create: `web/src/outline/editRefusal.ts` (`// pattern: Functional Core`), `web/src/outline/editRefusal.test.ts`
- Modify: `web/src/outline/useOutline.ts` (`commandRefusal` becomes a call), `web/src/outline/undoManager.ts` (`refusalNotice`, `textLimitRefusal` deleted), `web/src/dnd/DndContext.tsx` (`drop`, cross-page branch)
- Test: `web/src/outline/undoManager.test.ts`, `web/src/outline/useOutline.undo.test.tsx`, `web/src/dnd/DndContext.test.tsx`
- Docs: `docs/architecture/frontend-editor.md` (the rule "No command queues a batch past `MAX_OPS_PER_BATCH`" names `editRefusal` and covers replays and drops); `docs/troubleshooting.md` one row

**Interfaces:**
- Produces:
  ```ts
  /** Why this batch must not be queued, or null. `treeAfter` is null when
   * no tree is known (an unmounted replay whose page read failed). */
  export function editRefusal(
    treeAfter: BlockNode[] | null,
    ops: readonly BlockOp[],
    alsoShipping: readonly BlockOp[],
  ): string | null
  ```
  Order of judgement, unchanged from `commandRefusal`: depth (only when `treeAfter !== null` and `ops` contains a `create` or `move`), text limits of `ops`, batch size of `[...alsoShipping, ...ops]`, titles of `[...alsoShipping, ...ops]`.

- [ ] **Step 1: Core tests.** In `editRefusal.test.ts`: `returns BATCH_TOO_LARGE_NOTICE for 501 creates`, `returns null for 500 creates`, `counts alsoShipping toward the size`, `judges depth only when a tree is given`, `returns the depth notice before the size notice`.
- [ ] **Step 2: Run** `cd web && pnpm vitest run src/outline/editRefusal.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement `editRefusal`** by moving `commandRefusal`'s body; `useOutline.run` calls `editRefusal(result.blocks, result.ops, textOps)`.
- [ ] **Step 4: Red test for undo.** In `undoManager.test.ts`: `undo of a delete whose subtree is over the op limit is refused and kept`. Build a page with one root and 501 descendants, delete the root through the session, call undo; assert `sync.enqueue` was called once (the delete only), the returned outcome is `"failed"`, `onRefused` ran, the page notice equals `BATCH_TOO_LARGE_NOTICE`, and a second undo attempts the same entry (it is back on the stack).
- [ ] **Step 5: Run it; expect FAIL** (enqueue called twice).
- [ ] **Step 6: Replace** `refusalNotice(live, resolved, title)` with `editRefusal(applyOps(live, resolved, title), resolved, [])` in `dispatchWithSession` and `dispatchUnmounted`; the read-failed branch passes `editRefusal(null, batch, [])`.
- [ ] **Step 7: Red test for drops.** In `DndContext.test.tsx`: `a cross-page drop of more than the op limit is refused with a notice and moves nothing`. Assert no `enqueue`, no `removeSubtreeLocal`, and the target outline's edit notice.
- [ ] **Step 8: Judge in `drop`** with `editRefusal(null, moveOps, [])` before any enqueue; route the notice through the target outline's `OutlineDndApi` (add `refuse(notice: string): void` to that port).
- [ ] **Step 9: Run** `pnpm verify`; then `proptest/check.sh --file outline` and `--file ops`.
- [ ] **Step 10: Docs and bean**, commit.

## W2: Every journal-advancing route commits under `write_txn` (`pkm-t57n`)

**Problem.** `routes_pages.create_page`, the today auto-create in `routes_pages.get_page` and `get_journal`, `routes_sidebar.delete_sidebar_entry` and `reorder_sidebar_entries` write in a deferred implicit transaction and commit through `notify.commit_and_nudge_threadpool`. Under contention they raise a raw `OperationalError` (500 after `BUSY_TIMEOUT_MS`), and `reorder_sidebar_entries` validates against a read taken before any lock. `backend.md` § The write lock and `tests/test_write_txn.py`'s docstring both claim every such route uses `write_txn`.

**Files:**
- Modify: `server/src/pkm/server/routes_pages.py`, `server/src/pkm/server/routes_sidebar.py`, `server/src/pkm/server/notify.py` (delete `commit_and_nudge_threadpool`)
- Test: `server/tests/test_write_txn.py`, `server/tests/test_sidebar_endpoint.py`, `server/tests/test_journal_advancing_contract.py`
- Docs: `docs/architecture/backend.md` § The write lock (add `reorder_sidebar_entries` to the read-then-decide table) and § Post-commit nudges (one way to nudge, not two); `docs/troubleshooting.md` one row
- Perf: `perf/check.sh backend`; one extra `BEGIN IMMEDIATE` on the first-of-day miss path is expected. If a count moves, re-record with `--bootstrap` and say why in the commit.

**Decisions:**
- Each of the five wraps its writes in `with write_txn(db):` followed by `notify.nudge_threadpool(request)`, the shape `add_sidebar_entry` already has.
- In `get_page` and `get_journal` the lock is taken only on the miss path: read first; if today's page is absent, `with write_txn(db):` re-check and create.
- `reorder_sidebar_entries` reads `existing_ids` inside the `with`.
- `store.get_or_create_page`'s `except sqlite3.IntegrityError` stays: it costs nothing and this package does not prove every caller holds the lock.

- [ ] **Step 1: Red scan test.** In `test_write_txn.py` add `test_no_route_commits_outside_write_txn`: AST-scan `server/src/pkm/server/*.py` for any `.commit()` call outside `db.py`; allow-list exactly `routes_assets.upload_asset` (its `assets` table is not journalled), by function name.
- [ ] **Step 2: Red behaviour test.** In `test_sidebar_endpoint.py` add `test_reorder_under_a_held_write_lock_answers_503`: hold `BEGIN IMMEDIATE` on a second connection with `BUSY_TIMEOUT_MS` patched low, `PUT /api/sidebar`, assert 503 and a `Retry-After` header. Add the same shape for `POST /api/pages` and for `GET /api/journal` on a database with no page for today, in `test_journal_advancing_contract.py`.
- [ ] **Step 3: Run; expect FAIL** (500s and the scan naming five sites).
- [ ] **Step 4: Convert the five routes; delete `commit_and_nudge_threadpool`.**
- [ ] **Step 5: Run** the server suite, pyrefly, ruff; `perf/check.sh backend`; `proptest/check.sh server`.
- [ ] **Step 6: Docs, bean, commit.**

## W3: Assistant turn: an `interrupting` phase and one stop path (`pkm-60go`)

**Problem.** `TurnPhase` (`assistant/turn_phase.py`) owns idle/streaming/draining/dead, but `ClaudeConversation` (`assistant/claude_engine.py`) also keeps `_stalling`, the pump's local `stalled`, and moves to `streaming` only after `await query()`. The interrupt-then-drain sequence is written in both `_abandon_turn` and `_pump`'s stall branch. Three consequences:
- B1: Stop while the stall watchdog fires sends two interrupts; the second ack finds `draining` and `next_phase` answers `dead`.
- B2: a cancellation during `send()`'s `await query()` leaves phase `idle` with a turn's output unread; the next turn reads it as its own.
- B3: Stop is a fetch abort, so the web returns to `idle` at once while the server may hold `_Entry.busy` for up to `INTERRUPT_TIMEOUT_S + DRAIN_TIMEOUT_S` (15 s); the web retries a 409 for about 300 ms (`BUSY_RETRY_ATTEMPTS` × `BUSY_RETRY_DELAY_MS` in `web/src/assistant/useAssistant.ts`), then shows "a turn is already in progress".

**Files:**
- Modify: `server/src/pkm/assistant/turn_phase.py`, `claude_engine.py`, `service.py`, `routes.py`, `events.py`; `web/src/assistant/chatMachine.ts`, `useAssistant.ts`, `sse.ts`, `client.ts`
- Test: `server/tests/test_turn_phase.py`, `server/tests/test_assistant_turn_phase.py`, `server/tests/test_claude_engine.py`, `server/tests/props/test_assistant_turn_props.py`, `web/src/assistant/useAssistant.test.tsx`
- Docs: `docs/architecture/assistant.md` § The turn phase (diagram and rule table) and the stop sequence; `frontend.md` § The chat machine (the `stopping` exits); one row for the new route in `backend.md`'s API table; `docs/troubleshooting.md` rows

**Interfaces:**
- `TurnPhase = Literal["idle", "querying", "streaming", "interrupting", "acking", "draining", "dead"]`
- `PhaseEvent = Literal["query", "query_sent", "interrupt", "interrupt_acked", "result", "lost"]`
- `_MOVES` (anything absent is `dead`, as now):

  | From | Event | To | Meaning |
  |---|---|---|---|
  | idle | query | querying | the prompt is being written |
  | querying | query_sent | streaming | |
  | streaming | result | idle | |
  | streaming | interrupt | interrupting | an interrupt is in flight; its sender owns it |
  | interrupting | interrupt_acked | draining | the aborted turn's result is still to come |
  | interrupting | result | acking | the result was read before the ack |
  | acking | interrupt_acked | idle | |
  | draining | result | idle | |

  The old `("idle", "interrupt_acked") -> "idle"` row goes: `acking` names the case it stood for, so an ack with no interrupt in flight is `dead` like any other move the table lacks.
- `ClaudeConversation._stop_turn(self, why: str) -> None`: the only caller of `_interrupt`. Returns at once when the phase is `interrupting` or `draining`; otherwise moves `interrupt`, interrupts, moves `interrupt_acked`, sets the drain deadline. `_pump`'s stall branch and `_abandon_turn` both call it. `_abandon_turn` then only awaits the pump with a bound. `_stalling` and `stalled` are deleted; whether to emit the stall `ErrorEvent` is decided by a `why` recorded on the conversation.
- `close()` moves `lost` through `next_phase`.
- `send()` moves `query` before `await query()`; a `CancelledError` there calls `_lose("query abandoned by a cancellation")` and re-raises.
- Stop is acknowledged by the server (Arthur, 2026-11-09), so the web never returns to `idle` while the server still holds the turn:
  - New route `POST /api/assistant/conversations/{conversation_id}/stop`, response `AssistantAck`. It calls `AssistantService.stop(conversation_id)`, which calls `ClaudeConversation.stop_turn()` (public wrapper over `_stop_turn("stopped by the user")` after `_decline_pending()`) and returns at once; 404 for an unknown id; a no-op 200 when no turn is open.
  - New SSE event `TurnStopped` (wire name `turn_stopped`, no fields) in `events.py` and `sse.ts`. The pump puts it on the queue as the last event of a turn that ended by a user stop, after the drained `result`; the stream then ends normally. A stall keeps its `ErrorEvent`.
  - Web `chatMachine.step` case `stop` for a `streaming` turn emits a new effect `{ kind: "postStop"; turn: TurnId }` in place of `abort`; the turn stays `stopping` until `turn_stopped`, an `error`, or the stream's end. Send stays refused while `stopping` (the existing `t.phase !== "idle"` guard).
  - Fallback: the driver arms `STOP_ACK_TIMEOUT_MS = 16_000` (the server's `INTERRUPT_TIMEOUT_S + DRAIN_TIMEOUT_S` plus a second) when it posts the stop; if the POST fails or the timer fires first, it aborts the fetch, which is today's disconnect path (`routes._abandon_stream`), still the path for a closed tab and for New chat.
  - Stop during `creating` is unchanged: there is no conversation id to post to.
  - `streamWithBusyRetry` is unchanged; it now only covers the fallback.

- [ ] **Step 1: Table tests** in `test_turn_phase.py`: every row above, plus `("draining", "interrupt")`, `("querying", "result")` and `("idle", "interrupt_acked")` all `"dead"`.
- [ ] **Step 2: Red engine tests** in `test_assistant_turn_phase.py`:
  1. `test_stop_while_the_stall_interrupt_is_in_flight_sends_one_interrupt`: hold the fake client's `interrupt()`, advance the virtual clock past `STALL_TIMEOUT_S`, call `_abandon_turn`, release, deliver the result; assert one `interrupt()` call and a final phase of `idle`.
  2. `test_stall_while_stops_interrupt_is_in_flight_sends_one_interrupt`: the mirror order (B1).
  3. `test_a_cancelled_query_retires_the_conversation`: a fake `query()` that awaits an event; cancel the consumer; assert phase `dead` and that the service retires the entry (B2).
- [ ] **Step 3: Run; expect FAIL.**
- [ ] **Step 4: Implement** the table, `_stop_turn`, the `send()` ordering, `close()`.
- [ ] **Step 5: Property model.** In `props/test_assistant_turn_props.py` add a rule that holds Stop's interrupt while the clock advances, and one that cancels the consumer while `query()` is pending; label both with `event()`, read their rates, and show teeth by reverting `_stop_turn`'s early return once.
- [ ] **Step 6: Server red tests** in `test_assistant_routes.py` (or the existing routes test file): `stop ends the stream with turn_stopped and leaves the conversation usable` (send, post stop, read the stream to its end, send again on the same id); `stop with no turn open is a 200 no-op`; `stop for an unknown conversation is 404`.
- [ ] **Step 7: Implement the route, `AssistantService.stop`, `stop_turn` and `TurnStopped`.** Regenerate `web/src/api/openapi.json` and the types.
- [ ] **Step 8: Web red tests.** `chatMachine.test.ts`: `stop on a streaming turn posts a stop and stays stopping`; `turn_stopped ends a stopping turn with no error`; `send while stopping is refused`. `useAssistant.test.tsx` (fake timers): `a stop the server never acknowledges aborts the fetch after STOP_ACK_TIMEOUT_MS`; `a failed stop POST aborts the fetch at once`.
- [ ] **Step 9: Implement the effect, the event and the fallback timer.** Update the assistant property model (`props/assistant/model.ts`, the simulated server and the mutants) for the acknowledged stop.
- [ ] **Step 10: Run** server suite, `pnpm verify`, `proptest/check.sh` (both sides: the assistant suites).
- [ ] **Step 11: Live smoke.** Harness changes are always smoked live: on a scratch server (8975), start a turn, press Stop, send again; confirm one conversation id throughout in the server log, and that Send re-enables only after `turn_stopped`. Repeat by closing the tab mid-turn to exercise the disconnect path.
- [ ] **Step 12: Docs, bean, commit.**

## W4: Small web bugs (`pkm-t6xh`)

Each item is its own red test and commit.

| # | Bug | Where | Fix | Red test |
|---|---|---|---|---|
| 1 | "Working online only" banner and its Reload confirm count durable rows as memory-only | `components/OfflineIndicator.tsx` `DeliveryProblemBanner` passes `pending` to `ReplicaUnusableBanner` | pass `unsentInMemory` | `OfflineIndicator.test.tsx`: `a dead worker with one persisted row and no lane entries shows no memory-only sentence` |
| 2 | Enter on "Create page" for a refused title does nothing, silently | `components/SearchBar.tsx` `go()` | show the server's `detail` in an inline `role="alert"` under the input; cleared on the next keystroke | `SearchBar.test.tsx`: `a refused create shows the reason and keeps the search open` |
| 3 | Copy link throws unhandled without a Clipboard API | `views/Files.tsx` `copyLink`; `components/EditableBlockTree.tsx` (two `navigator.clipboard?.writeText`) | new `web/src/copyText.ts`: `copyText(text: string): Promise<boolean>` (false on a missing API or a rejection); `DroppedDraftNotice` uses it too | `copyText.test.ts`: missing API and rejection both resolve false; `Files.test.tsx`: a failed copy shows the link text |
| 4 | `PdfEmbed` keeps `armed`/`probeNote` across an href change | `components/InlineSegments.tsx` `Segment` | `key={seg.href}` on `PdfEmbed` in the `pdf-embed` and `link` branches; then delete `prevHrefRef`, `genRef` and the render-time reset from `PdfViewer.tsx` | `PdfEmbed.test.tsx`: `an asset href edited to a local href is not armed`; the four existing href-change tests in `PdfViewer.test.tsx` stay green |
| 5 | Media in block-ref popover rows is live although the row navigates | `components/BlockRefBacklinksPopover.tsx` | `BacklinkGroupList` provides `InertMediaContext` itself whenever `onNavigate` is set; `FileRefsPopover` drops its wrapper | first confirm in Chromium (verify skill) with a row holding an image; then `BacklinkGroupList.test.tsx`: `rows with onNavigate render media inert` |
| 6 | `SidebarNav` never refetches on resync | `components/SidebarNav.tsx` | subscribe with `useResync` | `SidebarNav.test.tsx`: `a resync refetches the entries` |

Docs: `sync-recovery.md` § What the UI shows (item 1); `frontend.md` (item 5's sentence becomes true); troubleshooting rows for 1 to 4. Gate: `pnpm verify`.

## W5: Small server and deploy bugs (`pkm-3kbm`)

| # | Bug | Where | Fix | Red test |
|---|---|---|---|---|
| 1 | `config.json` is written at the umask, then chmodded | `server/setup.py` `main` | write through `os.open(tmp, O_WRONLY \| O_CREAT \| O_EXCL, 0o600)` then `os.replace`, the shape `client/api.save_config` has; the docstring's usage line drops `--password PW` in favour of the prompt | new `server/tests/test_setup.py`: patch `os.umask(0)`, wrap `os.open` and assert the file is never observed with a mode wider than `0o600` |
| 2 | Every CLI/MCP write fetches up to 100 backlink groups it discards | `client/api.py` `PkmClient.get_page_blocks` | `get_page(title, bl_limit=1)` | `test_client_api.py`: the request carries `bl_limit=1` |
| 3 | `smoke.sh` builds login JSON by interpolation; the password is in curl's argv | `deploy/smoke.sh` | build the body with `python3 -c 'import json,sys; ...'` and send with `--data @-` | manual: a password containing `"` and `\` logs in against a scratch server on 8975 |
| 4 | `sqlite_backup` leaves `<name>.tmp` when `backup_to` raises | `backup/__main__.py` | `try/finally` unlink | `test_backup.py`: a raising `backup_to` leaves no `.tmp` |
| 5 | Doc claim false: "A page a write targets is never created by a separate request" | `docs/architecture/cli-and-mcp.md`, `get_page_blocks` docstring | state the exception: the default target is today, and reading today creates it | none (docs) |

Gate: server suite, pyrefly, ruff.

## W6: Docs: correct statements the code contradicts (`pkm-rmdl`)

Docs-only; no test run. One commit per doc, message says "corrected". Statements made true by W1 to W5 are fixed there, not here.

| Doc | Says | Code says | Fix |
|---|---|---|---|
| `AGENTS.md` § Testing traps | "`web/tooling/` is outside `pnpm typecheck`" | `typecheck` runs `tsc -p tooling/tsconfig.typecheck.json` | "`.mjs` under `web/tooling/` and all of `web/e2e/` are not type-checked or linted" (W17 then removes it) |
| `AGENTS.md` same list | "(`pnpm build` typechecks them)" of e2e specs | `pnpm build` type-checks `src` only | say unit tests under `src/` |
| `AGENTS.md` ports table; `frontend.md` § Build notes; `README.md` § Web app | run the server beside `pnpm dev` | `vite.config.ts` proxies to 8974 unless `PKM_API_PORT` is set | "on this machine set `PKM_API_PORT=8975` with a scratch server; unset, `pnpm dev` writes to production" |
| `.claude/skills/verify/SKILL.md` | "there is no dev-server path that avoids the prod proxy" | `PKM_API_PORT` | correct |
| `README.md` § Offline | conflict copy "next to the winner" | `ops_apply._conflict_landing`: the daily page | one sentence |
| `README.md` | models "opus, sonnet, haiku, or glm" | `policy.MODELS` | name `policy.MODELS` |
| `backend.md` § Planning; `ops_core.py` comment | "Every context field is required" | six fields default (fixed in W12) | until W12: "production passes every field" |
| `backend.md` HTTP API reference | omits `search` `limit`/`exact`, `titles` `limit`, `unlinked` `limit`/`offset`, `query` `expand`, `current-work` `now_ms`, `export.zip` form and 413 | `web/src/api/openapi.json` | add |
| `backend.md` generated-artifacts table | no row for `shared/fixtures/outline_depth.json`; "Guarded by" copies reader lists | the fixture exists | add the row; the column names one stale-check test |
| `backend.md` module map | omits `ops_hash.py`, `ops_expect.py`, `conflict_notes.py`, `security_headers.py`; lists only the title-migration core | files exist | add |
| `backend.md` schema table, `block_rewrites` | "Written by `store.rewrite_snapshotted_blocks`, `ops_core.rewrite_effects`" | three writers; `rewrite_effects` is pure | name the writers (W12 reduces them to one) |
| `checks.md` § Property gate | "Each suite's `teeth.prop.ts`…" | no server gate suite has teeth | say web suites; link W17's bean in the commit, not the doc |
| `checks.md` § Performance gate | "Only `--bootstrap` lowers a band's `max`" | `--rebaseline` also does | correct |
| `checks.md` FCIS row | core never imports shell | also forbids core→Mixed and checks headers | correct |
| `checks.md` / `AGENTS.md` | journal suite 12 s vs 13 s | constant in `journal.prop.ts` | drop the per-suite numbers from AGENTS.md; checks.md names the constants |
| `sync-recovery.md` | eight mismatches: poison flag "moves with the owner"; UI table "only in the lane"; `no-replica` entry conditions; the runRecovery diagram omits `starting`, the gate span and the 120 s lease; `close()` re-arm rationale; "`diagnostics` alone uses `db()`" | see `04-web-sync.md` § Doc mismatches | correct 3, 5, 6 and the diagram's `starting` now; 1, 2 and the lease are fixed by W10, W4, W11 |
| `sync-and-offline.md` | orchestration row omits `legacyRepair.ts`; reconnect retries only the poison repair | also the lane repair, poison first | correct |
| `frontend.md` | fallback models "in `useAssistant.ts`"; "`useAssistant` treats an `AbortError` after Stop as success"; chat-machine diagram has no New chat edges; "`idle` and `streaming` mean what they mean in the server's turn phase"; `/settings` "Whole-database export" only; module map omits `useStaleGuard.ts`, `contexts.ts`, `paths.ts`, `help/` | `chatMachine.ts` | correct; add the modules and that `/help` renders `docs/keyboard.md` through `parseHelpMarkdown.ts`, which knows only headings, paragraphs, pipe tables and code spans |
| `assistant.md` | "The hook owns `sentDecision`"; writes-in-flight row names `useAssistant`; file table lacks `turn_phase.py`; turn-phase diagram | `chatMachine.step`; (diagram redrawn by W3) | correct the first three |
| `frontend-editor.md` | "the engine never imports a type from UI code"; `revealBlock` in `EditablePage`; module map for `outlineState.ts`, `droppedDrafts.ts`, `depthCap.ts`; text-limit row | see `05-outline.md` table | correct those W7 does not change; W7 fixes the import sentence and the `base: null` row |
| `frontend-rendering.md` § The pipeline | does not say which side owns the grammar | `backend.md` § Ref grammar does | one sentence with both links |
| `styling.md` | "`.btn-secondary` … call sites add none"; "every `NavLink`" | four overrides; no `NavLink` remains | correct (W15 adds `.btn-compact`) |
| `docs/keyboard.md` | auto-pair row | typing a closer steps over an existing one (`keyEdits.ts` `CLOSERS`) | add |
| `docs/security-review-2026-10-23.md` | reads as an open list | epic completed | one status line at the top pointing at `SECURITY.md` |
| `overview.md` "Read when you" | no rows for `docs/cli.md`, `docs/keyboard.md`, `docs/SECURITY.md` | they exist | add |

Also in this package, the stale code comments each reviewer listed (they are false statements, not style): `policy.py` `MODELS`, `AssistantPanel.tsx` `ConfirmCard`, `useAssistant.ts` "item 7", `web/src/assistant/client.ts` above `readWithStallGuard`, `ops_apply.apply_batch` docstring (move cycle), `openRetry.ts` and `worker.ts::openDb` consequence, `useSocketLifecycle.ts` first-connect comment, `outbox.ts` (`seq` → `laneSeq`), `OfflineIndicator.tsx::ConnectivityBanner`, `replica/client.ts::ReplicaRpc`, `goodlinks.parse_link_id` docstring, `local_docs.py` (`{path:wholepath}`), `App.tsx` above the Files link, `TopBar.tsx` header, `ThemeToggle.tsx`, `useBlockStampsPref.ts`, `contexts.ts` `BlockStampsApi`, `slashCommands.ts` `SlashCommandName`. These touch code files, so this part runs `pnpm verify` and the server suite once at the end.

## W7: Outline: one command core (`pkm-i74o`)

**Problem.** `props/outline/run.ts` re-implements `useOutline.run()` and `undoManager.dispatchWithSession` line for line, so the outline property cannot see a change to how they compose the cores. A draft's base has two sources. The engine imports from UI code. Slash-command behaviour is split across a list, a string switch with a silent default, and the component.

**Decisions:**
- New Core `web/src/outline/command.ts`:
  ```ts
  export interface PlannedCommand {
    refusal: string | null;        // from editRefusal (W1)
    next: BlockNode[];
    wireOps: BlockOp[];            // stamped
    entry: HistoryEntry | null;    // null when nothing is undoable
    focusAfter: FocusTarget | null;
  }
  export function planCommand(
    pre: BlockNode[], pending: PendingDraft | null,
    fn: (base: BlockNode[]) => EditResult,
    pageTitle: CanonicalTitle, focusBefore: FocusTarget | null,
  ): PlannedCommand
  export function planReplay(
    live: BlockNode[] | null, batch: readonly BlockOp[],
    anchors: BatchAnchors, pageTitle: CanonicalTitle,
  ): { refusal: string | null; wireOps: BlockOp[] }
  ```
  `useOutline.run` keeps timers, notices, the session and `enqueue`. `undoManager`'s two dispatch paths call `planReplay`. `props/outline/run.ts` calls both and deletes its copies.
- Draft base, one source: `onDraftStart(uid, shown)` opens the draft (`{ uid, text: shown, base: shown }`); `onDraftChange` only updates `text`. Delete `ShownText`, `shownRef`, `captureDraft`'s tree fallback and `base: null`. Tests use a `typeInto(handlers, uid, text)` helper.
- Move the draft vocabulary (`PendingDraft`, `captureDraft`, `pendingTextOps`) from `outlineState.ts` to `outline/draft.ts`; `validateOutlineFocus` and `spliceUploadedMarkdown` to `edits.ts`.
- `BlockDraft.settle()`: delete it and its three call sites, run `EditableBlockTree.draftOwner.test.tsx`, `BlockInput.test.tsx`, `useOutline.undo.test.tsx` and `proptest/check.sh --file outline`. Green: it stays deleted and the doc and troubleshooting rows name `subscribeDraftEnd`. Red: restore it and record the failing case as its test.
- `OutlineDndApi` moves to `outline/dnd.ts`; new Core `planCrossPageDrop(uids, nodes, target): { ops: BlockOp[]; replays: OutlineReplay[] }` there; `DndProvider.drop` only dispatches. `UNAUTHORIZED_DETAIL` moves to `outline/goodlinks.ts`. `useConfirm` is passed into `useOutline` by its caller, so the sentence "the engine never imports a type from UI code" becomes true.
- `slashCommands.ts` exports `planPick(command: SlashCommandName, …): SlashPick`, a discriminated union (`text` | `date-picker` | `hand-off`) over an exhaustive switch with a `never` default; `BlockInput.pick` executes it.
- `uploadAndPlace(files, plan)` holds the upload loop once; drop `AuthoritativeReadSource` from the session API; drop the unused `cursor` on `onFiles`; the `/date` picker's Escape becomes a `close-date-picker` `KeyDecision`.

**Red tests first:** a property-runner test that fails if `run.ts` contains its own stamping (`props/outline/checks.test.ts`: the runner's recorded entry equals `planCommand`'s for a seeded sequence); `command.test.ts` for refusal ordering and "a text op for a block the command deletes is not recorded".

**Docs:** `frontend-editor.md` module map, the `pendingTextOps` table (the `base: null` row goes), the dirty-owner and settle rows. **Gates:** `pnpm verify`, `perf/check.sh frontend`, `proptest/check.sh web`. **W19:** none new; the existing outline and draft suites now reach the real composition, which is the point.

## W8: Sync: one `createSyncSession` (`pkm-r0tz`)

**Problem.** The only composition of queue, `replicaSync`, `clientRuntime`, `legacyRepair` and `reconnectFlow` is inside `SyncProvider.tsx` and `useSocketLifecycle.ts`. `props/sync/harnessClient.ts` copies it under "keep the two in step" comments and never runs `SyncProvider`'s `onState` mapping from `ReplicaState` to `SyncEvent`s.

**Decisions:**
- New Shell `web/src/sync/session.ts`:
  ```ts
  export interface SyncSession {
    readonly actions: SyncActions;
    startup(): Promise<void>;
    onSocketStatus(up: boolean): void;
    retryFailedRepair(): Promise<void>;   // poison first, then the lane repair
    dispose(): void;                       // stop replicaSync, dispose the queue, then owned parts
  }
  export function createSyncSession(deps: SyncSessionDeps): SyncSession
  ```
  `SyncSessionDeps` carries the replica, the socket factory, `emit(event: SyncEvent)`, the clock and timers.
- `SyncProvider` and `useSocketLifecycle` keep React state, the contexts, the StrictMode-deferred teardown and the offline gateway. `harnessClient.ts` calls `createSyncSession` and deletes `goOnline`, `endLife`, `mount` and its `retryFailedRepair` copy.
- New `syncState` event `{ type: "replica-state", state: ReplicaState, status: SyncStatus }`; `transitionSync` owns the stalled/unstalled/unusable mapping that `SyncProvider`'s `onState` holds today.

**Red tests first:** `syncState.test.ts` cases for each `ReplicaState` × connected/offline pair the old mapping handled; a `session.test.ts` pinning the first-connect order and the teardown order. **Gates:** `pnpm verify`, `perf/check.sh frontend`, `proptest/check.sh --file sync`. **Docs:** `sync-and-offline.md` § Key pieces. **W19:** a property rule for the banner under replica-state events.

## W9: Sync: one `coalesce` helper (`pkm-p9s2`)

**Problem.** "A call that arrives during a run still gets a run" is hand-written at `opQueue.drain`/`kick` (`drainAgain`, `missedKick`), `replicaSync.pull` (`again`), `replicaSync.start` (`starting ??=`), `reconnectFlow.finish` (`trailing`), `legacyRepair.run` (`stable`, `laneOwed`) and `clientRuntime.repair` (`repairTargets`). Commits `ac7259ea`, `a855c43e`, `08a534f7`, `62ef7a41` each fixed a lost late caller in a different copy.

**Decisions:**
- New Shell `web/src/sync/coalesce.ts`:
  ```ts
  /** Every call resolves only after a run that could have served it:
   * one that started after the call, or one that had not yet passed
   * `joinable()` when the call arrived. */
  export function coalesce<A, R>(
    run: (args: A) => Promise<R>,
    opts: { merge: (pending: A, next: A) => A; joinable?: () => boolean },
  ): (args: A) => Promise<R>
  ```
- Convert one site per commit, in this order (least to most incident-dense): `replicaSync.start`, `replicaSync.pull`, `reconnectFlow.finish`, `clientRuntime.repair` (`merge` unions targets), `legacyRepair.run` (`joinable = () => !stable`), then `opQueue.drain`, which keeps its blocked-outcome policy and armed-retry rule and hands only the missed-kick half to the helper. `owedAfterPoison` stays until W10.
- Stop and report if any conversion needs a new option on `coalesce`: that is a sign the site is not the same pattern.

**Red tests first:** `coalesce.test.ts`: `a call during a run gets a second run`, `a call before joinable() turns false joins the run`, `a call after it gets its own`, `a throwing run rejects its joiners and the next call runs afresh`. Per site, the existing regression test for its historical fix must stay green unmodified. **Gates:** `pnpm verify`; `proptest/check.sh --file sync` after every site, not once at the end. **Docs:** `sync-recovery.md` states the rule once and names `coalesce`.

## W10: Sync: poison claim, mode writer, leased delivery, naming (`pkm-onr2`)

**Decisions:**
- Poison claim: delete `replicaSync`'s `authoritativeRepair`, `onPoisonPending` and `completeAuthoritativeRepair`. Add `OpQueue.holds(owner: BarrierOwner): boolean`; `replicaSync` receives `holdsPoison: () => boolean`. `payPoisonPull` runs on the queue's resume of `"poison"`. Red test: `clientRuntime.test.ts` `discarding a rejected change while a repair runs keeps the poison claim until the repair ends`.
- One mode writer: `replicaSync.noteUnavailable(error: ReplicaError)` sets `usable` and emits the mode; `clientRuntime.continueStartup` calls it instead of `onReplicaState`. `error` on `no-replica` becomes required. The queue's availability latch notifies `replicaSync` so a dead worker is reported without waiting for the next pull; `sync-recovery.md` § Replica mode drops its "Nothing reports the death…" sentence.
- Leased delivery: `OpQueue.deliverLeased(batch): Promise<OpsAckReading>` does lane-ahead, POST and `noteCommitted`. `replicaSync.flushBatches` calls it and loses its own body builder and `onSkipped`.
- Rename `legacyRepair.ts` → `outlineRepair.ts`, `legacy-rejected` → `outline-rejected`, `legacy-repair-*` → `outline-repair-*`, `legacyBehind` → `outlineBehind`. One mechanical commit, nothing else in it.
- Small: export one `orderedPoisonEvents` from `poisonIntents.ts` (delete `clientRuntime.mergePoisonEvents`); one `readPendingRows(db, after?: number)` for the three `pending_ops` full-row reads; delete `queue.ts::poisonDetails`'s display-string fallback; delete the three quota tombstone comments and the plan-pointer comments (`Task N`, `Fix A`, `su05`).

**Gates:** `pnpm verify`, `perf/check.sh frontend`, `proptest/check.sh --file sync`; the queue model (`props/sync/queueModel.ts`) is updated for `holds`. **Docs:** `sync-recovery.md` § A batch the server rejects, § Replica mode, § What the UI shows; `sync-and-offline.md` § When views refetch (POST sites).

## W11: Recovery lease across network I/O (`pkm-3iwm`)

**Problem.** `replicaSync.runRecovery` takes `replica.prepareRecovery()` (the worker's FIFO gate, `recoveryGate.ts::prepare`) and then runs the flush POSTs and an untimed `fetchSnapshot()` before `commitRecovery`. `createReplica` sets a 120 s lease (`RECOVERY_TIMEOUT_MS`); a slower recovery fails at commit every time, and every `enqueue` meanwhile waits behind the gate into its 30 s RPC timeout. No doc states this.

**Steps:**
- [ ] Measure: on a scratch server (8975) with the perf fixture database, throttle the link in Chromium (verify skill) and on the iPad simulator; record snapshot fetch time and whether an enqueue during recovery takes the lost-reply path.
- [ ] Decide with Arthur, from the numbers, between: (a) document the invariant and the deadline in `sync-recovery.md` § runRecovery and leave the code; (b) for `flush: "skip"` entrants, fetch the snapshot before `prepareRecovery`; (c) have the lease deadline follow the fetch. Default if the snapshot stays under 30 s on a throttled link: (a).
- [ ] Whichever is chosen, the diagram in `sync-recovery.md` shows the gate span and the deadline.

## W12: Server write path (`pkm-wqnv`)

**Decisions:**
- New Core `server/src/pkm/server/replay_core.py` takes the rewrite-replay engine out of `ops_core.py`: `BlockRewrite` through `classify_text_edit`, and `unlink_stale_text`, `_rewrite_chain`, `stale_titles_linked`, `rewrite_effects`. `ops_core.py` keeps judges, contexts, effects and `plan_op`. Pure move first, in its own commit.
- `TextConflictContext`, `ReplayOverLimitContext` and `TextEditContext` each carry one `outcome: TextEditOutcome`; `apply_batch` reads `ctx.outcome`. `BatchReplay.charge(outcome: TextEditOutcome) -> None` is the only debit site. `RewriteHistory.walk(base) -> Iterator[RewriteStep]` is consumed by both `next_unread` and `_replay`.
- No context field has a default. Test helpers in `test_ops_core.py` pass every field.
- `canonical = title_reader(db)` once at the top of `apply_batch`, threaded to every helper; `store.get_or_create_page` takes an optional reader. Removes `BatchReplay.reader`, the branch in `_context_for`, and `RewriteStep.derived`'s per-function keying. `perf/check.sh backend` will move counts; re-record with `--bootstrap` and the reason.
- Op-hash pins: `shared/fixtures/op_hashes.json` holds `batch_request_hash` and `batch_replay_hash` for one op of every `BlockOp` member with optional fields unset; `test_ops_idempotency.py::test_every_op_kind_has_pinned_hashes` iterates the union so a new kind fails until pinned, and `::test_every_op_field_is_classified` compares each model's `model_fields` with a frozen list of hashed and excluded fields. Whether `routes_ops._stored_ack`'s strict-hash path can retire is left as it is.
- `store.insert_block_rewrites(db, uid, rows: Iterable[BlockRewrite], now_ms)` replaces the three INSERT copies. One named constant holds the recursive-CTE visited-path guard and its comma rule. `db.read_txn(db)` beside `write_txn` replaces the four `BEGIN … finally: rollback` sites (`routes_sync.sync_changes`, `sync_snapshot`, `title_migration.audit_title_migration`, `assistant/target_reader.py`). `ops_apply._parent_chain` becomes public and `target_reader._ANCESTORS_SQL` is deleted.
- Rename `ops_apply.AppliedBatch` → `BatchEffects`. Replace every "check N" comment and `test_check_N_*` name with the outcome's name (`identical`, `clean`, `conflict`, `over_limit`, `orphan_edit`, hashless), including `web/src/outline/baseTextHash.ts`.
- Delete `store.rewrite_referencing_blocks` and the public `ops_core.replay_title_rewrites` wrapper (tests call `classify_text_edit`); move the orphaned UNTITLED comment into `_resolve_page`'s docstring; delete `ws.Hub._conns`.
- Loosen `test_replay_batch_work.py` and `test_replay_step_titles.py`: exact-sum assertions become "charged at least what it scanned" and "never more than the allowance"; the `large < 2 * small` and `skipped.count("text_limit")` checks stay.
- At each call site of a function `server/tooling/proptest/sync_server.py` swaps (`ops_apply.stale_titles`, `ops_apply.rewrite_effects`, `ops_core.find_op_text_limit_violation`), a one-line comment says the property server replaces it through the module global; `sync_server.py` is updated for the move.

**Gates:** server suite, pyrefly, ruff, `perf/check.sh backend`, `proptest/check.sh` (both sides: the web sync suite drives this server). **Docs:** `backend.md` module map and § Planning ("plan_op" heading; the replay bullets keep the invariants and link symbols; W18 moves them).

## W13: Server routes and domain cleanups (`pkm-7rxj`)

- Path params: one parsing dependency per brand in `server/src/pkm/server/path_params.py` (`path_uid(uid: str) -> BlockUid` raising 422; `path_sha256` and `path_link_id` raising 404), used as `uid: BlockUid = Depends(path_uid)`. `_UID_RE` leaves `routes_pages`. Statuses are unchanged; OpenAPI is unchanged (regenerate and confirm no diff).
- Rename `pkm/title_migration.py` → `pkm/title_migration_core.py`; the core builds the `contracts/responses.py` models directly, deleting the same-name dataclasses and `routes_migrations._audit_payload`'s copy.
- `config.load_config` passes only keys present in the JSON; the `Config` dataclass holds every default once.
- One MIME table in `assets_core.py`: `MIME_POLICY: dict[str, MimePolicy]` (`category`, `inline`, `describable`); `ALLOWED_UPLOAD_MIME`, `INLINE_MIME`, `_DOCUMENT_MIME` and `describe.core.ELIGIBLE_MIME` derive from it. The SVG exclusion sits on the SVG row. A test asserts the derived sets equal today's.
- Delete `importer/import_sidebar.py` (a one-off seed script from July, run by nothing but its own test), `sidebar_rows.missing_entry_rows` and their tests (Arthur agreed, 2026-11-09). Move `next_order_idx` and `reorder_is_valid` to beside `routes_sidebar.py`, so the live route stops importing from the importer package.
- `LoginThrottle` moves to `server/throttle.py`.
- Small copies: `tree.BLOCK_COLS` (three copies), one `like_escape`, rename wording in `render.py`, `assistant.policy` imports `mcp.tools.READ_TOOL_NAMES`, `mcp/server.py` stops building a `FastMCP` at import, delete `routes_pages._daily_title`, one pluraliser, one `_raw_page` in `client/workflows.py`, drop the four identity `as_raw_title` re-mints in `importer/preflight.py`.
- `current-work`'s `now_ms`: replace with an injected clock dependency the tests override; the param leaves the API (regenerate OpenAPI and types).
- Module docstrings for `routes_pages.py`, `routes_search.py`, `routes_assets.py`, `contracts/__init__.py`, `app.create_app`; delete the two one-time migration notes from `deploy/README.md`.
- Comment lint: add a `Task N` / `Fix A`-style plan-pointer pattern to `commentlint/core.py` with tests, and fix the whole tree in the same branch (a new gate fixes the whole set).
- Rationale written once: `auth_gate.py`, `auth_gate_core.py`, `auth.login`, `LoginThrottle`, `run.FORWARDED_ALLOW_IPS` keep a sentence or two each; `backend.md` owns the why; `SECURITY.md` and `deploy/README.md` link to it.
- Parity dumps: one `parity_corpus(pieces, seed, count, length)` and one `shape_tally` shared by the three generated-corpus dumps; regenerate and confirm the fixtures are byte-identical.

**Gates:** server suite, pyrefly, ruff, `pnpm verify` (types regenerate), `perf/check.sh backend`.

## W14: Assistant: contract, preview, confirm state (`pkm-21bj`)

- SSE contract generated: rename `preview_keys_dump.py` → `assistant/wire_dump.py`; it also emits `web/src/assistant/events.gen.ts` (the `AssistantEvent` union and `EVENT_TYPES`) from `events.py`'s dataclasses and `_EVENT_NAMES`. `sse.ts` imports them. `test_preview_keys_artifact.py` → `test_assistant_wire_artifact.py` guards both. Drop `ConfirmRequest.ops_preview` / `PendingConfirm.opsPreview`, `TurnDone.usage` and `ToolFinished.name`. New row in the generated-artifacts table.
- `target_reader.preview_write` calls `write_preview._validate` once inside one `try`; `target_uids(checked, entries)`, `ancestor_uids(checked)`, `build_write_preview(checked, blocks)` and `shown_blocks(checked, blocks)` take the `_Checked` value. `_accepted` is deleted. `test_write_preview.py` gets one raw-input helper.
- Web confirm state: `PendingConfirm.answer: null | { allow: boolean; state: "posting" | "failed" }` replaces `ChatState.answering` and `sentDecision`. `chatMachine.ts` exports `canStop(state)` and `answerFailed(confirm)`; `AssistantPanel` and `ConfirmCard` render from them. Delete the unreachable `conversation.kind === "creating"` guard in `step` case `send`. The assistant property model's confirm invariant is re-pointed (existing suite, so in this branch).
- `createChatDriver` takes its client functions as a parameter (enables W19's shell property); add the missing unit test `newChat sends the DELETE only after the aborted stream settles` with a stream mock that settles late.
- Delete `policy.all_tool_names()` and its count assertion; add `test_the_missing_uid_warning_matches_classify_skip`.
- Move reducer cases from `useAssistant.test.tsx` to `chatMachine.test.ts` as plain `step` calls; rename the rest after the behaviour.
- `service.py` comments state the rule without the history.

**Gates:** server suite, `pnpm verify`, `proptest/check.sh` (assistant suites), live smoke of one write approval.

## W15: Web UI (`pkm-nbl3`)

- **Modals.** New Shell `web/src/useModal.ts`: `useModal({ surfaceRef, initialFocusRef, onClose, triggerRef })` does capture-phase Escape, a cycling Tab trap (move `focusWrapTarget` from `pdfViewerCore.ts` to `web/src/focusWrap.ts`), scroll lock and focus restore. `ConfirmDialog`, `DeleteBlockedDialog`, `PdfViewer`'s overlay and `useOverlayDismiss` use it; `ConfirmDialog` keeps its Enter rule. `e2e/delete-page.spec.ts` must stay green. `frontend.md`'s dismissal table lists all four.
- **Fetch state.** `frontend.md` § State management says which idiom to use when: one live request → `useStaleGuard`; effect-scoped → a local `cancelled`; several loads of one list → a Core reducer with load ids, as `journalPaging.ts`. Then:
  - `CurrentWork.tsx` uses `useStaleGuard`.
  - `views/filesPaging.ts` (Core): state `{ filterGen, phase, items, total, itemsGen, more, busy }`, events `filterChanged | reloadStarted | loaded | failed | moreStarted | moreLoaded | moreFailed`, each result carrying the load id it answers; `listIsCurrent` is a selector. The generation still bumps at the keystroke, not when the debounce fires.
  - `components/backlinksPaging.ts` (Core) likewise for `BacklinksSection` (`loadMore`, `loadAll`, refresh).
  - `UnlinkedSection`: one `Map<BlockUid, "pending" | "settled" | "delivered" | { error: string }>` replaces `inFlight`, `itemStatus`, `hiddenUids`, `linked`.
  - Unit tests per reducer, written as an event table like `journalPaging.test.ts`. Property suites: W19.
- **Notices.** `components/DismissibleNotice.tsx` (`tone: "error" | "status"`); `useOutline` exposes one `notices` list in place of `uploadError`, `goodlinksNotice`, `editNotice`; `EditablePage` and `TopBar` render through the component.
- **PDF.** `PdfOverlay` component holds the overlay markup once.
- **Preferences.** Delete `effective`, `systemPrefersDark` and the listener from `useTheme`; `useStoredToggle(key, [off, on], fallback)` replaces `sidebar.ts`, `blockStampsPref.ts`, `useSidebarCollapsed.ts`, `useBlockStampsPref.ts`, keeping the stored strings.
- **Routes.** `routeMeta.ts` holds one array of static routes `{ path, label, documentTitle }`; `MainRoutes` maps over it; `DYNAMIC_ROUTES` and the self-consistency test go; not-found gets its own title; `paths.ts` uses `PAGE_ROUTE_PREFIX`.
- **Stylesheet.** Section markers throughout `styles.css` and one sentence in `styling.md` naming the order; `--z-*` tokens for the ten literal `z-index` values with a table in `styling.md`; `.btn-compact` replaces the three identical overrides; `styles.test.ts` walks real rules with `postcss` (add as a dev dependency, following the worktree `node_modules` rule) and the "no grouped selector" authoring rule leaves `styling.md`; delete `.empty-day`.
- Move `AssetRefGroup` to `components/groups.ts`.

**Gates:** `pnpm verify`, `perf/check.sh frontend` (bundle budgets: `postcss` is dev-only and must not reach the entry), a real-keypress check of the confirm dialog's Tab trap in Chromium and on the iPad simulator.

## W16: e2e specs write to pages they create (`pkm-eek2`)

`conflict-landing`, `embeds`, `help`, `image-expansion`, `math`, `offline-shell`, `offline`, `pdf`, `rename`, `undo` and `edit` type into today's journal. Each is converted to the shape `slash-dates.spec.ts` has: `POST /api/pages` in `beforeEach`, navigate there, delete in `afterEach`. Add `web/e2e/ownPage.ts` exporting `test` with a `page`-scoped fixture that does this, so a spec opts in by import. A spec that is about the journal itself (`offline-shell` if so) keeps the journal and deletes the blocks it made. One spec per commit; a full-suite run before merge. Gate: `pnpm verify`.

## W17: Gates and tooling (`pkm-elb2`)

- **Unchecked code.** Add `web/e2e` and `playwright.config.ts` to a typecheck project and to `eslint src tooling e2e`; turn on `checkJs` for `web/tooling/**/*.mjs` (JSDoc types where needed). Fix what surfaces. Remove the AGENTS.md trap W6 rewrote.
- **Property reach asserted.** `web/src/props/gate.ts`: `checkGateProperty({ suite, arb, run, numRuns, limitMs, show })`, `expectMutantsCaught({ mutants, arb, run, numRuns, limitMs })`, `assertReach(tally, floors)` using `with_floors`' half-of-lowest-share recipe. The five `*.prop.ts` drivers and seven teeth files use it; arbitraries are untouched so seeds still replay. The `fault warnings` UNEXPECTED line fails the gate.
- **Server teeth.** `with_floors` on `test_ops_state.py`, `test_planner_props.py`, `test_unlink_props.py`, `test_assistant_turn_props.py` for labels that are stable; one mutant per suite under `server/tests/props/test_teeth.py` (monkeypatch), each naming the invariant it must break. `checks.md` § Property gate becomes true.
- **Exclusion.** `test_proptest_exclusion.py` enumerates `tests/props/test_*.py` and requires the marker or an explicit allow-list entry.
- **Eslint plugin.** Split `web/tooling/eslint-plugin-brands/index.mjs` into `types.mjs`, `registry.mjs` and one module per rule; `select-keys-literal` and `ts-expect-error-in-probe` move to `web/tooling/eslint-plugin-repo/`. Mechanical; `lintConfig.test.ts` must pass unmodified. Then fixtures become `x.bad.ts` / `x.ok.ts` pairs and the `cases[].corrected` strings go.
- **Budgets.** `budgets.json` `rationale` becomes one sentence per limit; history goes to commit messages; `measuredOn` is dropped.
- **Perf toolkit.** `web/tooling/perf/harness.mjs` consumers other than `check.mjs` default to port 8976 (new row in the AGENTS.md ports table) and the README stops servers by PID.
- **Regeneration.** `uv run python -m pkm.regen` runs every generator in dependency order (`tag_chars --table` stays out); the generated-artifacts table's "Regenerate with" column names it.
- **Small.** One registry path matcher with the JS semantics on the Python side plus shared cases in a parity fixture; delete `sides._AVAILABLE`/`available()` and the unused `seed` param; one `changed_paths`; `check.mjs` expands `--only` letters to groups itself; `reproduced(baseline, f, rerun)` names the re-run check; `check-docs.mjs checkBeans` defers to commentlint's rule.
- **Docs.** AGENTS.md's perf paragraph keeps only what the tool cannot print (never `--allow-busy`; a surviving regression goes to Arthur; a faster timing is never recorded; an `unstable` run exits 1 and that is expected) and says "follow the `next:` lines"; the verify skill links there.

**Gates:** server suite, `pnpm verify`, both `perf/check.sh` sides, `proptest/check.sh` in full.

## W18: Docs structure (`pkm-3m1g`)

Run after W2, W12 and W13 so sections are moved once.

- **Split `backend.md`.** New `docs/architecture/write-path.md` takes: The write path; The write lock; Planning (Ordering, Refs, Timestamps, Idempotency, Well-formed text); Conflicts; Missing targets; Stale batches; Concurrent structure edits; Page mutations; Post-commit nudges. It gains one section, "Work bounds under the write lock": one table (bound / constant / judged in / what exceeding it does) plus the rules stated once (server-made text passes a limit only by the stated backticks; never a 400 over text the client did not send; a stored row over a limit may stay level, never get worse; which costs are uncharged). The case walks move to the tests that pin them. Auth, Login throttle and Hostile input stay in `backend.md` but lose every sentence `SECURITY.md` also carries; `SECURITY.md` keeps the threat model, consequences and limitations and links each mechanism.
- Repoint every inbound anchor in the same commit: `git grep -n 'backend.md#'` across docs, code comments, skills and `server/tests/props/model.py`; `check-docs.mjs` must pass.
- **AGENTS.md § Testing.** Keep commands, when to run each gate, the policy decisions, the traps, the ports table. Move the deploy verification recipe to `deploy/README.md` § Updating and link it. Drop the per-suite time budgets.
- **Troubleshooting.** Merge rows that share a symptom and a current guard into one row whose Ref lists every bean; add symptom-family subheadings under § Backend ("Writes stall or 503", "A deleted or renamed page comes back", "A route answers 500"); Cause cells lose "now …" narration. Ask Arthur whether review-only findings (an attack input a review reproduced, never observed) keep rows; default: they stay, merged.
- **Specs.** `docs/superpowers/README.md`: three lines saying specs and plans are frozen at approval and the architecture docs describe the system as it is. AGENTS.md § FCIS's example prefers a `docs/architecture/` section. Repoint the 53 comments citing `offline-editing-design.md §N` to the owning architecture section, or drop the pointer where the comment already states the rule; fix the two that contradict the code (`contracts/ops.py` `DeleteOp`, `conflict_notes.conflict_label`).
- **Regrowth guard.** `check-docs.mjs` reports each file's size against the merge-base with `main` and against the SHA recorded in `.claude/skills/recheck-docs/last-recheck` (a fact printed for judgement, not a threshold). `recheck-docs` writes that file and its commits carry a `Docs-Recheck:` trailer; step 1 greps for the trailer. Copied constants and counts in the docs (`MAX_LINK_NESTING` = 32 and the like) become symbol names.
- **Then run `recheck-docs`** over the whole set and act on it in this branch.
- `architecture-docs` skill: resolve its own contradiction on module maps (the tree is for orientation, not completeness). Invoke `superpowers:writing-skills` before editing either skill.

Docs-only apart from the comment repointing, which runs `pnpm verify` and the server suite once.

## W19: Property suites for converted machines (`pkm-ygyx`) — deferred

Not blocking any merge above. Each entry is added by the package that makes the conversion; each suite follows the standing rule when it is written (model from the docs, reach shown, teeth shown, `proptest/check.sh` green).

| Machine | Converted in | Suite |
|---|---|---|
| Files paging reducer (`views/filesPaging.ts`) | W15 | new `props/files/` |
| Backlinks paging reducer (`components/backlinksPaging.ts`) | W15 | new `props/backlinks/` |
| Unlinked-item lifecycle map (`components/unlinkedStatus.ts`, `withStatus`) | W15 | with backlinks |
| Banner under `replica-state` events (`transitionSync`) | W8 | extend `props/sync/`: the harness's clients already run the fold, `session.problem()` is the read, and `sync.prop.ts`'s `Problem at settle: <kind>` tally is the reach data; the offline-reload first connect is reached (a scratch mutant forcing `needsBootstrap` false failed the sync property on both seeds tried) |
| Acknowledged stop (`postStop`, `turn_stopped`, the fallback timer) | W3 | already in the assistant suites (W3 updates them); listed so the shell half is covered with the row below |
| Chat driver shell: DELETE only after the stream settles (`createChatDriver`) | W14 | extend `props/assistant/` to drive the driver, settling stream and DELETE as separate actions |
| Confirm answer state (`PendingConfirm.answer`) | W14 | extend the assistant model's confirm invariant |
| Late callers at `coalesce` sites the sync property suites do not reach: the reconnect completion (`reconnectFlow.ts`) and the poison repair (`clientRuntime.ts`); the legacy repair is listed until a run shows a suite reaches it | W9 | extend `props/sync/` only if a suite can draw the late call (a connect after the resync decision; a rejection after the delete loop reads its targets). Guarded today by `reconnectFlow.test.ts` (`a connect finished while the completion decides gets its own pull`), `clientRuntime.test.ts` (`a poison event after the repair began deleting gets a repair of its own`) and `legacyRepair.test.ts` (`a rejection arriving after a run's onStable gets a run of its own`). `pull` is reached: the sync property fails when its late nudge is lost |
| `useModal`: focus trap and the modal stack (topmost-only keys, overflow held until the last modal closes, restore only from the topmost) | W15 | judge when written whether a property earns its cost over the unit table |

## Not in this plan

- `socket.ts` as an explicit phase union: well tested, unchanged since September, lowest value in its report.
- Retiring `routes_ops._stored_ack`'s strict-hash path: needs a retention rule for `applied_batches`, which is a product decision.
- Splitting `styles.css` into several files: source order carries two documented invariants.
- Renaming `commentlint.run` (entry point for three lints): churn across the hook, `package.json` and docs for no behaviour.

## Self-review notes

- Every finding in the eight reports ranked LOW-MEDIUM or above maps to a package; LOW items are folded into the package that touches the same file, or listed under "Not in this plan" with the reason.
- Names used across packages: `editRefusal` (W1, used by W7's `planCommand`); `coalesce` (W9; `owedAfterPoison` removed in W10); `BatchEffects`, `read_txn`, `_parent_chain` made public (W12, the last used by W14's `target_reader`); `createChatDriver` parameterised (W14, used by W19).
