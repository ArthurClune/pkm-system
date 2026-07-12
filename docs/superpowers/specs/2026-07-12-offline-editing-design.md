# Offline Editing Design (pkm-y8p0)

Date: 2026-07-12
Status: approved design, pre-implementation
Epic: pkm-y8p0

## Context

The original design (2026-07-08-roam-migration-pkm-design.md) deliberately
excluded offline editing: "dropped connection → reconnecting banner, writes
paused (divergence impossible rather than merged)". pkm-falb later made the
op queue connection-aware: while offline, enqueued ops are preserved in
memory and flushed on reconnect as the newest last-write-wins writers.

This design reverses the no-offline decision. It adds offline reading and
editing to the web client, with a sync protocol deliberately shaped so a
future native iOS client (or installable PWA) can speak it.

Graph scale (actual, 2026-07-12): 4.3k pages, 53k blocks, 15MB SQLite
including FTS indexes; 2GB of assets. The text graph is trivially
replicable to a client; assets are not.

## Requirements (agreed)

Primary scenarios, in priority order:

1. **Laptop on a train**: extended editing sessions, broad read access to
   the whole graph, full editing, two-way sync on reconnect.
2. **Phone out and about** (deferred): capture into daily notes. Out of
   scope for implementation now, but the protocol must support it.

Connectivity model: when there is any network, the Tailnet (and therefore
the server) is reachable. Offline vs online is a clean binary — no
partial-connectivity states.

Must work offline:

- Reading any page (whole graph replicated — no page-selection heuristics)
- Editing blocks (all existing op types)
- Backlinks / linked references
- **Search** (key requirement — must match online search quality)
- Page create and daily-note auto-create
- Viewing recently seen images (cached); placeholder otherwise

Nice to have / explicitly deferred (see Deferred section): query blocks
offline, offline asset upload, full-asset sync, phone PWA polish, native
iOS app.

Conflict handling: **per-block last-write-wins with conflict surfacing**.
Concurrent offline edits to *different* blocks on the same page merge
cleanly. Concurrent edits to the *same* block: the later sync wins, and
the losing text is preserved as a visible conflict-copy block — nothing is
ever silently lost. Character-level merging (CRDT) is rejected as
unnecessary for a single user with two devices.

## Architecture overview

The core move is a **local API shim**, not a rewrite:

- The client maintains a full replica of the text graph in **sqlite-wasm**
  (official build, dedicated worker, `opfs-sahpool` VFS — no COOP/COEP
  headers required).
- When online, the app behaves exactly as today (network reads, op queue
  writes). The replica is kept warm in the background from the server's
  changes feed.
- When offline, `apiFetch` routes read requests to local handlers that
  compute the **same OpenAPI response shapes** from the replica. Views are
  untouched. Writes keep flowing into the (now persisted) op queue and are
  applied optimistically to the replica so they render.
- On reconnect: push pending ops first, then pull the changes feed, then
  bump `resyncSeq` — extending the flush-before-resync ordering
  established in pkm-falb.

Server-authoritative semantics are retained online. This can evolve toward
local-first reads later (same replica underneath) but that inversion is
explicitly not part of this design.

## Section 1: Server — journal, sync endpoints, idempotent pushes

**Changes journal — trigger-maintained, row-level.** New table:

```sql
CREATE TABLE IF NOT EXISTS changes(
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK(kind IN ('block','page','sidebar')),
  entity_id  TEXT NOT NULL,   -- block uid, page id, or sidebar entry id
  deleted    INTEGER NOT NULL DEFAULT 0
);
```

Journal rows are appended by `AFTER INSERT/UPDATE/DELETE` triggers on
`blocks`, `pages` and `sidebar_entries` (same precedent as the existing
FTS triggers in `schema.py`), **not** by per-write-path code. This is
load-bearing, not a convenience: a single op touches many rows beyond its
target — `create` shifts every following sibling's `order_idx`, `move`
rewrites a whole subtree's `page_id`, `delete` cascades to descendants,
and ref extraction implicitly creates pages. Triggers capture every
affected row on every write path, including future ones, in the same
transaction. Deletes leave tombstone rows (`deleted=1`).

`refs` rows are not journaled: they are derived deterministically from
block text, so the feed ships each changed block's current refs alongside
the block payload (hydrated at read time) and the client upserts them.
Because a block's journal row can precede the implicit creation of a page
it references (`UpdateText` executes before `ReindexRefs`), a window
boundary can split a block+refs from the referenced page — so hydration
also includes, as **dependency payloads**, the page rows referenced by
any shipped ref, and clients apply each window in order pages → blocks →
refs → tombstones. A ref's FK target therefore always exists locally.

**Feed pagination — cursor over raw journal rows.** "Latest state, deduped"
must not define the cursor, or entities can be skipped (changes A@1, B@2,
A@100 with a small limit would return A, advance past B, and never send
B). Algorithm:

- Scan raw journal rows `WHERE seq > :since ORDER BY seq LIMIT :n`.
- `next_since` = the last *scanned* row's seq; dedupe entities only
  *within that window*; hydrate current payloads for the deduped set.
- Scan + hydration happen in **one SQLite read transaction**, so a
  concurrent write can't be reflected in the cursor but missing from the
  payloads. Same rule for snapshot: dump + current seq in one
  transaction.
- Upserts are idempotent and order-insensitive, so re-pulling any window
  is always safe.

**Idempotent op pushes.** The durable client queue retries failed pushes,
and a retry after a committed-but-unacknowledged batch must not
double-apply (a replayed `create` alone would hit the uid PK and reject
the whole batch). `OpBatch` gains a client-generated `batch_id` (uuid).
New table `applied_batches(batch_id TEXT PRIMARY KEY, request_hash TEXT,
response TEXT, applied_at INTEGER)`: the server records each batch's
response in the same transaction as its effects; a duplicate `batch_id`
whose `request_hash` matches returns the stored acknowledgement without
re-applying, and a duplicate with a *different* hash is rejected (409) —
a `batch_id` is bound to one payload forever. Records are retained
indefinitely: they are tiny, and any expiry window can be outlived by a
durable client queue (a laptop closed for a month with a
committed-but-unacknowledged batch would double-apply on wake). Batches
without `batch_id` (current clients) behave as today.

**`create_page` op.** Offline page creation needs a durable push path,
and the queue only carries ops — so page creation becomes one: a new
`create_page` op (`page_title`), server-side `get_or_create` by title
(idempotent, LWW-safe, journaled by the triggers like everything else).
The online `POST /api/pages` route is unchanged in v1; the offline shim
enqueues `create_page` for explicit creates. Empty *daily* pages
auto-created offline deliberately don't push: the server re-creates them
on any online visit, and any daily page with content pushes via
`CreateOp.page_title` anyway.

**Sync endpoints** (plain HTTP + JSON; with `/api/ops` these constitute
the whole protocol a native client would speak):

- `GET /api/sync/changes?since=<seq>&limit=<n>` → windowed feed as above:
  entity payloads (block + its refs / page / sidebar entry) or
  tombstones, plus `next_since` and `latest_seq`.
- `GET /api/sync/snapshot` → full JSON dump (pages, blocks, refs, sidebar
  entries) + current `seq`, for initial bootstrap. At 15MB (less,
  compressed) this needs no streaming cleverness in v1.

State-based feed, **not** op replay: upserting current row values is
self-healing and order-insensitive, and fits per-block LWW. Ops remain the
write path; they are not the sync-down format.

**Schema changes.** All additions are `CREATE TABLE IF NOT EXISTS` /
`CREATE TRIGGER IF NOT EXISTS` statements appended to `schema.py` — no
column is added to any existing table (SQLite has no `ADD COLUMN IF NOT
EXISTS`, and `init_db()` blindly executes the DDL string; if a column
addition is ever needed it requires a `PRAGMA table_info`-guarded helper
first).

**WebSocket.** The existing WS additionally carries a "seq advanced" nudge
so online clients know to pull the feed. The invariant: **every
transaction that advances `changes.seq` emits a post-commit nudge** — not
just `/api/ops` (today the only broadcasting route) but page
creation/deletion, sidebar writes, daily-page auto-creation on GET, and
asset-upload text rewrites. Implementation should centralize this (one
post-commit hook where routes commit) rather than relying on each route
remembering. The existing op-batch broadcast remains for live UI
patching; the feed is the authority for the replica.

## Section 2: Server — conflict handling

Conflict detection uses a **text hash, not a version counter**:
`update_text` gains an optional `base_text_hash` (sha256 of the text the
edit was based on). A version-per-any-change counter was considered and
rejected — collapse, heading, move, or an automatic `order_idx` shift
would bump it and turn an *unchanged* server text into a spurious
conflict copy. Comparing text against text detects exactly the conflicts
we care about, adds no schema column, and needs no rule for how
consecutive offline edits advance versions: each queued edit's
`base_text_hash` is the previous local text, so a user's own edit chain
flushes cleanly (op N leaves the server text that op N+1's hash matches).
Timestamps are not used — device clocks are not trusted.

Semantics:

Checks run in this order:

1. Block does not exist (edit-vs-delete race) → conflict block on
   today's daily page (see below).
2. Incoming text == current text → idempotent no-op, never a conflict.
   (Checked before any hash comparison: when two devices independently
   make the identical edit, the second one's base hash no longer matches
   the current text, so the base-hash check alone would file a spurious
   conflict copy.)
3. `base_text_hash` absent → apply exactly as today (current clients
   remain valid).
4. Hash matches current text → apply normally.
5. Hash differs (a concurrent text edit happened): the incoming edit
  **wins** (consistent with existing reconnect-flush LWW), and the
  overwritten server text is preserved as a **conflict-copy sibling
  block** inserted immediately after the target block. Marker format
  decided in the implementation plan (e.g. a `[[conflict]]`-tagged block
  containing the losing text), so conflicts are findable by
  search/backlinks.
- Structural op kinds (`move`, `set_collapsed`, `set_heading`, `delete`):
  plain LWW, no conflict detection — structural/cosmetic conflicts are
  not worth surfacing.
- Edit-vs-delete race (`update_text` targets a block that no longer
  exists): the op carries only `uid` + `text`, and the deleted row's
  page/parent are gone, so the orphaned edit materialises as a conflict
  block appended to **today's daily page** (which always auto-creates) —
  a predictable, daily-visited place — rather than being dropped or
  requiring block-tombstone metadata retention.

Conflict copies are ordinary blocks: they sync, they show up in search,
the user deletes them after reconciling. No special UI in v1.

## Section 3: Client replica — sqlite-wasm

- Official sqlite-wasm in a dedicated worker; `opfs-sahpool` VFS.
- **Schema shared with the server**: `schema.py` splits its DDL into a
  **base schema** (pages, blocks, refs, assets, sidebar, FTS tables +
  FTS triggers) and a **server-only section** (`changes` journal +
  journaling triggers, `applied_batches`). Only the base schema is
  exported as a build artifact (same pattern as `openapi_dump.py` →
  generated TS types) so client and server base schemas cannot drift;
  exporting the whole file would install the server's journal triggers in
  the replica, silently growing an unused local journal on every upsert.
  The replica adds its own client-only tables (sync cursor/meta, pending
  op queue) on top. FTS5 tables and triggers come along in the base, so
  the replica's search index maintains itself on every upsert.
- Replica lifecycle:
  - First run: bootstrap from `/api/sync/snapshot`, store the cursor.
  - Online: WS nudge → `GET /api/sync/changes?since=<cursor>` → upsert
    rows / apply tombstones → advance cursor. The replica is always warm;
    going offline requires no preparation.
  - Offline: local ops are applied optimistically to the replica so the
    user's own edits render (including in backlinks and search).
  - Reconnect: push pending ops, then pull feed, then `resyncSeq` bump.
  - Corruption/desync escape hatch: drop the local DB and re-bootstrap
    (15MB — cheap enough to be the recovery story).
- **Refs**: synced content's refs arrive in the feed (server-derived, no
  client parsing needed). Ref extraction in TS is required only for
  *offline local edits* — offline-written `[[links]]`/`#tags`/attributes
  must produce refs rows locally so backlinks work before sync. TS port
  of `refs.py`, parity-tested against the Python implementation via
  shared fixtures.
- **Offline page creation — ID reconciliation**: the replica shares the
  server schema, where `pages.id` is a server-assigned integer and
  `blocks.page_id`/`refs.target_page_id` are FKs onto it. Pages created
  offline (explicitly, via daily auto-create, or implicitly by local ref
  extraction) get **temporary negative ids** locally. Ops reference pages
  by `page_title` (already the case for `CreateOp`/`MoveOp`), so nothing
  negative ever goes over the wire. On sync, when the feed delivers a
  page whose title matches a negative-id local page, the authoritative
  row can't simply be upserted (the negative row owns the UNIQUE title)
  and children can't be pointed at a not-yet-inserted positive id under
  immediate FKs — and deleting the negative row first would
  cascade-delete its blocks. The concrete sequence is one transaction
  with `PRAGMA defer_foreign_keys = ON` (transaction-scoped; defers even
  immediate FKs to commit): remap children/refs from negative to
  authoritative id → delete the negative page row → insert the
  authoritative page row → commit. (Most blocks are corrected by their
  own feed upserts anyway — flush pushes the ops, the feed returns those
  blocks with real `page_id`s — the remap covers rows the window hasn't
  delivered yet.)
- **Persisted op queue**: pending ops move from in-memory arrays to a
  table inside the replica DB, so queued offline edits survive tab refresh
  and browser restart (fixing a known gap in the current design). Each
  `update_text` records its `base_text_hash` captured at enqueue time;
  each flushed batch carries its durable `batch_id`, so a retry after a
  lost acknowledgement is deduplicated server-side rather than
  double-applied.

## Section 4: Offline reads — the API shim

`apiFetch` gains a router. Online: straight to network, zero behaviour
change. Offline: requests are served by local handlers over the replica,
returning the same OpenAPI response shapes. Views do not change.

Shim coverage in v1, from an audit of every route the app calls:

- `GET /api/page/{title}` — block tree + backlinks (grouped, with
  breadcrumbs); daily pages auto-create locally.
- `GET /api/unlinked` — unlinked references (fetched separately from the
  page payload; FTS over the replica).
- `GET /api/journal` — the daily-notes home view; required for the
  train scenario to function at all.
- `GET /api/titles` — `[[...]]` autocomplete; required for offline
  editing to feel intact.
- `GET /api/block-refs` — resolving `((block refs))` for rendering.
- `GET /api/search` — real FTS5 over the replica, same query semantics,
  ranking and snippets as the server.
- `POST /api/pages` (page create) — creates locally with a temporary
  negative id (Section 3) and enqueues a `create_page` op (Section 1) so
  the page reaches the server even if it never gets a block.
- `GET /api/sidebar` — read only.

Online-only in v1 (clear error / placeholder, nothing queued):

- Sidebar writes (`POST`/`PUT`/`DELETE /api/sidebar…`) and page deletion
  (`DELETE /api/page/{title}`) — neither goes through the op queue, and
  each would need a second offline write path.
- Query blocks (`GET /api/query`, `{{query}}` rendering): "unavailable
  offline" placeholder.
- Asset upload (`POST /api/assets`).

Status UI: the read-only-when-disconnected banner is replaced by an
unobtrusive "offline — N changes pending" indicator; editing stays
enabled. After reconnect, the indicator drains to zero as the queue
flushes.

## Section 5: App shell and assets

- **Service worker** via vite-plugin-pwa: precache the app shell so a
  cold-started browser with no network still opens the app. Web manifest
  included — this is most of the future phone-PWA groundwork, at near-zero
  extra cost.
- **Assets offline**: runtime Cache-API caching of any asset actually
  viewed, with an LRU cap (a few hundred MB). Uncached assets render a
  placeholder offline. `navigator.storage.persist()` is requested so the
  cache and replica survive eviction pressure.
- Full-asset sync (all 2GB, "sync everything on fast wifi" button) is
  **deferred**: browser quotas would allow it on modern desktop browsers,
  but it drags in a listing endpoint, progress/resume UX and top-up logic
  for a rarely-needed payoff. It is purely additive later (lives entirely
  in the SW/Cache layer).

## Section 6: Error handling

- Feed pull fails mid-way: cursor only advances after a window of changes
  is applied transactionally; retry is safe (upserts are idempotent).
- Op push fails on reconnect: existing desync path (clear + resync) is
  replaced by: keep the persisted queue, surface an error state, retry.
  Retries are safe because each batch carries a durable `batch_id` and
  the server returns the stored acknowledgement for a batch it already
  committed (Section 1) — a lost response cannot double-apply. The queue
  is durable so nothing is lost by closing the tab. A poison batch
  (server 4xx) is set aside and surfaced rather than retried forever;
  exact UX in the implementation plan.
- Replica schema version mismatch (after a deploy that changes DDL): drop
  and re-bootstrap — but **never while the pending queue is non-empty**.
  The queue lives inside the replica DB, so an unconditional drop would
  erase unsynced offline work. Rebootstrap requires connectivity anyway
  (it fetches the snapshot), and queued ops are wire-format JSON
  independent of the local schema, so the recovery sequence is: flush the
  pending queue to the server first, then drop and re-bootstrap. If the
  flush fails, surface the error and keep the old database — degraded
  beats data loss. The same rule guards the manual "reset local data"
  escape hatch, if one is exposed.
- Storage quota errors: if a mutation cannot be persisted to the replica
  (quota exhausted while offline), the editor must **reject further
  edits** (read-only state with an explicit reason) rather than appear to
  accept an unpersisted edit — "fall back to online-only" is impossible
  at that moment, and a silently volatile queue would be disguised data
  loss. Online, quota failure degrades to online-only operation with the
  replica disabled.

## Section 7: Testing

- Server: unit tests for trigger journaling per op kind — asserting
  *derived* rows are journaled (sibling shifts on create, subtree on
  move, descendants on delete, implicit pages from ref extraction);
  changes-feed windowed-cursor algorithm (incl. the A@1/B@2/A@100
  skip case), tombstones, one-transaction hydration, and the
  window-boundary refs case (block+ref shipped whose implicitly-created
  page falls outside the window → dependency page payload present);
  snapshot; `base_text_hash` conflict matrix in check order (missing
  block → daily page, identical-text no-op, absent hash, match, differ;
  no false conflict after collapse, heading, move, or sibling shift);
  WS nudge emitted by every journal-advancing write path (incl. a
  non-op write — page create, sidebar edit, daily auto-create —
  propagating to another replica);
  `batch_id` dedup (replay with matching request hash returns stored ack
  and applies nothing; same id with different hash → 409); `create_page`
  op idempotency.
- Parity: shared fixtures run through the Python route handlers and the TS
  shim, asserting identical JSON (page load, backlinks, search where
  rankings are deterministic). TS `refs` extraction parity-tested against
  `refs.py` fixtures.
- Client: opQueue persistence across simulated restart; optimistic replica
  application; reconnect ordering (flush → pull → resync), extending the
  pkm-falb regression suite; negative-id reconciliation transaction
  (children/refs remapped, no cascade delete, FKs intact at commit, incl.
  a page that has local-only blocks the feed window hasn't delivered);
  schema-mismatch recovery with a non-empty pending queue (flush happens
  first; failed flush keeps the old database and drops nothing).
- E2E (verify skill): go offline (dev-tools network toggle / kill server),
  edit + create daily note + search, restart tab, reconnect, assert server
  state and conflict-copy behaviour with a second concurrent client.

## Section 8: Build order (child beans)

1. Server: `changes` journal + triggers (schema split into base +
   server-only DDL), windowed `/api/sync/changes` with dependency pages,
   `/api/sync/snapshot`, WS seq nudge.
2. Server: `batch_id` dedup (indefinite retention, request-hash bound);
   `base_text_hash` conflict handling + conflict-copy blocks (incl.
   identical-text no-op and edit-vs-delete → daily page); `create_page`
   op.
3. Web: sqlite-wasm replica worker, base-schema artifact export,
   bootstrap, feed application (pages → blocks → refs → tombstones),
   cursor persistence.
4. Web: persisted op queue (`batch_id`, `base_text_hash`) + optimistic
   replica application + TS ref extraction + negative-id page
   reconciliation (deferred-FK transaction).
5. Web: apiFetch offline router + shim (page/unlinked/journal/titles/
   block-refs/create/sidebar-read) + offline status indicator.
6. Web: offline search (FTS5 over replica).
7. Web: service worker app shell + asset runtime cache + manifest.

Each step lands independently behind the others (1–2 are inert without a
consumer; 3–4 are inert until 5 flips reads).

## Deferred (explicitly out of scope)

- Offline asset upload (queue for reconnect) — next slice once the above
  works.
- Full-asset sync button (2GB pre-cache).
- Offline query-block evaluation.
- Phone/PWA installability polish and testing; native iOS app.
- Local-first read inversion (always read local, even online).

## Notes for a future native iOS client

The protocol surface is: login (session cookie), `GET /api/sync/snapshot`,
`GET /api/sync/changes?since=`, `POST /api/ops` (with `batch_id` +
`base_text_hash`), WS seq nudge, `GET /assets/…`. All JSON over HTTP. The
client-side data layer is SQLite with the same schema and the same
queries as the web shim, so the web implementation doubles as the
reference implementation for Swift.

Contract hardening required before building the native client (not v1
work, but named so it isn't forgotten): the OpenAPI document currently
has no cookie security scheme and protected operations declare no
security; `/api/ops` returns a free-form success object; error responses
(400/401/404/409) are mostly undocumented; and the WebSocket messages
need their own small versioned schema (they are outside OpenAPI). The web
client tolerates all of this because it shares the repo; a second
independent client should not.
