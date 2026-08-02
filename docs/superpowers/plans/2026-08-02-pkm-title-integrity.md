# PKM Title Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add audit-first title migration tooling, atomically activate boundary-space canonicalization, normalize reads, and broadcast authoritative stored titles without touching production.

**Architecture:** `pkm.title_migration` and `pkm.rename` contain deterministic planning and simultaneous text rewriting. Database inventory/apply, routes, CLI, sync metadata, importer publication, and replica persistence remain imperative shells. Apply re-audits under `BEGIN IMMEDIATE`, migrates and activates in one transaction, rotates replica generation, then nudges clients.

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2, SQLite/FTS5, pytest, TypeScript, sqlite-wasm, Vitest, pnpm, generated OpenAPI types.

## Global Constraints

- Never read, copy, audit, or mutate the production PKM database.
- Never use production port `8974`; isolated verification uses `127.0.0.1:18974` and a temporary CLI config.
- Plain-space canonicalization removes boundary U+0020 only and remains case-sensitive.
- Control-whitespace normalization remains always active.
- Legacy databases default inactive; importer-built databases activate before publication.
- Audit is side-effect free; apply requires the exact SHA-256 audit digest.
- All migration effects, activation, and generation rotation share one transaction.
- All-space titles block apply; no empty or `Untitled` destination is invented.
- New runtime files declare their FCIS pattern.
- Regenerate `web/src/api/openapi.json` and `web/src/api/types.d.ts` after contract changes.
- Update beans with code, and do not mark a bean complete while it has unchecked tasks.

---

### Task 1: Canonical title primitive and durable activation metadata

**Files:**
- Modify: `server/src/pkm/refs.py`
- Modify: `server/src/pkm/schema.py`
- Create: `server/src/pkm/server/sync_meta.py`
- Test: `server/tests/test_refs.py`
- Test: `server/tests/test_schema.py`
- Test: `server/tests/test_schema_migrations.py`

**Interfaces:**
- Produces:
  ```python
  def canonicalize_title(title: str, *, plain_space: bool) -> str: ...
  def plain_space_title_canonicalization_active(db: sqlite3.Connection) -> bool: ...
  def set_plain_space_title_canonicalization(db: sqlite3.Connection, active: bool) -> None: ...
  def database_generation(db: sqlite3.Connection) -> str: ...
  def rotate_database_generation(db: sqlite3.Connection) -> str: ...
  ```

- [ ] **Step 1: Mark `pkm-2ilw`, `pkm-xo6w`, and `pkm-8kw2` in progress**

  ```bash
  beans update --json pkm-2ilw -s in-progress
  beans update --json pkm-xo6w -s in-progress
  beans update --json pkm-8kw2 -s in-progress
  ```

- [ ] **Step 2: Write canonicalization RED tests**

  ```python
  assert canonicalize_title("A\t B", plain_space=False) == "A B"
  assert canonicalize_title(" A ", plain_space=False) == " A "
  assert canonicalize_title(" A ", plain_space=True) == "A"
  assert canonicalize_title("\u00a0A\u00a0", plain_space=True) == "\u00a0A\u00a0"
  assert canonicalize_title("  ", plain_space=True) == ""
  ```

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_refs.py -k canonicalize_title`  
  Expected: import failure because `canonicalize_title` does not exist.

- [ ] **Step 3: Implement the pure primitive**

  ```python
  def canonicalize_title(title: str, *, plain_space: bool) -> str:
      normalized = normalize_title(title)
      return normalized.strip(" ") if plain_space else normalized
  ```

  Run the Step 2 command. Expected: PASS.

- [ ] **Step 4: Write activation metadata RED tests**

  Assert fresh and upgraded databases contain key `plain_space_title_canonicalization` with value `"0"`, replaying DDL preserves `"1"`, setters round-trip, and rotating generation changes only generation.

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_schema.py tests/test_schema_migrations.py -k 'plain_space or generation'`  
  Expected: missing row/module failures.

- [ ] **Step 5: Implement replay-safe metadata**

  Add to server DDL:
  ```sql
  INSERT OR IGNORE INTO sync_meta(key, value)
  VALUES ('plain_space_title_canonicalization', '0');
  ```

  Add `server/sync_meta.py` with `# pattern: Imperative Shell`, one-row reads/upserts, and generation rotation using `lower(hex(randomblob(16)))`.

- [ ] **Step 6: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_refs.py tests/test_schema.py tests/test_schema_migrations.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  git add server/src/pkm/refs.py server/src/pkm/schema.py server/src/pkm/server/sync_meta.py server/tests/test_refs.py server/tests/test_schema.py server/tests/test_schema_migrations.py .beans/pkm-2ilw--canonicalize-existing-space-padded-page-titles-dat.md .beans/pkm-xo6w--normalize-titles-on-client-read-paths-getrefs-404.md .beans/pkm-8kw2--clientserver-parity-remaining-depth-100-caps-and-b.md
  git commit -m "feat(pkm-2ilw): add gated title canonicalization metadata"
  ```

### Task 2: Deterministic migration planner and simultaneous reference rewriting

**Files:**
- Create: `server/src/pkm/title_migration.py`
- Modify: `server/src/pkm/rename.py`
- Create: `server/tests/test_title_migration_core.py`
- Modify: `server/tests/test_rename.py`

**Interfaces:**
- Produces immutable `InventoryPage`, `InventoryBlock`, `InventoryRef`, `InventorySidebar`, `TitleMigrationInventory`, `TitleMigrationGroup`, and `TitleMigrationPlan` dataclasses.
- Produces:
  ```python
  def build_title_migration_plan(inventory: TitleMigrationInventory) -> TitleMigrationPlan: ...
  def rewrite_title_refs_map(text: str, replacements: Mapping[str, str]) -> str: ...
  ```
- `TitleMigrationPlan` contains `active`, sorted `groups`, sorted all-space `blockers`, complete `replacements`, and a 64-character `digest`.

- [ ] **Step 1: Write planner RED tests**

  Seed unordered pages containing exact `Acme`, padded ` Acme`/`Acme `, two padded `Beta` variants without a clean twin, all-space U+0020, and NBSP-padded `Gamma`. Assert clean twin preference, otherwise lowest page ID, ascending source order, all-space blocker, case sensitivity, and NBSP preservation.

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_title_migration_core.py`  
  Expected: missing module.

- [ ] **Step 2: Implement grouping and survivor selection**

  ```python
  padded = page.title != page.title.strip(" ")
  canonical = page.title.strip(" ")
  clean_twin = next((p for p in pages if p.title == canonical), None)
  survivor = clean_twin or min(group_pages, key=lambda p: p.page_id)
  sources = tuple(sorted((p for p in group_pages if p != survivor), key=lambda p: p.page_id))
  ```

- [ ] **Step 3: Write digest RED tests**

  Assert tuple ordering does not change digest, but changing any affected page, block text/order/parent, ref row, sidebar row, count, or activation bit does. Digest input is canonical JSON with `version=1`, sorted collections, `sort_keys=True`, and compact separators.

- [ ] **Step 4: Implement canonical digesting**

  ```python
  encoded = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
  digest = hashlib.sha256(encoded).hexdigest()
  ```

- [ ] **Step 5: Write simultaneous rewrite RED tests**

  ```python
  assert rewrite_title_refs_map(
      "[[ Acme]] and [[Acme ]] plus #Legacy",
      {" Acme": "Acme", "Acme ": "Acme", "Legacy": "New Name"},
  ) == "[[Acme]] and [[Acme]] plus #[[New Name]]"
  ```

  Also pin code-span/fence protection, attribute rewriting, unrelated casing, and mapping-order independence.

- [ ] **Step 6: Implement one-pass rewrite and preserve the old wrapper**

  Scan original text once, collect original spans, resolve each captured title through the complete map, and splice right-to-left. Keep:
  ```python
  def rewrite_title_refs(text: str, old_title: str, new_title: str) -> str:
      return rewrite_title_refs_map(text, {old_title: new_title})
  ```

- [ ] **Step 7: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_title_migration_core.py tests/test_rename.py tests/test_refs.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  git add server/src/pkm/title_migration.py server/src/pkm/rename.py server/tests/test_title_migration_core.py server/tests/test_rename.py
  git commit -m "feat(pkm-2ilw): plan title migration deterministically"
  ```

### Task 3: Database inventory and phased atomic apply

**Files:**
- Create: `server/src/pkm/server/title_migration.py`
- Modify: `server/src/pkm/server/store.py`
- Create: `server/tests/test_title_migration.py`
- Modify: `server/tests/test_rename_endpoint.py`

**Interfaces:**
- Produces `TitleMigrationOutcome`, `StaleTitleMigration`, `BlockedTitleMigration`, and `AlreadyActiveTitleMigration`.
- Produces:
  ```python
  def _inventory_title_migration(db: sqlite3.Connection) -> TitleMigrationInventory: ...
  def audit_title_migration(db: sqlite3.Connection) -> TitleMigrationPlan: ...
  def apply_title_migration(db: sqlite3.Connection, expected_digest: str, now_ms: int) -> TitleMigrationOutcome: ...
  ```
- `_inventory_title_migration()` only gathers rows in the caller's current transaction. Public audit owns a read transaction; apply owns `BEGIN IMMEDIATE` and calls the private gatherer without nested transaction control.
- Store primitives:
  ```python
  def retitle_page_without_rewrite(db, page_id, old_title, new_title, now_ms) -> None: ...
  def append_page_without_rewrite(db, source_id, target_id, old_title, new_title, now_ms) -> int: ...
  def rewrite_snapshotted_blocks(db, snapshots: Sequence[tuple[str, str]], replacements: Mapping[str, str], now_ms: int) -> int: ...
  ```

- [ ] **Step 1: Write side-effect-free audit RED test**

  Seed clean/padded twins, descendants, multi-source inbound text, refs, and sidebar rows. Assert exact counts, survivor IDs, merge order, digest, unchanged rows, unchanged generation, and inactive metadata.

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_title_migration.py -k audit`  
  Expected: missing server module.

- [ ] **Step 2: Implement inventory on the injected connection**

  `_inventory_title_migration(db)` gathers padded pages, clean twins, affected/survivor blocks, inbound block snapshots, all refs for snapshotted blocks, and affected sidebar rows without beginning, committing, or rolling back. `audit_title_migration(db)` executes `BEGIN`, calls the gatherer and pure planner, then rolls back its own read transaction in `finally`; it refuses to run if `db.in_transaction` was already true so it cannot terminate a caller-owned transaction.

- [ ] **Step 3: Write store-composition RED tests**

  Test the three lower-level helpers while retaining existing `rename_page_rows()` and `merge_page_rows()` signatures and behavior.

- [ ] **Step 4: Extract phased store primitives**

  `retitle_page_without_rewrite` updates page/sidebar; `append_page_without_rewrite` appends source top-level blocks in stable order, reparents descendants by page ID, deletes source, reconciles sidebar; `rewrite_snapshotted_blocks` computes final text once, replaces refs, and indexes only final text. Compose current rename/merge helpers from them.

- [ ] **Step 5: Write full apply RED tests**

  Assert stable merged block order, preserved UIDs/subtrees, one-pass multi-source rewrite, deduplicated refs, sidebar/FTS correctness, activation, and generation rotation. Add stale digest, all-space blocker, already-active, injected rewrite failure, and SQLite abort-trigger rollback cases.

- [ ] **Step 6: Implement atomic apply**

  Execute exactly:
  ```text
  BEGIN IMMEDIATE
  call _inventory_title_migration and build a fresh plan; compare digest
  reject active or blockers
  snapshot every distinct inbound block
  build complete source-title mapping
  retitle padded survivor where no clean twin exists
  append/delete non-survivors in ascending page-ID order
  rewrite every snapshot against the complete map
  set activation=1 and rotate generation
  COMMIT; rollback on every exception
  ```

- [ ] **Step 7: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_title_migration.py tests/test_rename_endpoint.py tests/test_blank_titles.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  git add server/src/pkm/server/title_migration.py server/src/pkm/server/store.py server/tests/test_title_migration.py server/tests/test_rename_endpoint.py
  git commit -m "feat(pkm-2ilw): apply title migration atomically"
  ```

### Task 4: Authenticated migration API and generated contracts

**Files:**
- Modify: `server/src/pkm/contracts/responses.py`
- Create: `server/src/pkm/server/routes_migrations.py`
- Modify: `server/src/pkm/server/app.py`
- Create: `server/tests/test_title_migration_endpoint.py`
- Modify: `server/tests/test_journal_advancing_contract.py`
- Regenerate: `web/src/api/openapi.json`
- Regenerate: `web/src/api/types.d.ts`

**Interfaces:**
- `GET /api/migrations/title-canonicalization` returns audit payload.
- `POST /api/migrations/title-canonicalization` accepts `{"audit_digest": "64 lowercase hex characters"}` and returns applied counts/generation.
- Both use existing session authentication.

- [ ] **Step 1: Write authenticated audit/apply RED tests**

  Pin unauthenticated refusal, truthful audit payload and blockers, side-effect-free GET, successful POST, malformed digest 422, stale/blocked/active 409 responses, generation change, activation, and one post-commit sequence nudge.

  Run: `cd server && uv run pytest -q -o addopts='' tests/test_title_migration_endpoint.py tests/test_journal_advancing_contract.py -k 'title_canonicalization or migration'`  
  Expected: 404.

- [ ] **Step 2: Add concrete Pydantic models**

  Add required page/group/audit/apply request/apply response fields from the approved spec; digest uses `Field(pattern=r"^[0-9a-f]{64}$")`.

- [ ] **Step 3: Implement and register routes**

  Translate `StaleTitleMigration`, `BlockedTitleMigration`, and `AlreadyActiveTitleMigration` to 409. Apply calls the committed domain operation, then the existing post-commit nudge helper; the route never commits separately.

- [ ] **Step 4: Verify OpenAPI drift, regenerate, and retest**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_openapi_sync.py
  uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
  cd ../web
  pnpm gen-types
  cd ../server
  uv run pytest -q -o addopts='' tests/test_openapi_sync.py tests/test_title_migration_endpoint.py tests/test_journal_advancing_contract.py
  ```

  First OpenAPI run must fail before regeneration; final run passes.

- [ ] **Step 5: Commit**

  ```bash
  cd ..
  git add server/src/pkm/contracts/responses.py server/src/pkm/server/routes_migrations.py server/src/pkm/server/app.py server/tests/test_title_migration_endpoint.py server/tests/test_journal_advancing_contract.py web/src/api/openapi.json web/src/api/types.d.ts
  git commit -m "feat(pkm-2ilw): expose authenticated title migration API"
  ```

### Task 5: Typed client and audit-first CLI

**Files:**
- Modify: `server/src/pkm/client/api.py`
- Modify: `server/src/pkm/cli/render.py`
- Modify: `server/src/pkm/cli/main.py`
- Test: `server/tests/test_client_api.py`
- Test: `server/tests/test_cli_render.py`
- Test: `server/tests/test_cli_main_read.py`
- Test: `server/tests/test_cli_help.py`

**Interfaces:**
- Produces client methods `audit_title_migration()` and `apply_title_migration(audit_digest)`.
- CLI forms:
  ```text
  pkm migrate-titles
  pkm migrate-titles --json
  pkm migrate-titles --apply DIGEST
  pkm migrate-titles --apply DIGEST --json
  ```

- [ ] **Step 1: Write client/renderer/CLI RED tests**

  Pin exact paths/body, response validation, complete human audit/apply rendering, empty audit copy, default audit, required apply value, JSON output, 409 exit behavior, and self-sufficient help warning that no startup migration occurs.

- [ ] **Step 2: Implement typed methods and pure renderers**

  Validate transport payloads through existing client request helpers. Render digest, state, source/survivor IDs and counts, merge order, applied counts, and generation.

- [ ] **Step 3: Register `migrate-titles`**

  Audit by default; `--apply` always takes a digest; use existing `_emit()` for JSON/human output. No bypass or automatic apply exists.

- [ ] **Step 4: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_client_api.py tests/test_cli_render.py tests/test_cli_main_read.py tests/test_cli_help.py tests/test_client_contracts.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  git add server/src/pkm/client/api.py server/src/pkm/cli/render.py server/src/pkm/cli/main.py server/tests/test_client_api.py server/tests/test_cli_render.py server/tests/test_cli_main_read.py server/tests/test_cli_help.py
  git commit -m "feat(pkm-2ilw): add audit-first title migration CLI"
  ```

### Task 6: Server/offline activation gating and sync propagation

**Files:**
- Modify: `server/src/pkm/server/store.py`
- Modify: `server/src/pkm/server/routes_pages.py`
- Modify: `server/src/pkm/server/routes_sync.py`
- Modify: `server/src/pkm/contracts/responses.py`
- Test: `server/tests/test_blank_titles.py`
- Test: `server/tests/test_newline_titles.py`
- Test: `server/tests/test_sync_endpoints.py`
- Create: `web/src/replica/titles.ts`
- Create: `web/src/replica/titles.test.ts`
- Modify: `web/src/replica/apply.ts`, `meta.ts`, `localOps.ts`, `localApi/pages.ts`, `localApi/router.ts`
- Test corresponding web test files
- Regenerate OpenAPI/type files

**Interfaces:**
- Both `ChangesPayload` and `SnapshotPayload` require `plain_space_title_canonicalization: bool`.
- Browser `sync_client_meta` stores the same key as `"0"`/`"1"`.
- Produces:
  ```typescript
  export function canonicalizeTitle(title: string, plainSpaceActive: boolean): string;
  ```

- [ ] **Step 1: Write server gating/sync RED tests**

  Before activation, padded titles remain exact; after isolated API apply, create/create_page/move/POST/rename targets converge on trimmed U+0020 while all-space policies remain unchanged. Snapshot, changes, and reset payloads expose false before apply and true after the same generation rotation.

- [ ] **Step 2: Gate server boundaries and populate sync responses**

  `get_or_create_page()` and route preprocessing call `canonicalize_title(..., plain_space=plain_space_title_canonicalization_active(db))`. Keep `fetch_page()` exact. Use shared generation/activation accessors in every sync response.

- [ ] **Step 3: Write and implement replica title core RED/GREEN**

  Test control whitespace in both modes, U+0020 only when active, and NBSP preservation. Implement using existing ref-title normalization plus boundary-space removal when active.

- [ ] **Step 4: Write metadata/pending replay RED tests**

  Assert snapshot and accepted changes persist activation before pending optimistic ops replay; generation mismatch does not partially mutate metadata.

- [ ] **Step 5: Write local creation/read RED tests and gate boundaries**

  Pin inactive exact padding, active canonical creation/lookup, control normalization, canonical POST response/enqueued op, page/unlinked lookup, and optimistic create/create_page/cross-page move page IDs. Read activation from `sync_client_meta` in local shells.

- [ ] **Step 6: Regenerate, verify, and commit**

  ```bash
  cd server
  uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
  cd ../web
  pnpm gen-types
  pnpm vitest run src/replica/titles.test.ts src/replica/apply.test.ts src/replica/localOps.test.ts src/replica/localApi/router.test.ts
  pnpm typecheck
  cd ../server
  uv run pytest -q -o addopts='' tests/test_openapi_sync.py tests/test_sync_endpoints.py tests/test_blank_titles.py tests/test_newline_titles.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  git add server/src/pkm/server/store.py server/src/pkm/server/routes_pages.py server/src/pkm/server/routes_sync.py server/src/pkm/contracts/responses.py server/tests/test_blank_titles.py server/tests/test_newline_titles.py server/tests/test_sync_endpoints.py web/src/replica/titles.ts web/src/replica/titles.test.ts web/src/replica/apply.ts web/src/replica/apply.test.ts web/src/replica/meta.ts web/src/replica/localOps.ts web/src/replica/localOps.test.ts web/src/replica/localApi/pages.ts web/src/replica/localApi/router.ts web/src/replica/localApi/router.test.ts web/src/api/openapi.json web/src/api/types.d.ts
  git commit -m "feat(pkm-2ilw): gate online and offline canonical titles"
  ```

### Task 7: Normalize read paths and truthful backlink metadata

**Files:**
- Modify: `server/src/pkm/client/api.py`
- Modify: `server/src/pkm/server/routes_pages.py`
- Modify: `server/src/pkm/server/routes_export.py`
- Test: client/page/export/CLI/MCP tests

- [ ] **Step 1: Write control-whitespace read RED tests**

  Create through `Ctrl\tTitle`; assert Python client `get_page`/`get_backlinks`, direct routable-control GETs, CLI `get`/`refs`, and MCP page/backlinks all resolve stored `Ctrl Title`. Pin inactive padded exact reads and active padded canonical reads.

- [ ] **Step 2: Normalize client and route choke points**

  Client methods always call `normalize_title`. Page, unlinked, and single-page export routes use activation-aware `canonicalize_title` before exact fetch/query construction.

- [ ] **Step 3: Write backlink limit RED tests and preserve observed metadata**

  Assert aggregate `limit` remains the first server response’s clamped page size, not `len(groups)`. Store first observed limit while fetching pages and return it in the aggregate response.

- [ ] **Step 4: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_client_api.py tests/test_page_endpoint.py tests/test_export_routes.py tests/test_cli_main_read.py tests/test_mcp_server.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  git add server/src/pkm/client/api.py server/src/pkm/server/routes_pages.py server/src/pkm/server/routes_export.py server/tests/test_client_api.py server/tests/test_page_endpoint.py server/tests/test_export_routes.py server/tests/test_cli_main_read.py server/tests/test_mcp_server.py
  git commit -m "fix(pkm-xo6w): normalize reads and preserve backlink metadata"
  ```

### Task 8: Broadcast authoritative stored page titles

**Files:**
- Modify: `server/src/pkm/server/ops_apply.py`
- Test: `server/tests/test_ops_apply.py`, `test_ops_endpoint.py`, blank/newline-title tests

- [ ] **Step 1: Write broadcast RED tests**

  Through WebSocket, cover control whitespace, blank fallback, active padding, explicit and parent-based cross-page move, create_page, and same-page move. Expected page title is always the stored page row title for operations with an applied page.

- [ ] **Step 2: Resolve applied page ID after mutation**

  For create/create_page use operation context page ID; for move read the moved block after apply. Fetch the page row’s title and place it in broadcast payload. Remove partial blank/parent special cases; do not normalize again or add a rejection.

- [ ] **Step 3: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_ops_apply.py tests/test_ops_endpoint.py tests/test_blank_titles.py tests/test_newline_titles.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  git add server/src/pkm/server/ops_apply.py server/tests/test_ops_apply.py server/tests/test_ops_endpoint.py server/tests/test_blank_titles.py server/tests/test_newline_titles.py .beans/pkm-8kw2--clientserver-parity-remaining-depth-100-caps-and-b.md
  git commit -m "fix(pkm-8kw2): broadcast authoritative page titles"
  ```

### Task 9: Canonicalize imported databases before publication

**Files:**
- Modify: `server/src/pkm/importer/run.py`
- Test: `server/tests/test_importer_e2e.py`

**Ordering constraint:** Complete this task before the importer-follow-up plan modifies `run.py`; the importer lane must rebase from this commit.

- [ ] **Step 1: Write padded-import and all-space refusal RED tests**

  Assert clean/padded variants merge with stable blocks/refs and activation `"1"`; ordinary imports also start active; all-space import returns 2, preserves existing published files, and does not publish a replacement.

- [ ] **Step 2: Reuse audit/apply on the temporary database**

  After rows/assets are inserted and before any publication, audit then apply with the returned digest. Catch only `BlockedTitleMigration`, report a friendly refusal, close/unlink the temporary database, and return 2.

- [ ] **Step 3: Verify and commit**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_importer_e2e.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  git add server/src/pkm/importer/run.py server/tests/test_importer_e2e.py
  git commit -m "feat(pkm-2ilw): publish imports with canonical titles active"
  ```

### Task 10: Documentation, beans, isolated verification, and lane gates

**Files:**
- Modify: `README.md`, `.claude/skills/pkm/SKILL.md`, `docs/architecture/backend.md`, `docs/architecture/sync-and-offline.md`
- Modify: title-related bean files

- [ ] **Step 1: Invoke `superpowers:writing-skills` before editing the PKM skill**

  Follow that skill’s test-first documentation workflow.

- [ ] **Step 2: Document contracts**

  Document audit/apply commands, no startup migration, explicit later production action, API rows, digest/all-space/transaction behavior, sync field and generation rotation, online/offline gating, importer reuse, control-whitespace reads, truthful backlink limit, and authoritative broadcasts.

- [ ] **Step 3: Update bean checklists and summaries truthfully**

  `pkm-2ilw` and `pkm-xo6w` summaries explicitly state production migration was not executed. Check only the broadcast item in `pkm-8kw2`; leave its other lane items for the parity plan.

- [ ] **Step 4: Run focused and generated-contract gates**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_title_migration_core.py tests/test_title_migration.py tests/test_title_migration_endpoint.py tests/test_client_api.py tests/test_cli_main_read.py tests/test_mcp_server.py tests/test_sync_endpoints.py tests/test_importer_e2e.py tests/test_ops_apply.py tests/test_blank_titles.py tests/test_newline_titles.py tests/test_openapi_sync.py
  uv run pyrefly check
  uv run ruff check
  cd ../web
  pnpm vitest run src/replica/titles.test.ts src/replica/apply.test.ts src/replica/localOps.test.ts src/replica/localApi/router.test.ts
  pnpm typecheck
  ```

- [ ] **Step 5: Verify CLI only against isolated port 18974**

  Create a temporary data directory and CLI config, seed padded pages in that isolated database, start the worktree server on `127.0.0.1:18974`, and exercise: stable repeated audit; stale digest refusal after isolated mutation; fresh audit/apply; activation; generation change; canonical read/create. Stop the process and delete the temporary directory. Abort any command whose URL is not exactly `http://127.0.0.1:18974`.

- [ ] **Step 6: Complete eligible beans and commit docs/status**

  ```bash
  git add README.md .claude/skills/pkm/SKILL.md docs/architecture/backend.md docs/architecture/sync-and-offline.md .beans/pkm-2ilw--canonicalize-existing-space-padded-page-titles-dat.md .beans/pkm-xo6w--normalize-titles-on-client-read-paths-getrefs-404.md .beans/pkm-8kw2--clientserver-parity-remaining-depth-100-caps-and-b.md
  git commit -m "docs(pkm-mk87): document title integrity activation"
  ```
