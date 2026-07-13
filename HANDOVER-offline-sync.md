# Handover: offline-sync todo beans (goal session, 2026-07-13)

## Goal (session stop-hook)
Work through ALL todo beans finishing the offline sync epic (pkm-y8p0), then
update **README.md** (user docs for the offline feature + its limitations) and
**docs/design.md** (make it correct for all recent changes). Goal is done only
when all of that holds.

## Where work happens
- Worktree: `/Users/arthur/code/llm/pkm/.claude/worktrees/offline-sync-web`
- Branch: `codex/pkm-offline-web` (pushed; merged to main at two checkpoints so far)
- Plan (grounding for everything): `docs/superpowers/plans/2026-07-13-offline-sync-web.md`
- Spec: `docs/superpowers/specs/2026-07-12-offline-editing-design.md`
- **Run `beans` commands FROM THE WORKTREE cwd** — running them in the main
  checkout dirties main's `.beans/` (happened twice; was reverted via
  `git -C /Users/arthur/code/llm/pkm checkout .beans`).

## Bean status
| Bean | Status | Notes |
|---|---|---|
| pkm-o9o5 generation token | **completed, merged to main** | sync_meta table + generation echoed in both sync payloads |
| pkm-x7a5 server follow-ups | **completed, merged to main** | all 5 items incl. IntegrityError race test |
| pkm-gtov replica worker | **completed, merged to main** | snapshot timing measured: 0.49s hydrate/15MB — fine |
| pkm-su05 queue/optimistic/reconcile | **completed, merged to main** | |
| pkm-wptk shim + indicator | **in-progress** — code ~done, needs verify+e2e | see below |
| pkm-blz2 offline search | code done (search.ts + parity green), bean still todo | flip to in-progress→completed with its own commit |
| pkm-xnnh service worker/PWA | **not started** | plan tasks 17–18 |
| docs (README.md, docs/design.md) | **not started** | plan task 19; do LAST, describe shipped behaviour |

## Current uncommitted WIP (wptk, in worktree)
All implemented and individually tested; last action was fixing a SyncProvider
status-ref timing bug (gateway must see socket status synchronously — fixed by
setting `statusRef.current` inside `onStatus`). `SyncProvider.test.tsx` now 11/11.
**Not yet re-run:** full `pnpm vitest run` + `pnpm typecheck` after that fix —
do that first.

WIP contents:
- `web/src/api/client.ts`: OfflineError + `setOfflineGateway`; offline routing
  when `gateway.offline()`, plus fetch-TypeError fallback to the shim.
- `web/src/replica/localApi/`: `router.ts` (route table incl. POST /api/pages
  → local negative-id page + enqueued `create_page`), `pages.ts` (page payload
  w/ backlinks+breadcrumbs, unlinked), `journal.ts`, `tree.ts`, `fts.ts`,
  `search.ts` (blz2). Parity test `parity.test.ts` replays
  `shared/fixtures/shim_parity.json` — **all 15 cases byte-identical incl. 4
  search cases**.
- Server: `shim_parity_dump.py` + guard test `test_shim_parity_fixture.py` +
  committed fixture.
- `workerHandlers.ts`: `localApi` handler wired (with newBatchId dep).
- `SyncProvider.tsx`: gateway registration effect (uses statusRef/modeRef).
- `OfflineIndicator.tsx` replaces ReconnectBanner (deleted; App.tsx updated).
  **No test file for OfflineIndicator yet** (ReconnectBanner.test.tsx was NOT
  deleted — check; it may still exist and fail. If so replace with
  OfflineIndicator tests: connected+0 pending → null; connected+N → syncing;
  offline+canEdit → "Offline — N changes pending"; offline+!canEdit → reason).
- `QueryBlock.tsx`: OfflineError → "query unavailable offline".

## Remaining work, in order
1. **Finish wptk**: run `pnpm vitest run`, `pnpm typecheck`, fix fallout
   (check ReconnectBanner.test.tsx / api client.test.ts — new gateway code may
   need tests for coverage thresholds 95/91/89/95: OfflineError paths,
   localFetch 4xx→ApiError, fetch-fallback). Then e2e offline scenario
   (`web/e2e/offline.spec.ts`, plan task 15): login → offline
   (`context.setOffline(true)`) → edit block, create page, autocomplete,
   backlinks, search → reconnect → server state assertions + indicator drains.
   Existing e2e patterns in `web/e2e/`; `pnpm e2e` builds first; server for e2e
   via `server/tests/e2e_serve.py` (see playwright.config.ts). NEVER port 8974.
   Then `cd web && pnpm verify`, `cd server && uv run pytest -q && uv run
   pyrefly check && uv run ruff check`. Commit (bean file too), complete bean.
2. **blz2**: already-written `search.ts`; route works offline via gateway.
   Add offline-search step to the e2e; commit separately, complete bean.
3. **xnnh**: `pnpm add -D vite-plugin-pwa`; VitePWA config in vite.config.ts
   (autoUpdate, manifest, navigateFallback /index.html with denylist /api,
   /assets, /login; runtimeCaching CacheFirst for `/assets/` with
   `expiration {maxEntries: 400, purgeOnQuotaError: true}`), registerSW +
   `navigator.storage.persist()` in main.tsx (coverage-exclude any new glue),
   icons in web/public/, AssetImage offline placeholder on img error, e2e
   cold-start-offline test (SW serves shell after hard reload). Commit,
   complete bean.
4. **Docs**: README.md — user-facing offline section (what works offline:
   read/edit/search/backlinks/page+daily create; what doesn't: asset upload,
   sidebar edits, page delete, query blocks; conflict-copy `[[conflict]]`
   blocks + edit-vs-delete → today's daily page; storage quota read-only;
   first-visit-needs-online; per-browser replica). docs/design.md — check it
   exists & update replica/sync-protocol/generation-token/shim/PWA sections to
   match shipped code. Commit.
5. **Final**: full server+web verification, merge `--no-ff` to main
   (check main clean first — other sessions exist), push. Do NOT deploy prod
   (not part of the goal; update memory file re: prod not deployed).
6. Update auto-memory (offline-epic-y8p0-status.md) to final state.

## Key facts / gotchas
- Replica-logic tests: `// @vitest-environment node` + real sqlite-wasm via
  `src/replica/testDb.ts` (in-memory, works in vitest — spiked, FTS5 present).
- `toPortLike()` adapter needed for MessagePort/Worker → PortLike.
- Regen commands (server tests enforce all three artifacts):
  - `uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`
    then `cd web && pnpm gen-types`
  - `uv run python -m pkm.schema_dump > ../web/src/replica/baseSchema.gen.ts`
  - `uv run python -m pkm.refs_parity_dump > ../shared/fixtures/refs_parity.json`
  - `uv run python -m pkm.server.shim_parity_dump > ../shared/fixtures/shim_parity.json`
- Web coverage thresholds enforced (95/91/89/95); excluded: worker.ts, testDb.ts.
- Reconnect ordering invariant: queue flush → replicaSync.start()+idle → resync
  bump (SyncProvider onStatus).
- Rebootstrap guardrail: NEVER reset with non-empty pending queue; flush first
  (replicaSync.rebootstrap + schema-mismatch recovery in start()).
- Commit style: per-bean commits incl. `.beans/` file; always push; merge to
  main with `--no-ff` at stable checkpoints only.
