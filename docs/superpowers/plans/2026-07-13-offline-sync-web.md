# Offline Sync — Web Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full offline reading, editing and search in the web client, backed by a
sqlite-wasm replica of the text graph and the server sync protocol shipped in
pkm-dnl6/pkm-o9o5.

**Architecture:** A dedicated worker owns a sqlite-wasm database (opfs-sahpool
VFS) built from the server's exported BASE_DDL plus client-only tables (sync
cursor/meta, pending op queue). All logic that touches SQL lives in functional
modules over a narrow `ReplicaDb` interface so vitest can run them against real
sqlite-wasm in Node (spiked: works, FTS5 included, v3.53). The worker shell and
main-thread RPC client are thin. `apiFetch` gains an offline router that serves
shimmed routes from the replica with the same OpenAPI shapes. Writes always flow
through a persisted op queue in the replica (batch_id + base_text_hash),
applied optimistically to the replica, pumped to `/api/ops` when online.

**Tech Stack:** @sqlite.org/sqlite-wasm (^3.53), vite-plugin-pwa (workbox),
existing React 18 + vitest + Playwright setup.

**Beans:** pkm-gtov → pkm-su05 → pkm-wptk → pkm-blz2 + pkm-xnnh (dependency order).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-offline-editing-design.md` (sections 3–7).
- Guardrail (epic): schema recovery reads the pending queue BEFORE any teardown;
  never rebootstrap with a non-empty queue; `pending_ops(id, batch_id, ops_json)`
  stays extractable by newer clients (additive changes only).
- Replica must consume seq nudges + feed for conflict-copy visibility (WS op
  broadcasts do NOT carry conflict copies).
- Feed application order within one transaction: pages → blocks → refs → tombstones.
- Generation token mismatch (pkm-o9o5) or `reset:true` → guarded rebootstrap.
- FCIS: every new runtime file declares `// pattern: Functional Core` or
  `// pattern: Imperative Shell`.
- Replica-logic tests run with `// @vitest-environment node` against real
  sqlite-wasm in-memory DBs; React/shell tests stay jsdom with fakes.
- Coverage thresholds (95/91/89/95) stay enforced; only genuinely
  browser-only shells (`replica/worker.ts`, SW registration) join the
  coverage exclude list.
- Dev servers must never take port 8974 (prod launchd service).
- All commands run from the worktree root `.claude/worktrees/offline-sync-web`.

## File Map

Generated artifacts (committed, guarded by server tests):
- `web/src/replica/baseSchema.gen.ts` — `export const BASE_SCHEMA` from schema.py BASE_DDL
  (generator `server/src/pkm/schema_dump.py`, guard in `server/tests/test_schema_artifact.py`).
- `shared/fixtures/refs_parity.json` — refs.py extraction cases (generator
  `server/src/pkm/refs_parity_dump.py`, guard in `server/tests/test_refs_parity_fixture.py`).
- `shared/fixtures/shim_parity/` — seed + request/response pairs recorded through
  the FastAPI routes (generator `server/src/pkm/server/shim_parity_dump.py`,
  guard `server/tests/test_shim_parity_fixture.py`); TS side replays them
  against the local handlers.

Replica (functional, node-env tested against real sqlite-wasm):
- `web/src/replica/db.ts` — `ReplicaDb` interface + `wrapSqlite(oo1Db)`.
- `web/src/replica/clientSchema.ts` — CLIENT_DDL (`sync_client_meta`,
  `pending_ops`) + `SCHEMA_VERSION` (hash of BASE_SCHEMA + CLIENT_DDL).
- `web/src/replica/meta.ts` — cursor/generation/schema-version get/set.
- `web/src/replica/apply.ts` — `applySnapshot`, `applyChanges` (+ negative-id
  reconciliation from su05 onwards).
- `web/src/replica/sha256.ts` — small synchronous sha256 (hex) for
  base_text_hash + SCHEMA_VERSION.
- `web/src/replica/refs.ts` — TS port of refs.py `extract`.
- `web/src/replica/daily.ts` — TS port of daily.py title/date helpers.
- `web/src/replica/localOps.ts` — optimistic op application (all 7 op kinds,
  negative page ids, local ref reindex).
- `web/src/replica/queue.ts` — persisted op queue over the replica DB.
- `web/src/replica/localApi/*.ts` — offline handlers returning OpenAPI shapes:
  `tree.ts`, `pages.ts`, `journal.ts`, `titles.ts`, `blockRefs.ts`,
  `unlinked.ts`, `sidebar.ts`, `search.ts`, `router.ts`.

Replica shell:
- `web/src/replica/rpc.ts` — typed request/response RPC over a MessagePort-like.
- `web/src/replica/client.ts` — main-thread facade (`Replica`), worker-injectable.
- `web/src/replica/worker.ts` — the dedicated worker: sqlite init
  (opfs-sahpool, in-memory fallback), RPC dispatch (coverage-excluded).

App integration:
- `web/src/api/client.ts` — offline router + `OfflineError`.
- `web/src/sync/opQueue.ts` — replica-backed pump (batch_id, poison handling).
- `web/src/sync/SyncProvider.tsx` — replica lifecycle: bootstrap, nudge-driven
  pulls, reconnect flush→pull→resync, schema-mismatch flush-first recovery,
  pending count, canEdit/quota state.
- `web/src/components/OfflineIndicator.tsx` — replaces ReconnectBanner.
- `web/vite.config.ts` — optimizeDeps exclude, coverage excludes, PWA plugin (xnnh).
- `web/src/main.tsx` — SW registration + `navigator.storage.persist()` (xnnh).

---

### Task 1 (pkm-gtov): base-schema artifact export

**Files:** Create `server/src/pkm/schema_dump.py`,
`server/tests/test_schema_artifact.py`, `web/src/replica/baseSchema.gen.ts`.

**Produces:** `BASE_SCHEMA: string` (verbatim BASE_DDL). Regen command:
`cd server && uv run python -m pkm.schema_dump > ../web/src/replica/baseSchema.gen.ts`.

Steps: RED server test asserting the committed artifact embeds exactly
`pkm.schema.BASE_DDL` (parse the TS file: content between backticks equals
BASE_DDL with backslash/backtick/dollar escaping reversed); GREEN via the dump
script; run, commit.

### Task 2 (pkm-gtov): ReplicaDb wrapper, client schema, meta helpers

**Files:** Create `web/src/replica/db.ts`, `clientSchema.ts`, `meta.ts`,
`sha256.ts`, test helper `web/src/replica/test-db.ts` (opens in-memory
sqlite-wasm, wraps, installs schema), tests alongside.

**Interfaces:**
```ts
export type SqlValue = string | number | null | Uint8Array;
export interface ReplicaDb {
  exec(sql: string, params?: SqlValue[]): void;
  select<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): T[];
  transaction<T>(fn: () => T): T;   // BEGIN/COMMIT, ROLLBACK on throw
}
export function wrapSqlite(db: Oo1DbLike): ReplicaDb;
// clientSchema.ts
export const CLIENT_DDL: string;      // sync_client_meta(key,value) + pending_ops
export const SCHEMA_VERSION: string;  // sha256 of BASE_SCHEMA + CLIENT_DDL
export function installSchema(db: ReplicaDb): void; // pragmas + BASE + CLIENT + version stamp
// meta.ts
export function getMeta(db: ReplicaDb, key: string): string | null;
export function setMeta(db: ReplicaDb, key: string, value: string): void;
// keys: "cursor", "generation", "schema_version"
```
`pending_ops(id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL,
ops_json TEXT NOT NULL, poisoned INTEGER NOT NULL DEFAULT 0, error TEXT)`.
Pragmas on install/open: `foreign_keys=ON`, `recursive_triggers=ON`.

Tests: wrapSqlite round-trip + transaction rollback on throw; installSchema is
idempotent and creates pages/blocks/refs/FTS + client tables; sha256 against
two known vectors (empty string, "abc").

### Task 3 (pkm-gtov): feed application

**Files:** Create `web/src/replica/apply.ts` + `apply.test.ts`.

**Interfaces:**
```ts
import type { components } from "../api/types";
type Changes = components["schemas"]["ChangesPayload"];
type Snapshot = components["schemas"]["SnapshotPayload"];
export function applySnapshot(db: ReplicaDb, snap: Snapshot): void;
// wipes graph tables, inserts everything, stores cursor=snap.seq + generation
export type ApplyResult = { status: "applied"; cursor: number }
                        | { status: "needs-bootstrap" };
export function applyChanges(db: ReplicaDb, feed: Changes): ApplyResult;
// needs-bootstrap when feed.reset or feed.generation !== stored generation
```
Application (one transaction): pages upsert → blocks upsert (INSERT ... ON
CONFLICT(uid) DO UPDATE, `AFTER UPDATE OF text` FTS trigger keeps index right) →
refs (DELETE per shipped block, insert shipped refs) → tombstones (DELETE
pages/blocks/sidebar rows; FK cascades + recursive triggers clean children/FTS)
→ setMeta cursor. Block upsert order: parents may arrive after children in the
same window, so insert blocks with `parent_uid` deferred? No — FKs on blocks
are immediate; wrap the whole window in `PRAGMA defer_foreign_keys = ON` so
intra-window ordering never matters.

Tests (node env, real wasm): snapshot bootstrap populates all tables + FTS
searchable + cursor/generation stored; changes upsert new/edited block incl.
refs replace; re-applying the same window is idempotent; tombstone deletes
subtree + FTS rows; page tombstone cascades to blocks; block arriving before
its parent in one window applies (defer_foreign_keys); reset:true →
needs-bootstrap; generation flip → needs-bootstrap; empty feed advances nothing.

### Task 4 (pkm-gtov): RPC + main-thread client

**Files:** Create `web/src/replica/rpc.ts`, `client.ts`, tests (jsdom,
MessageChannel).

**Interfaces:**
```ts
// rpc.ts
export interface PortLike {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}
export function serveRpc(port: PortLike, handlers: Record<string, (payload: unknown) => Promise<unknown>>): void;
export function callRpc<T>(port: PortLike, method: string, payload?: unknown): Promise<T>;
// client.ts — pattern: Imperative Shell
export interface ReplicaInit {
  ok: boolean;             // false => no-replica mode (wasm/OPFS unavailable)
  empty: boolean;          // needs snapshot bootstrap
  cursor: number;
  schemaMismatch: boolean; // stored schema_version differs
  pendingBatches: PendingBatch[]; // read BEFORE any teardown (guardrail)
}
export interface PendingBatch { id: number; batch_id: string; ops: BlockOp[]; poisoned: boolean }
export interface Replica {
  init(): Promise<ReplicaInit>;
  applySnapshot(snap: Snapshot): Promise<void>;
  applyChanges(feed: Changes): Promise<ApplyResult>;
  enqueue(ops: BlockOp[]): Promise<{ pending: number }>;     // su05
  nextBatch(): Promise<PendingBatch | null>;                  // su05
  deleteBatch(id: number): Promise<{ pending: number }>;      // su05
  markPoisoned(id: number, error: string): Promise<{ pending: number }>; // su05
  pendingCount(): Promise<number>;
  localApi(req: LocalApiRequest): Promise<unknown | null>;    // wptk
  reset(): Promise<void>; // drop + reinstall schema; caller enforces empty-queue guard
}
export function createReplica(port: PortLike): Replica;
```
Errors cross the port as `{ error: string, quota?: boolean }` and reject the
promise with `ReplicaError` (`.quota` preserved for the su05 quota path).

### Task 5 (pkm-gtov): worker shell + vite wiring

**Files:** Create `web/src/replica/worker.ts` (coverage-excluded),
`web/src/replica/workerHandlers.ts` (testable dispatch map over an injected
`ReplicaDb`); modify `web/vite.config.ts` (optimizeDeps.exclude sqlite-wasm,
coverage exclude worker.ts).

worker.ts: `sqlite3InitModule()` → try `installOpfsSAHPoolVfs` → `new
sqlite3.oo1.DB('file:pkm.sqlite3?vfs=opfs-sahpool')`; on any failure fall back
`{ok:false}` (no-replica mode); wrap → build handlers → `serveRpc(self, handlers)`.
workerHandlers.ts: pure map construction: init/applySnapshot/applyChanges/
reset (+ su05/wptk methods later) — tested in node env with the in-memory DB.
init: installSchema if empty file, read meta, read pending_ops FIRST, compare
SCHEMA_VERSION. reset: drop all tables (`PRAGMA writable_schema` not needed —
`SELECT name FROM sqlite_master WHERE type='table'` + DROP, skip `sqlite_`
internals and FTS shadow tables via `DROP TABLE IF EXISTS` on known names +
`blocks_fts`/`pages_fts` virtual tables) then installSchema.

### Task 6 (pkm-gtov): SyncProvider replica lifecycle

**Files:** Modify `web/src/sync/SyncProvider.tsx`, `web/src/sync/socket.ts`
(surface seq frames), new `web/src/sync/replicaSync.ts` (driver logic,
testable), tests.

**Interfaces:**
```ts
// socket.ts additions
export interface WsSeq { type: "seq"; seq: number }
connectSocket(opts: { onBatch; onSeq?: (f: WsSeq) => void; onStatus }): SocketHandle;
// replicaSync.ts — pattern: Imperative Shell (fetch + replica orchestration)
export interface ReplicaSync {
  start(): Promise<void>;              // init → bootstrap if empty/mismatch-with-empty-queue
  onSeq(seq: number): void;            // debounced pull loop while online
  pull(): Promise<void>;               // drain changes until next_since === latest_seq
  dispose(): void;
}
export function createReplicaSync(deps: {
  replica: Replica;
  fetchJson: <T>(path: string) => Promise<T>;  // apiFetch (network-only variant)
  onState: (s: ReplicaState) => void;          // feeds React state
}): ReplicaSync;
export type ReplicaState =
  | { mode: "starting" } | { mode: "no-replica" } | { mode: "ready"; pending: number }
  | { mode: "recovery-failed"; error: string };
```
pull(): loop `GET /api/sync/changes?since=<cursor>` → applyChanges →
needs-bootstrap → (guard: queue empty — always true in gtov) snapshot rebootstrap.
Concurrent-pull suppression: single in-flight pull, trailing re-run flag.
SyncProvider: create worker via injected factory (default `new Worker(new URL(
"../replica/worker.ts", import.meta.url), {type:"module"})`), wire socket
onSeq → driver, expose `replicaMode` on context. Tests: fake Replica + fake
fetch: bootstraps when empty, pulls on seq, rebootstraps on generation flip,
no-replica mode tolerated.

Commit + merge checkpoint; bean pkm-gtov complete.

### Task 7 (pkm-su05): refs + daily TS ports with parity fixtures

**Files:** Create `server/src/pkm/refs_parity_dump.py`,
`server/tests/test_refs_parity_fixture.py`, `shared/fixtures/refs_parity.json`,
`web/src/replica/refs.ts` + test, `web/src/replica/daily.ts` + test.

refs_parity.json: ~25 cases covering links, nested links, #tags, #[[...]],
attributes, code fences/inline code stripping, dedupe, block refs, embeds.
Python guard regenerates expectations via `refs.extract` and asserts the file
matches. TS test iterates the fixture: `extractRefs(text)` equals expected.
```ts
export interface ExtractedRef { title: string; kind: "link" | "tag" | "attribute" }
export function extractRefs(text: string): { refs: ExtractedRef[]; blockRefs: string[] };
export function titleForDate(d: Date): string;   // "July 13th, 2026"
export function dateForTitle(title: string): Date | null;
```

### Task 8 (pkm-su05): optimistic local op application

**Files:** Create `web/src/replica/localOps.ts` + `localOps.test.ts`.

**Interfaces:**
```ts
export function applyLocalOps(db: ReplicaDb, ops: BlockOp[], nowMs: number, todayTitle: string): void;
export function getOrCreateLocalPage(db: ReplicaDb, title: string, nowMs: number): number;
// negative temp ids for offline-created pages: MIN(0, MIN(id)) - 1
```
Port of ops_core plan/execute semantics without conflict handling (local apply
is always clean): create (sibling shift + insert + reindex refs + touch page),
update_text (update + reindex), move (incl. cross-page SetPageId over subtree),
delete (subtree deepest-first), set_collapsed, set_heading, create_page
(get_or_create). Ref reindex uses `extractRefs` + getOrCreateLocalPage (implicit
pages get negative ids). Errors: throw `LocalOpError` — enqueue callers treat
as bug, never partial-apply (transaction).

Tests mirror server ops tests: sibling shift on create; cross-page move
rewrites subtree page_id; delete cascades; refs rows appear for offline
`[[links]]`/#tags/attr and FTS finds new text; implicit page gets negative id;
two implicit pages get distinct negative ids; create_page is idempotent locally.

### Task 9 (pkm-su05): persisted queue in the replica

**Files:** Create `web/src/replica/queue.ts` + tests; modify
`workerHandlers.ts` to expose enqueue/nextBatch/deleteBatch/markPoisoned/
pendingCount.

```ts
export function enqueueBatch(db: ReplicaDb, ops: BlockOp[], nowMs: number, todayTitle: string,
                             batchId: string): { pending: number };
// one transaction: capture base_text_hash (sha256 of current text) for each
// update_text BEFORE optimistic apply; insert pending_ops row; applyLocalOps
export function nextBatch(db: ReplicaDb): PendingBatch | null;   // oldest non-poisoned
export function deleteBatch(db: ReplicaDb, id: number): number;  // returns pending count
export function markPoisoned(db: ReplicaDb, id: number, error: string): number;
export function pendingCount(db: ReplicaDb): number;             // non-poisoned
export function allBatches(db: ReplicaDb): PendingBatch[];       // recovery reads
```
Tests: enqueue persists wire JSON incl. batch_id + hashes; hash matches
pre-apply text (chained edits: op2's base hash = op1's text); optimistic apply
visible; nextBatch skips poisoned; counts.

### Task 10 (pkm-su05): negative-id page reconciliation

**Files:** Create `web/src/replica/reconcile.ts` (called from apply.ts on page
upsert) + tests.

```ts
export function reconcilePage(db: ReplicaDb, incoming: SyncPage): void;
```
Inside the (already defer_foreign_keys) window transaction: if a local page has
`title = incoming.title AND id < 0`: remap `blocks.page_id`,
`refs.target_page_id` from negative to incoming.id, DELETE the negative page
row, INSERT authoritative row. Tests: children/refs remapped, no cascade
delete, FKs intact at commit, local-only blocks (not yet delivered by feed)
survive with correct page_id; a positive-id page upsert unaffected.

### Task 11 (pkm-su05): replica-backed op pump + SyncProvider integration

**Files:** Rewrite `web/src/sync/opQueue.ts` (+ its tests); modify
`SyncProvider.tsx`, `replicaSync.ts`, `useOutline.ts` (readOnly →
`!sync.canEdit`), tests incl. connectionAware suite update.

opQueue interface becomes async-source pump:
```ts
export interface OpQueue {
  enqueue(ops: BlockOp[]): void;      // fire-and-forget: replica.enqueue then kick
  setOnline(online: boolean): void;
  idle(): Promise<void>;
  onPending(fn: (n: number) => void): () => void;
  onPoison(fn: (e: unknown) => void): () => void;
}
export function createOpQueue(replica: Replica, onDesync: (e: unknown) => void): OpQueue;
```
Pump: `nextBatch` → POST /api/ops `{client_id, batch_id, ops}` → deleteBatch.
Network error → stop (retry on reconnect kick), queue preserved. 400/409 →
markPoisoned + onPoison (no desync clear — spec section 6 replaces clear+resync
with durable queue). Reconnect ordering preserved: setOnline(true) → pump →
idle() → replicaSync.pull() → resyncSeq bump.
Recovery path in SyncProvider start: init → schemaMismatch && pending>0 →
flush pending batches straight from `init.pendingBatches` via POST (batch_id
dedup makes replays safe) → on success reset()+bootstrap; on failure keep old
DB, mode "recovery-failed" (degraded online-only). Quota: ReplicaError.quota on
enqueue → canEdit=false with reason "storage full" while offline.
Context additions: `canEdit: boolean`, `pending: number`, `offline: boolean`,
`readOnlyReason?: string`.

Commit + merge checkpoint; bean pkm-su05 complete.

### Task 12 (pkm-wptk): shim parity fixture harness + tree/page handlers

**Files:** Create `server/src/pkm/server/shim_parity_dump.py`,
`server/tests/test_shim_parity_fixture.py`, `shared/fixtures/shim_parity/*`,
`web/src/replica/localApi/tree.ts`, `pages.ts`, `parity.test.ts`.

Fixture: deterministic seed (pages/blocks/refs/sidebar incl. a daily page,
nested blocks, block refs, unlinked mentions) + for each shimmed GET the
recorded route JSON (page w/ backlinks+breadcrumbs+block_ref_texts, unlinked,
journal at a pinned date, titles, block-refs, sidebar, search queries).
Server guard test regenerates through TestClient and asserts committed files
match. TS parity test: load seed into replica → run handler → deep-equal.

```ts
// tree.ts
export function blockTree(db: ReplicaDb, pageId: number): BlockNode[];
export function blockRefTexts(db: ReplicaDb, texts: string[]): Record<string, BlockRefText>;
// pages.ts
export function pagePayload(db: ReplicaDb, title: string, opts: { autoCreateDaily: boolean; nowMs: number }): PagePayload | null;
```
Port the SQL from `tree.py`, `backlinks.py`, `routes_pages.py` (read them
first; keep query text as close to Python as possible).

### Task 13 (pkm-wptk): journal/titles/block-refs/unlinked/sidebar handlers + router

**Files:** Create `journal.ts`, `titles.ts`, `blockRefs.ts`, `unlinked.ts`,
`sidebar.ts`, `router.ts` in `web/src/replica/localApi/`; extend
workerHandlers with `localApi`; extend parity test.

```ts
export interface LocalApiRequest { method: string; path: string; body?: unknown; nowMs: number }
export function handleLocalApi(db: ReplicaDb, req: LocalApiRequest): unknown | null; // null = not shimmed
```
Routes: GET /api/page/{title} (daily auto-create local), GET /api/unlinked,
GET /api/journal (local daily auto-create for today, no push — spec),
GET /api/titles, GET /api/block-refs?uids=, GET /api/sidebar,
POST /api/pages (negative-id create + enqueue create_page op → returns PageMeta).
Unshimmed → null.

### Task 14 (pkm-wptk): apiFetch offline routing + indicator + canEdit UX

**Files:** Modify `web/src/api/client.ts`, `web/src/components/ReconnectBanner.tsx`
→ `OfflineIndicator.tsx` (and App usage), `QueryBlock.tsx` (offline
placeholder), `EditableSidebarPanel.tsx` + asset upload path (clear online-only
errors), tests.

```ts
// client.ts
export class OfflineError extends ApiError {} // status 0
export interface OfflineGateway { handle(path: string, init?: RequestInit): Promise<unknown | null>; offline(): boolean }
export function setOfflineGateway(gw: OfflineGateway | null): void;
```
apiFetch: gateway present && gateway.offline() → `gateway.handle` → non-null
result returned; null → throw OfflineError. Online path unchanged (zero
behaviour change). SyncProvider registers the gateway (replica localApi +
enqueue for POST /api/pages) when replica ready; offline() = ws status !==
connected. Indicator: hidden when connected & pending 0 (brief "syncing N…"
while draining), "offline — N changes pending" when offline & canEdit, read-only
reason when !canEdit (no replica / storage full / recovery-failed), poison
error surface with a "copy details" affordance. Views: QueryBlock catches
OfflineError → "unavailable offline" placeholder.

### Task 15 (pkm-wptk): E2E offline scenario

**Files:** Create `web/e2e/offline.spec.ts` (verify-skill patterns; build first).

Scenario: login → open daily note → `context.setOffline(true)` → edit a block,
create a page via search-create, `[[link]]` autocomplete works, page nav +
backlinks render → reload tab (SW not yet shipped: navigate within SPA session
instead; full cold-start lands in xnnh) → `setOffline(false)` → queue drains →
server state assertion via API + indicator back to clean.

Commit + merge checkpoint; bean pkm-wptk complete.

### Task 16 (pkm-blz2): offline search

**Files:** Create `web/src/replica/localApi/search.ts`; extend router,
parity fixtures with the search queries from `routes_search.py` (read for
exact MATCH/rank/snippet SQL); route GET /api/search offline; SearchBar works
offline in the e2e.

Parity: identical JSON for deterministic-rank queries (page-title hits, single
block hit with snippet); plus TS tests for prefix queries and quoting parity
with the server's query mangling (port whatever `fts.py` does to user input).

Commit + merge checkpoint; bean pkm-blz2 complete.

### Task 17 (pkm-xnnh): service worker app shell + manifest

**Files:** Modify `web/vite.config.ts` (vite-plugin-pwa), `web/index.html`,
`web/src/main.tsx` (registerSW + storage.persist()), create
`web/public/` icons (generate simple SVG/PNG), coverage excludes for
registration glue.

Config: `VitePWA({ registerType: "autoUpdate", manifest: {...}, workbox: {
navigateFallback: "/index.html", navigateFallbackDenylist: [/^\/api/, /^\/assets/, /^\/login/],
runtimeCaching: [asset rule below], } })`. Precache = app shell (dist assets).
`/api/*` never cached (NetworkOnly by omission from precache + denylist).

### Task 18 (pkm-xnnh): asset runtime cache + placeholder + e2e cold start

**Files:** vite.config.ts runtimeCaching rule for `/assets/` —
CacheFirst, `expiration: { maxEntries: 400, purgeOnQuotaError: true }`;
`AssetImage.tsx` offline placeholder on error; `web/e2e/offline-shell.spec.ts`:
visit page with image → offline → hard reload → app boots from SW, replica
serves content, cached image renders, uncached image shows placeholder.

Commit + merge checkpoint; bean pkm-xnnh complete.

### Task 19: docs

Update `README.md` (user-facing offline feature docs + limitations) and
`docs/design.md` (replica architecture, sync protocol incl. generation token,
offline shim, PWA) — cross-check against the shipped code, not the spec.
Final full verification: server pytest/pyrefly/ruff, web `pnpm verify`,
merge --no-ff to main, push.

## Self-Review Notes

- Spec coverage: sections 3 (tasks 1–6, 8–10), 2+1 client side (9, 11), 4
  (12–14), search (16), 5 (17–18), 6 error handling (5 init guard, 11 recovery/
  quota/poison, 14 UX), 7 testing (parity fixtures tasks 7/12/16, e2e 15/18).
- Deferred (unchanged): offline asset upload, full-asset sync, offline query
  blocks, sidebar writes, page delete offline.
- Type names referenced (BlockNode, PagePayload, BlockRefText, SyncPage,
  ChangesPayload, SnapshotPayload) come from generated `api/types.d.ts`.
