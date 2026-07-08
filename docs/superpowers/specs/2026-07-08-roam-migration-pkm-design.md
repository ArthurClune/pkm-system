# Roam → Custom PKM: Design

**Date:** 2026-07-08
**Status:** Approved 2026-07-08

## Goal

Replace Roam Research with a custom, locally-hosted PKM running on the Mac mini,
accessed remotely over Tailscale. Full daily-driver: daily notes, outliner editing,
backlinks, `{{[[query]]}}` support, images/PDFs served locally.

## Requirements (from brainstorming)

- **Usage:** full daily driver — daily notes as home, real editing in the browser.
- **Devices:** desktop browser and iPad Safari with hardware keyboard are
  first-class (full outliner). Phone: must view all pages and append content
  (text with `[[links]]`, image upload); no outline manipulation on touch.
- **Must-have workflow features:** daily-notes journal home, shift-click sidebar,
  fast full-text search, unlinked references.
- **Roam features in scope:** backlinks, nested blocks, `[[page]]` / `#tag` /
  `Attr::` linking, namespace pages (`[[AWS/SCP]]`), markdown (bold/italic/code
  blocks), embedded images and PDFs (hosted locally), `{{[[query]]}}` blocks
  (create and render; `and`/`or`/`not` over page refs — graph sampling shows
  almost all queries are simple `{and: [[A]] [[B]]}`).
- **Out of scope:** encrypted blocks, multiple graphs, multi-user, full datalog,
  offline editing. Block-embeds appear unused (importer will verify); `((block
  refs))` appear rare-to-absent (importer will report the true count — if
  nonzero, rendering them becomes a v1 item, creating them stays out).
- **Stack:** TypeScript frontend (React + Vite), typed Python backend
  (FastAPI + Pydantic), SQLite + FTS5 storage.
- **Access:** Tailscale Serve for HTTPS/remote, plus a basic static-password
  login (session cookie) so the app is not open to other devices on the home
  LAN. Not internet-grade auth by design.
- **Import source:** Roam EDN export (full fidelity: uids, order, timestamps)
  plus the linked-files download for assets. Markdown export rejected as source
  (loses uids/structure).

## Architecture (Approach A — server-authoritative, block-granular)

SQLite on the mini is the single source of truth. The frontend fetches a page's
block tree, applies edits optimistically, and sends block-level operations to
the server. A WebSocket broadcasts committed ops to other open clients
(desktop + iPad live-consistent). No CRDT; per-block last-write-wins.

Rejected alternatives:
- **B: client-side in-memory graph + op-log sync** (Roam's own architecture):
  snappiest, but we'd own a sync protocol and its data-loss failure modes;
  approach A already gives instant feel at single-user scale.
- **C: markdown files + rebuildable index** (Obsidian-style): most portable, but
  files fight stable block uids, ordering, and live structural edits. We take
  the durability win instead via a nightly markdown export.

## Section 1: Data model (SQLite)

```sql
pages(id, title UNIQUE, created_at, updated_at)
blocks(uid PK,                    -- Roam's uid preserved on import; new = nanoid
       page_id, parent_uid NULL,  -- NULL = top-level block of page
       order_idx, text, heading, collapsed, created_at, updated_at)
refs(src_block_uid, target_page_id, kind)   -- kind: link | tag | attribute
assets(sha256 PK, filename, mime, size, created_at)
blocks_fts                        -- FTS5 over block text + page titles
```

- Block `text` is Roam-flavoured markdown stored **unmodified**: `[[links]]`,
  `#tags`, `Attr::`, `{{[[query]]: …}}`, code fences stay literal. `refs` and
  `blocks_fts` are derived indexes rebuilt on block change. Notes are always
  plain text in one durable file.
- Backlinks = indexed query on `refs`. Unlinked references = FTS search for the
  title, minus pages already in `refs`. Query blocks = set operations on `refs`.
- Pages are created implicitly on first reference (Roam semantics). Namespace
  pages: `/` is part of the title; subpage listing by title prefix.
- **Daily pages keep Roam's ordinal title format** (`July 8th, 2026`) so every
  imported daily-note link keeps working; the app maps dates ↔ titles with the
  same convention.
- **Asset storage:** files live on the filesystem, not in SQLite. Layout:
  `data/assets/<sha256[:2]>/<sha256>` (content-addressed, deduplicated), with
  original filename, mime type, and size in the `assets` table. Served as
  `GET /assets/{sha256}/{original-filename}` — the filename in the URL is
  cosmetic (downloads/tabs get sensible names); lookup is by hash. Identical
  files uploaded twice store once. Backup = copy one SQLite file + one assets
  directory (rsync/Time Machine friendly since content-addressed files never
  change after creation).
- **Flagged duplication:** ref-extraction grammar (`[[…]]`, `#tag`, `Attr::`)
  exists in Python (server indexing) and TS (client rendering). A shared test
  fixture file pins both parsers to identical behaviour.

## Section 2: Import pipeline (Python, re-runnable)

- Input: EDN export (structure: uids, order, timestamps, headings, collapse
  state) + linked-files download (assets).
- Each run builds a **fresh database file** and atomically swaps it in — no
  upsert logic. Re-run weekly while building; final run at cutover.
- Asset URLs (`firebasestorage.googleapis.com/…`) rewritten in block text to
  local `/assets/…` paths; files content-addressed by sha256.
- Ends with a report: pages/blocks imported; asset URLs matched vs missing;
  unrecognised constructs (nothing silently dropped); actual counts of
  `((block-refs))` and `{{embed}}` in the full graph.

## Section 3: Backend API & sync (FastAPI + Pydantic)

Pydantic models → OpenAPI schema → generated TS client types: the block model
cannot drift between languages.

- `GET /api/page/{title}` → block tree + backlinks (grouped by source page,
  with breadcrumb context) + unlinked references. Daily pages auto-create.
- `POST /api/ops` → batch of block ops: `create`, `update_text`, `move`,
  `delete`, `set_collapsed`. Op application re-derives that block's refs + FTS
  rows in the same transaction. Ops are the **only** write path (editor, phone
  composer, future CLI/LLM tooling).
- `GET /api/search?q=` → FTS5 with snippets, title matches ranked first.
- `GET /api/query?expr=` → evaluates Roam query syntax: `and`/`or`/`not` over
  page refs, including nested combinators (e.g. `{and: [[A]] {or: [[B]] [[C]]}}`),
  returns blocks grouped by page.
- `POST /api/assets` (paste / drag / file picker upload);
  `GET /assets/{hash}/{name}` serves images and PDFs.
- `WS /api/ws` → committed op batches broadcast to other clients, which patch
  in-memory page state. Per-block last-write-wins. No offline editing: dropped
  connection → "reconnecting…" banner, writes paused (divergence impossible
  rather than merged).

- **Auth:** single static password (stored as a hash in server config, never in
  the repo). A minimal login page sets a signed, long-lived session cookie
  (`HttpOnly`, `Secure`, `SameSite=Lax`); all API routes and the WebSocket
  require it; comparison is constant-time. This guards against other devices
  on the home LAN — it is deliberately not internet-grade auth; Tailscale
  remains the transport boundary for remote access.

FCIS: op application, ref extraction, query evaluation, backlink grouping are
pure Functional Core modules; FastAPI routes, SQLite access, WebSocket hub are
thin Imperative Shell.

### Performance & scale targets

Sized for a large personal graph — targets: **50k pages / 500k blocks / 5 GB
assets**, pages with **thousands of blocks**, and titles with **hundreds to
low-thousands of backlinks**, all while staying interactive:

- Server side is not the constraint: backlinks are a single indexed `refs`
  lookup and FTS5 queries are milliseconds at this scale. WAL mode keeps reads
  concurrent with writes.
- Rendering is the constraint, so the UI never renders unbounded lists:
  the backlinks section loads lazily (after the page body) and shows grouped
  results incrementally (first N source pages, "show more" / auto-load on
  scroll); unlinked references compute on demand (collapsed by default —
  opening the section triggers the FTS query); query blocks paginate their
  results the same way.
- Large page bodies stay cheap because only the focused block is a live input;
  if profiling shows very long outlines lagging, list virtualization is the
  known fallback (kept out of v1 unless needed).
- Daily-notes home loads a few days at a time, appending as you scroll.

## Section 4: Frontend (React + TS + Vite)

Everything is the outliner, Roam-style: only the **focused** block is a live
input (auto-growing textarea showing raw markdown); all other blocks are
rendered HTML. Same editing feel as Roam, fast on large pages, iPad-Safari
friendly (one input element at a time).

- **Keyboard:** Enter = new sibling; Tab / Shift-Tab = indent / outdent;
  Alt-↑/↓ = move block; arrows cross block boundaries; Cmd-K = search;
  Esc = blur. All functional on iPad hardware keyboard.
- **Autocomplete:** `[[` or `#` opens fuzzy page-title completion.
- **Rendering:** markdown (bold/italic/links), code blocks with syntax
  highlighting, navigable `[[links]]`/`#tags`, `Attr::` styled like Roam,
  inline images, PDFs in an inline viewer with download link,
  `{{[[query]]}}` blocks render live results grouped by page.
- **Layout:** daily-notes journal home (today first, infinite scroll back);
  shift-click opens links in a stackable right sidebar; backlinks + unlinked
  references under every page; left nav with search and shortcuts.
- **Phone:** same responsive app. Tap-to-edit blocks; fixed "add to this page"
  composer at bottom (text with `[[` autocomplete + image upload from camera /
  photo library). No indent/drag on touch.

## Section 5: Deployment, backup, testing

- **Service:** launchd on the Mac mini; the app binds to `127.0.0.1` only and
  is exposed via **Tailscale Serve** (HTTPS termination, tailnet-only, proper
  secure origin for Safari clipboard APIs). LAN devices not on the tailnet
  cannot reach it at all; the static password (Section 3) is defense in depth
  on top.
- **Backups (nightly launchd jobs):** rotating SQLite online backup; full
  markdown + assets export into a git-committed directory (never locked in
  twice).
- **Testing:** TDD throughout. pytest on functional core (ref parser, op
  application, query eval, importer vs fixture EDN); vitest on TS core
  (markdown rendering, outline state); shared parser fixture keeps the two
  grammars honest; Playwright smoke test for the core editing loop.

## Real-export import findings (2026-07-08, Task 10)

First real import: **4,313 pages / 52,695 blocks / 27,308 refs / 1,647 assets
(2.0 GB)** in ~4 minutes (pure-Python EDN parse dominates; acceptable for a
batch step, optimize only if it becomes annoying).

- **`((block-refs))`: 1,344 across the graph → rendering them is IN scope for
  v1** (plan 3). Creating new ones stays out of scope.
- **`{{embed}}`: 0 → embed support dropped from v1.**
- Assets: 1,565/1,580 referenced URLs resolved via uid-prefix matching (Roam's
  download names files `<10-char-uid>-<original name>`; URLs use
  `<uid>.<ext>`). 2 URLs are absent from Roam's own download (noted in
  import-report.txt); 82 stored files are unreferenced leftovers — kept.
- Orphan blocks 223 (0.4%), skipped entities 23 — acceptable residue.
- Ignored attributes worth revisiting later: `:page/sidebar` (23) holds the
  user's sidebar shortcuts (nice import for plan 3's left nav);
  `:children/view-type` (262) is a numbered/document-view rendering hint we
  currently drop; `:block/props` (30) unexamined, low count.

### Read-API smoke findings (plan 2)

Ran the full read API (`pkm.server.setup` + `pkm.server.run`) against the real
imported database (4,313 pages / 52,695 blocks) on port 8974. All checklist
items passed; no code changes needed.

- **Title substitutions: none needed.** Every title named in the task-10 brief
  (`Generative Models`, `AWS/SCP`, `Machine Learning`, the `{and: [[Generative
  Models]] [[Link]]}` query, `datascript` search term) already exists in the
  real graph, so all curls ran as written.
- **Auth:** `/healthz` → `{"ok":true}`; login sets the session cookie;
  `/api/search` without a cookie → `401`; `/assets/...` without a cookie →
  `401` too (asset route is gated, confirmed explicitly).
- **Page endpoint:** `GET /api/page/Generative Models` returns `page` +
  block `tree` + `backlinks` (grouped by source page, each group carrying
  `page_id`/`page_title`/`items` with `uid`/`text`/`breadcrumbs`) +
  `block_ref_texts` (map of referenced-block uid → `{text, page_title}`) — all
  four populated with real data (4 backlink groups, 4 resolved block refs on
  this page).
- **Namespace page:** `GET /api/page/AWS/SCP` (literal slash in the path)
  resolved correctly to the `AWS/SCP` page — no path-splitting issues.
- **Backlink pagination:** verified on the two most-linked pages in the
  graph — `Tags` (2,383 refs) and `Paper` (423 refs). Both cap at `limit: 20`
  per page and report `total_pages` (2,373 for `Tags`) and `offset` — matches
  the "pagination on every list" requirement.
- **Search:** `q=datascript` returned a real block hit from `roam/render`
  with `<mark>datascript</mark>` snippet highlighting; no page-title matches
  for this term (expected — it's a code-block term, not a page name).
- **Query eval:** `{and: [[Generative Models]] [[Link]]}` returned 4 matching
  blocks grouped by page (`Generative Models` itself plus three daily-journal
  entries) — nested and/or/not evaluation works against real data.
- **Unlinked references:** `title=Machine Learning` returned plausible
  mention-only blocks (e.g. `AGI`, `AI Bias`, `AI Chips` pages referencing
  "machine learning" in prose without a `[[...]]` link).
- **Journal:** `days=3` returned today (2026-07-08, `July 8th, 2026`) plus the
  prior two days. Today's page **already existed** in the real export (the
  user had used Roam today before the export), so the auto-create-if-missing
  path wasn't actually exercised by this run — worth a follow-up smoke test
  on a date with no existing journal page to confirm creation still works.
- **Assets:** fetched one PNG (`image/png`, 788,354 bytes) and one PDF
  (`application/pdf`, 985,418 bytes) by sha256+filename. Both returned
  `cache-control: private, max-age=31536000, immutable` (note: `private`,
  not `public` — correct given the endpoint is auth-gated) plus correct
  `content-type`, `etag`, `last-modified`, `accept-ranges: bytes`.
- **Latency:** every call was fast. `GET /api/page/Paper` (423 backlinks):
  28ms cold, 10ms warm. `GET /api/page/Tags` (2,383 backlinks, the single
  most-linked page in the graph): 35ms cold, 19ms warm. Well under the
  <100ms target with zero optimization — SQLite + indexed refs is plenty for
  this graph size.
- **Data integrity:** confirmed page/block counts unchanged after the smoke
  test (4,313 pages / 52,695 blocks, matching `import-report.txt` exactly).
  The sqlite file's mtime moved (WAL checkpoint from read connections) but no
  rows were added or altered — the pre-existing today's-journal page was read,
  not written.
- **No encoding surprises:** titles with slashes, unicode, and markdown-style
  brackets in block text all round-tripped through JSON cleanly in this pass.

### Write-path smoke findings (plan 3)

Ran the full in-process write path (`POST /api/ops`, `POST /api/assets`,
`WS /api/ws`) via `TestClient` against a **scratch copy** of the real
imported database (4,313 pages / 52,695 blocks), made with the SQLite
backup API so the live file was only ever opened for two read-only count
queries (before and after). All checklist items passed on the first run;
no code changes needed.

- **Data integrity (explicit):** `pre` and `post` counts against the real
  `data/pkm.sqlite3` were identical — `4,313 pages / 52,695 blocks` both
  before and after the entire smoke run. The real database was never
  opened for writing; only the scratch copy under `data/smoke-scratch/`
  received any mutation, and that directory was removed at the end of the
  run.
- **Op latency:** the first batch — implicit page creation + block create
  with a `[[link]]` and a `#tag` (which drives ref extraction, FTS
  indexing, and page auto-creation all in one transaction) — completed in
  **4ms** against the full 52k-block graph. No perceptible slowdown from
  running against real-sized data vs. a synthetic fixture.
- **Implicit page creation:** creating a block with `page_title: "PKM
  Smoke Test"` (a title that didn't exist) correctly auto-created the page
  and the referenced page `PKM Smoke Link` in the same batch.
- **Ref/FTS re-derivation on edit:** `update_text` on the block (removing
  the `[[link]]` and `#tag`) correctly removed the page's backlink group
  from `PKM Smoke Link` and removed the block from FTS search results
  (`smoketag` query returned zero hits post-edit) — confirms refs and FTS
  are re-derived from scratch on every text update, not incrementally
  patched.
- **WS broadcast:** a 3-op batch (create child, move child to root, collapse
  parent) sent while a websocket client was connected produced exactly one
  broadcast message containing `client_id: "smoke"` and all 3 ops — batch
  atomicity and broadcast-per-batch (not per-op) both confirmed.
- **Move + collapse:** after the batch above, `GET /api/page/PKM Smoke
  Test` returned blocks in the correct post-move order
  (`[smoketest002, smoketest001]`), confirming `move` and `set_collapsed`
  landed correctly together with `create` in one transaction.
- **Delete subtree:** deleting both blocks left the page with an empty
  block list — no orphaned rows or dangling refs.
- **Write on a real heavy page:** appending a block to today's daily page
  (`title_for_date(date.today())`, an existing page with real content)
  with a `[[Paper]]` reference correctly surfaced in `Paper`'s backlinks
  (Paper already carries 423 real backlinks from the import); deleting
  the block cleaned it up again with no side effects on the pre-existing
  entries.
- **Atomicity on invalid batch:** issuing `set_collapsed` on a uid that had
  already been deleted correctly returned `400` and did not touch the
  real data — batch validation rejects the whole request rather than
  partially applying it.
- **Asset upload roundtrip:** `POST /api/assets` with a small binary
  payload returned a URL that, when fetched back through the same client,
  returned byte-identical content.
- **Nothing surprising.** Every assertion in the brief's script passed on
  the first run, including against the two structural gotchas the plan-2
  read-path smoke flagged as unexercised (today's-journal auto-create and
  large-page backlink pagination) — this run didn't touch those paths
  directly, but the write path showed the same "SQLite + indexed refs is
  plenty for this graph size" latency characteristics plan-2 found on the
  read side.

### Write-path API contract notes (plan 3 final review)

- **`MoveOp.order_idx` frame of reference (plan-5 editor MUST match this):**
  the index is interpreted as "insert before the block currently at
  `order_idx`, counted BEFORE the moved block is removed from its old
  position". Example: siblings `[A, B, C]` (A at 0); moving A to
  `order_idx=2` yields `[B, A, C]`, not `[B, C, A]`. Sibling shifts leave
  gaps rather than renumbering; readers order by `order_idx` so gaps are
  harmless.
- **Deferred cleanup for plan 4 pre-flight** (from the plan-3 final review;
  all verified non-blocking): unused `TypeAdapter`/`TouchPage` imports;
  `.isascii()` guard alongside `isdigit()` in `verify_session`;
  `finally: hub.disconnect(...)` in `ws_endpoint`; `Field(ge=1, le=3)` on
  `CreateOp.heading`; assert close code 4401 in the WS auth test.
- **Carried forward:** plan 5 — make the ops broadcast non-blocking
  (`asyncio.wait_for` per send or `create_task`) before live two-client
  editing; plan 6 — asset upload size cap + mime allowlist or
  `Content-Disposition`/`nosniff` hardening at deployment.
