# Query block Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Refresh button in a `{{query}}` block's header re-runs the query, and when the refreshed records land, rows a cell edit held are released.

**Architecture:** The view machine (`stepView`) gains a `release` event. The query block reducer (`queryBlock.ts`) remembers the load a Refresh was clicked on and, when records for any other load land, releases the hold in the same step. `QueryResults` renders the button, which dispatches `refresh` and bumps the load generation that resyncs already bump.

**Tech Stack:** React 19, TypeScript, vitest, fast-check, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-query-refresh-design.md`

Worktree: `/Users/arthur/code/llm/pkm/.worktrees/query-refresh` (branch `feat/query-refresh`). Run every command from there; never touch `/Users/arthur/code/llm/pkm` directly. Bean: `pkm-p47v`; tick its checklist with the beans CLI as tasks land, and commit the bean file with the code.

## Global Constraints

- Button label is exactly `Refresh`, a `<button type="button" className="btn-secondary btn-compact">`, inside the header's island (`{...island}`) so a click doesn't open the host block's editor.
- A cell write never fetches. A resync keeps holding rows exactly as today; only Refresh releases them.
- The old rows stay on screen until the refreshed records land. Nothing is released at the click.
- Unsaved filter, sort, view and columns survive a refresh.
- FCIS headers, 80-column comment lines, no bean ids in code or doc comments (AGENTS.md).

## Review Focus

1. **A Refresh whose request fails.** The error shows, the hold stays, and the next successful load (a second Refresh or a resync) releases. Pinned in Task 2 (`recordsFailed`) and Task 3 (retry after an error).
2. **A resync that supersedes a Refresh's request.** Its load differs from the one at the click, so it releases. Pinned in Task 2 and covered by the property in Task 4.
3. **Two clicks before anything lands.** The second click keeps the first click's load, so the first landing releases. Pinned in Task 2.
4. **Refresh in the blocks view.** The groups refetch for the new load through `groupsFetchDue`, unchanged. Pinned in Task 3.
5. **Refresh with an open cell draft.** Releasing rows can unmount the row an open draft is in. The release is a view change like typing a filter, so DataTable's existing unmount commit applies. Task 3 asserts the draft is committed (one write sent), not lost.

---

### Task 1: `stepView` gains `release`

**Files:**
- Modify: `web/src/tables/viewState.ts` (`ViewEvent`, `stepView`)
- Modify: `web/src/props/tables/model.ts` (`RELEASES`, `modelStep`), `web/src/props/tables/arbitraries.ts` (`WEIGHTS`, `eventArb`)
- Modify: `docs/architecture/contracts/frontend-editor.md` § The table view, the event table
- Test: `web/src/tables/viewState.test.ts`

**Interfaces:**
- Produces: `ViewEvent` member `{ kind: "release" }`; `stepView(s, { kind: "release" })` returns `{ ...s, frozen: null }` (live and saved untouched). `stepQueryView` needs no change: it already clears `held` when `frozen` is null.

- [ ] **Step 1: Failing tests** in `viewState.test.ts`: `"release lets held rows go and keeps the live view"`: from a view with a dirty live filter and `frozen: ["a"]`, `stepView(s, { kind: "release" })` has `frozen === null`, `live` and `saved` deep-equal the input's. `"release with no rows held changes nothing"`: returns a state deep-equal to its input.
- [ ] **Step 2: Run** `cd web && pnpm test:unit src/tables/viewState.test.ts`: FAIL (type error / unknown kind).
- [ ] **Step 3: Implement.** Add the event and its case. The table view property draws every `ViewStep` kind, so add `release` to `WEIGHTS` (weight 1) and `eventArb`. In `model.ts`, `modelStep` returns `m` for `release` and `RELEASES` gains `"release"`. Add a row to the contract's event table, under Reset: `| Refresh's records landed | unchanged | unchanged | released | the reader asked for what the query matches now |`.
- [ ] **Step 4: Run** `cd web && pnpm test:unit src/tables/ src/props/tables/viewRun.test.ts && pnpm typecheck`: PASS.
- [ ] **Step 5: Commit** `web: the table view machine gains a release step (pkm-p47v)`.

### Task 2: The query block reducer's `refresh`

**Files:**
- Modify: `web/src/tables/queryBlock.ts`
- Test: `web/src/tables/queryBlock.test.ts`

**Interfaces:**
- Consumes: `{ kind: "release" }` from Task 1.
- Produces: `QueryBlockState.refreshFrom: string | null`, the load current when a pending Refresh was clicked (null when none; `initialQueryBlock` sets null). `QueryBlockEvent` member `{ kind: "refresh"; load: string }`, where `load` is the shell's load key **before** it bumps the generation.

Rules (`apply`):
- `refresh`: sets `refreshFrom` to `e.load` unless it is already non-null.
- `recordsLanded` with `refreshFrom !== null && e.load !== refreshFrom`: compute `held` with `frozen` null (`m.hold(s.records, s.held, p.records, null)`), set `qv` to `m.step(resaved(...), { kind: "release" })`, and set `refreshFrom: null`. A landing for `refreshFrom` itself (the request already out at the click) holds as today and leaves `refreshFrom` set.
- `recordsFailed`: leaves `refreshFrom` as it is.
- Update the file's header comment to say a Refresh releases on the next records landing for a newer load.

- [ ] **Step 1: Failing tests**, in a new `describe("a refresh")`:
  - `"releases the held rows when a newer load's records land"`: freeze rows (an `edited` view event), `refresh` on load `L0`, land records for `L1` without a frozen row. Expect `qv.view.frozen === null`, `qv.held === null`, `held.size === 0`, `refreshFrom === null`.
  - `"holds through a landing of the load it was clicked on"`: as above, but land for `L0`. Expect `frozen` unchanged and `refreshFrom === "L0"`.
  - `"holds through a failure, and the next landing releases"`: `recordsFailed` for `L1` keeps `frozen` and `refreshFrom`; then `recordsLanded` for `L2` releases.
  - `"a second click keeps the first click's load"`: `refresh` `L0` then `refresh` `L1`; `refreshFrom === "L0"`; landing for `L1` releases.
  - `"keeps the live view's unsaved filter"`: a `filter` view event before the edit; after release `qv.view.live.filter` is that filter.
  - `"a landing with no refresh pending still holds"` (pins the resync rule): frozen rows, land for `L1` with no `refresh`, `frozen` unchanged.
- [ ] **Step 2: Run** `cd web && pnpm test:unit src/tables/queryBlock.test.ts`: FAIL.
- [ ] **Step 3: Implement** the rules above.
- [ ] **Step 4: Run** the same: PASS. Then `pnpm test:unit src/props/tables/`: the query property's run tests still pass (it never dispatches `refresh` yet).
- [ ] **Step 5: Commit** `web: a query block refresh releases held rows when newer records land (pkm-p47v)`.

### Task 3: The Refresh button

**Files:**
- Modify: `web/src/components/QueryResults.tsx` (the `header` element; a `refresh` handler)
- Modify: `web/src/styles.css` (`.query-header` area)
- Test: `web/src/components/QueryBlock.test.tsx`

**Interfaces:**
- Consumes: `{ kind: "refresh"; load }` from Task 2.

The handler dispatches `{ kind: "refresh", load }` with the current `load`, then `setGeneration((g) => g + 1)`, so the records effect refetches and `groupsFetchDue` starts `/api/query` when the blocks view shows. The header's right side becomes one `<span className="query-actions">` holding the view group (when `shown !== null`) and the Refresh button, which always shows, including before results land and after an error. `.query-actions { display: inline-flex; gap: 8px; align-items: center; }`. Check `styles.test.ts` for header rules before adding it. Update the file's header comment: results load on mount, a resync and Refresh, never on a cell write.

- [ ] **Step 1: Failing tests**, in a new `describe("refresh")`, using the file's helpers (`stubBooks`, `renderBlock`, `write`, `rowTitles`, `filterBox`; `stubFetch` returns the spy, so count calls by URL):
  - `"a cell write fetches nothing"`: after `write("Book/Alpha", "Reading Status", "Unread")`, the records URL has been fetched once.
  - `"Refresh fetches the records again"`: click `Refresh`, then the records URL has been fetched twice.
  - `"Refresh lets a row an edit took out of the filter go"`: as `"keeps an edited row in place..."` (filter `-status:read`, write Beta to `Read`, "no longer matches" shows); re-stub with Beta's status `Read`, click Refresh, await `"0 of 2 results"`; `rowTitles()` is `[]`, and the filter box still reads `-status:read`.
  - `"Refresh keeps the rows until the new records land"`: stub a records response that does not resolve until released (a deferred promise). After the click, "no longer matches" still shows. Resolve it, and the row goes.
  - `"Refresh retries after an error"`: the first records request is a 500, so the error shows; re-stub with `BOOKS`, click Refresh, and the table shows.
  - `"Refresh in the blocks view fetches the groups again"`: `{{query: ... | view: blocks}}`; click Refresh, and `/api/query` has been fetched twice.
  - `"Refresh commits an open cell draft"`: hold rows, open a cell, change its value, click Refresh, land. `sync.sent` gains that write, nothing is lost.
- [ ] **Step 2: Run** `cd web && pnpm test:unit src/components/QueryBlock.test.tsx`: the new tests FAIL (no button), except `"a cell write fetches nothing"`, which passes today. Confirm it fails when a refetch is forced: add `setGeneration((g) => g + 1)` to `onWrite` temporarily, run, then remove it.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd web && pnpm test:unit && pnpm lint && pnpm typecheck`: PASS.
- [ ] **Step 5: Commit** `web: a Refresh button in the query block header (pkm-p47v)`.

### Task 4: The query view property covers Refresh

**Files:**
- Modify: `web/src/props/tables/queryArbitraries.ts`, `queryRun.ts`, `queryModel.ts`, `queryView.prop.ts` (REACH floors), `queryTeeth.prop.ts`
- Modify: `docs/architecture/contracts/frontend-editor.md` if the model needs a sentence it cannot be written from yet. The model is written from the contract, never from the code.

**Interfaces:**
- Consumes: the `refresh` event (Task 2) and `release` (Task 1).

Read `docs/architecture/checks.md § Property gate` first: a new rule counts only once it is shown to reach (a labelled path with a floor) and to fail (a mutant).

- `QueryStep` gains `{ kind: "refresh" }` (weight 2) and excludes `release` from the reader steps it draws from `ViewEvent`.
- Run: `refresh` dispatches `{ kind: "refresh", load: loadOf(r.net.gen) }`, then does what `resync` does (bump `gen`, set `recordsOut`).
- Model: `QueryModel` gains `refreshPending: boolean`. `refresh` sets it. A records landing (the `load` step, an `answer` with a payload) with `refreshPending` sets `first: null` and clears it, alongside `loadedStep`. A failed `answer` and a `macro` step leave it. The stale guard means an answer from before the click never lands, so "the next landing" in the model equals "a landing for another load" in the reducer.
- Reach labels in `label()`: `"a refreshed load releases a hold"` (held before, a refresh pending, a landing, released after) and `"held through a refresh's failed answer"`. Set each floor the way the comment above `REACH.floors` says (half the lowest share over 30 unseeded reach runs), and update that comment's date and reason.
- Teeth: two mutants, each a wrapper around `QUERY_BLOCK.step`. `"refresh releases at the click"` (on `refresh`, also steps the view with `release`) must be caught by `frozen`. `"refresh never releases"` (drops `refresh` events) must be caught by `frozen` or `hold-rows`.

- [ ] **Step 1:** Add the step, run and model changes. Run `cd web && pnpm test:unit src/props/tables/queryRun.test.ts`: PASS.
- [ ] **Step 2:** Add the mutants. Run `proptest/check.sh web --file tables` from the worktree root with a free `PROPTEST_PORT` (8990–8999): both mutants are caught and the property passes.
- [ ] **Step 3:** Measure and set the floors, then rerun the same check: PASS, with both labels above their floors.
- [ ] **Step 4: Commit** `web: the query view property draws Refresh (pkm-p47v)`.

### Task 5: e2e, docs, gates

**Files:**
- Modify: `web/e2e/query-table.spec.ts` (new test)
- Modify: `docs/keyboard.md` (the query paragraph about Save and Reset)
- Modify: `docs/architecture/frontend-editor.md` or `frontend.md`, wherever `QueryResults`' loading is described. Use the `architecture-docs` skill and state the rule once: a cell edit never refetches; rows stay held until a view change or Refresh.

- [ ] **Step 1: e2e** `"Refresh lets a row an edit took out of the query go"`: seed as the existing test does. Filter `-status:read`, write Alpha's Reading Status to `Read`, and Alpha still shows. Click `Refresh`, and `0 of 2 results` shows with no Alpha row. Run `cd web && E2E_PORT=<free> pnpm e2e query-table` until it passes, then run the full `pnpm verify` (the spec writes shared state).
- [ ] **Step 2: Help:** after the Save/Reset sentence in `docs/keyboard.md`, add: `Editing a cell leaves the rows where they are, even one that no longer matches; Refresh runs the query again.`
- [ ] **Step 3: Gates**, from the worktree root, serially:
  - `cd web && pnpm verify`
  - `proptest/check.sh web`
  - `perf/check.sh frontend`
- [ ] **Step 4:** Add a `## Summary of Changes` to the bean, tick its checklist, and mark it completed. Commit the docs, the spec and the bean.
