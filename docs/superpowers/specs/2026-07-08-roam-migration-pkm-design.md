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

## Open items

- User to provide: EDN export + linked-files download (drop in `sample-data/`).
- Importer report will decide whether `((block-ref))` rendering is needed in v1.
