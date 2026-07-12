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

## Section 1: Server — versions, journal, sync endpoints

**Per-block version.** `blocks` gains `version INTEGER NOT NULL DEFAULT 0`,
incremented on every change to that block. Added as an idempotent
statement appended to `schema.py` (the project's no-migration-runner
convention). Timestamps (`updated_at`) are not used for conflict
detection — device clocks are not trusted.

**Changes journal.** New table:

```sql
CREATE TABLE IF NOT EXISTS changes(
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK(kind IN ('block','page','sidebar')),
  entity_id  TEXT NOT NULL,   -- block uid, page id, or sidebar entry id
  deleted    INTEGER NOT NULL DEFAULT 0
);
```

`ops_apply` (and any other write path: sidebar routes, page create, asset
text rewrites) appends journal rows **in the same transaction** as the
write. The journal records only *that* an entity changed; current values
come from the base tables at read time. Deletes leave a tombstone row
(`deleted=1`) since the base row is gone.

**Sync endpoints** (plain HTTP + JSON; with `/api/ops` these constitute
the whole protocol a native client would speak):

- `GET /api/sync/changes?since=<seq>` → for each entity changed after
  `seq` (deduped to latest state): full current payload (block row / page
  row / sidebar entry) or a tombstone; plus `latest_seq`. Paginated via
  `limit` + repeated calls; order-insensitive upserts make this trivially
  resumable.
- `GET /api/sync/snapshot` → full JSON dump (pages, blocks, refs, sidebar
  entries) + current `seq`, for initial bootstrap. At 15MB (less,
  compressed) this needs no streaming cleverness in v1.

State-based feed, **not** op replay: upserting current row values is
self-healing and order-insensitive, and fits per-block LWW. Ops remain the
write path; they are not the sync-down format.

**WebSocket.** The existing WS additionally carries a "seq advanced" nudge
so online clients know to pull the feed. The existing op-batch broadcast
remains for live UI patching; the feed is the authority for the replica.

## Section 2: Server — conflict handling

Ops gain an optional `base_version` field (per op, for ops that target an
existing block). Semantics:

- `base_version` absent → behave exactly as today (current clients remain
  valid).
- `base_version` == current version → apply normally.
- `base_version` < current version (concurrent edit happened):
  - `update_text`: the incoming edit **wins** (consistent with existing
    reconnect-flush LWW), and the overwritten server text is preserved as
    a **conflict-copy sibling block** inserted immediately after the
    target block. Marker format decided in the implementation plan (e.g. a
    `[[conflict]]`-tagged block containing the losing text), so conflicts
    are findable by search/backlinks.
  - Other op kinds (`move`, `set_collapsed`, `set_heading`, `delete`):
    apply LWW without conflict copies — structural/cosmetic conflicts are
    not worth surfacing.
- Edit-vs-delete race (op targets a block that no longer exists): the
  orphaned `update_text` materialises as a conflict block appended to the
  end of the page (or daily page if the page is gone too) rather than
  being dropped.

Conflict copies are ordinary blocks: they sync, they show up in search,
the user deletes them after reconciling. No special UI in v1.

## Section 3: Client replica — sqlite-wasm

- Official sqlite-wasm in a dedicated worker; `opfs-sahpool` VFS.
- **Schema shared with the server**: `schema.py`'s DDL is exported as a
  build artifact (same pattern as `openapi_dump.py` → generated TS types)
  so client and server schemas cannot drift. FTS5 tables and triggers come
  along for free, so the replica's search index maintains itself on every
  upsert.
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
- **Ref extraction in TS**: offline-written `[[links]]`/`#tags`/attributes
  must produce refs rows locally so backlinks work. TS port of `refs.py`,
  parity-tested against the Python implementation via shared fixtures.
- **Persisted op queue**: pending ops move from in-memory arrays to a
  table inside the replica DB, so queued offline edits survive tab refresh
  and browser restart (fixing a known gap in the current design). Each op
  records the target block's `base_version` captured at enqueue time.

## Section 4: Offline reads — the API shim

`apiFetch` gains a router. Online: straight to network, zero behaviour
change. Offline: requests are served by local handlers over the replica,
returning the same OpenAPI response shapes. Views do not change.

Shim coverage in v1:

- `GET /api/page/{title}` — block tree, backlinks (grouped, with
  breadcrumbs), unlinked references; daily pages auto-create locally.
- Page create (and any title-keyed page upsert; pages merge by title on
  sync, so offline creation is idempotent).
- `GET /api/search` — real FTS5 over the replica, same query semantics,
  ranking and snippets as the server.
- Sidebar read. (Sidebar *writes* don't go through the op queue and would
  need a second offline write path — they stay online-only in v1.)
- Query blocks (`{{query}}`): render an "unavailable offline" placeholder
  in v1.
- Asset upload: unavailable offline in v1 (clear error, nothing queued).

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

- Feed pull fails mid-way: cursor only advances after a page of changes is
  applied transactionally; retry is safe (upserts are idempotent).
- Op push fails on reconnect: existing desync path (clear + resync) is
  replaced by: keep the persisted queue, surface an error state, retry;
  the queue is durable so nothing is lost by closing the tab. A poison
  batch (server 4xx) is set aside and surfaced rather than retried
  forever; exact UX in the implementation plan.
- Replica schema version mismatch (after a deploy that changes DDL): drop
  and re-bootstrap.
- Storage quota errors: surface, keep working online-only.

## Section 7: Testing

- Server: unit tests for version bumping, journal rows per op kind,
  changes-feed dedup/tombstones/pagination, snapshot, `base_version`
  conflict matrix (incl. edit-vs-delete).
- Parity: shared fixtures run through the Python route handlers and the TS
  shim, asserting identical JSON (page load, backlinks, search where
  rankings are deterministic). TS `refs` extraction parity-tested against
  `refs.py` fixtures.
- Client: opQueue persistence across simulated restart; optimistic replica
  application; reconnect ordering (flush → pull → resync), extending the
  pkm-falb regression suite.
- E2E (verify skill): go offline (dev-tools network toggle / kill server),
  edit + create daily note + search, restart tab, reconnect, assert server
  state and conflict-copy behaviour with a second concurrent client.

## Section 8: Build order (child beans)

1. Server: `version` column, `changes` journal + transactional appends,
   `/api/sync/changes`, `/api/sync/snapshot`, WS seq nudge.
2. Server: `base_version` conflict handling + conflict-copy blocks.
3. Web: sqlite-wasm replica worker, schema artifact export, bootstrap,
   feed application, cursor persistence.
4. Web: persisted op queue + optimistic replica application + TS ref
   extraction.
5. Web: apiFetch offline router + shim (page/backlinks/daily/create/
   sidebar) + offline status indicator.
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
`GET /api/sync/changes?since=`, `POST /api/ops` (with `base_version`), WS
seq nudge, `GET /assets/…`. All JSON over HTTP. The client-side data layer
is SQLite with the same schema and the same queries as the web shim, so
the web implementation doubles as the reference implementation for Swift.
