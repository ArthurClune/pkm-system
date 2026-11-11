# W13 Server Routes and Domain Cleanups: Task-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Implementers work under the epic's implementer brief; this plan does not restate it.

**Goal:** Give each server-side rule in the HTTP surface and its neighbours one owner: one parser per branded path parameter, one clock the tests replace, one MIME policy table, one config default, one title-migration model, one sidebar ordering module beside its route, one read-tool list, one pluraliser, one parity-corpus generator, and one comment-lint rule that catches `Task N` pointers. No status, schema, digest, fixture byte or query changes, except the two OpenAPI diffs named below.

**Source:** `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md` § W13 and its Global Constraints; evidence in the local review report `02-server-routes.md` (findings 1, 2, 4 to 12). Branch `refactor/server-routes-cleanups`, read at `main` @ `9dc822c7`, with W2, W5, W6, W12 and W17 merged.

**Architecture:** Behaviour pins first, then the change, per task. Every task that touches a route regenerates the OpenAPI artifacts and states the expected diff. Moves are pure in their own commit. Tasks are grouped into lanes that touch disjoint files; the docs task runs last.

**Tech stack:** Python 3.12, FastAPI, pydantic (strict models), pytest + Hypothesis, pyrefly, ruff; comment edits in `web/` and one TypeScript tooling file.

## Global Constraints

- Every task: its own worktree off `refactor/server-routes-cleanups`, merged back with `git merge --no-ff`. Run `pwd` and `git branch --show-current` before the first write.
- After every commit: from `server/`, `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check` ("server gates"). A task that touches `web/` also runs the web static gates: `pnpm typecheck && pnpm lint && pnpm lint:comments && pnpm check:fcis && pnpm test:coverage && pnpm build`. Playwright is the orchestrator's (`pnpm verify`, Final gates).
- A task that changes a route, a query or path param, a response model or a route function's docstring runs `uv run python -m pkm.regen` from `server/` (the worktree needs `web/node_modules`, because the run includes `pnpm gen-types`) and commits what it rewrites. It then checks `git status --short` against the expected diff the task states. Any other diff is a stop-and-report.
- No status, digest, fixture byte or SQL text may change, except where a task names it.
- Comments: no bean ids, line numbers or plan pointers; at most 80 columns; none of the words AGENTS.md § Writing guidance bans. Each new runtime file declares its FCIS pattern.
- Docs under `docs/architecture/` go through the `architecture-docs` skill (Tasks 13 and 17 only).
- Public repo: describe security mechanisms only, never where secrets sit.
- Ports: never 8974.

## Review Focus

1. A malformed path parameter keeps its status and detail: `422 malformed uid: '<x>'` for a block uid, `404 asset not found` for a sha256, `404 not found` for a GoodLinks id, and 401 first for an anonymous request. Pinned by Task 1's status table, committed before the change.
2. The title-migration digest. A plan audited before the deploy must still apply after it, so the digest of a given inventory must not move. Pinned by the two literal digests in `test_title_migration.py` and `test_title_migration_endpoint.py`, which must pass unmodified through Tasks 6 and 7.
3. Config defaults for key files. A key file named nowhere in `config.json` must still resolve beside the data directory, not against the process's working directory. Pinned by `test_config.py`'s `*_default` tests, unmodified through Task 14.
4. The SVG row. SVG uploads, downloads with `nosniff`, and is never described. Pinned by Task 3's derived-set test.
5. The parity fixtures stay byte-identical through Task 15, or the web's parity tests compare against a different corpus.

---

## Where the code disagrees with W13

The code wins; the tasks are written to it.

| W13 says | The code says | Consequence |
|---|---|---|
| `path_uid(uid: str) -> BlockUid` | A `str` parameter loses the `x-brand` marker: `contracts/brands.py` adds it only for the NewType, so `openapi.json` and the generated `Brands.*` path types would change. A brand-named `str` parameter also needs `# brand: untrusted`, which `OPT_OUT_FILES` allows only in `routes_*.py`. | The dependency takes `segment: Annotated[str, Path(alias="uid", json_schema_extra={"x-brand": "BlockUid"})]`. A probe (FastAPI in this venv) printed a parameter schema byte-identical to today's, with no brand-named parameter, so no opt-out and no registry edit. |
| "OpenAPI is unchanged" | FastAPI lists a route's own path params before those its dependencies declare. The probe moved `filename` ahead of `sha256` for `GET /assets/{sha256}/{filename}`. | Task 1's expected diff is that swap in `openapi.json` and in `types.d.ts`, and nothing else. See Question 1. |
| "Statuses are unchanged" | A dependency raises before FastAPI validates the route's own query params. `DELETE /api/assets/<bad sha>?if_unreferenced=<not a bool>` answers 422 today and would answer 404. | Requests with a single fault keep their status; Task 1 pins them. The double-fault change is accepted and named in Traps. |
| Rename `pkm/title_migration.py` | Its path is also in `brand_registry` (`Sha256Hex` mint sites), `web/tooling/brandRegistry.gen.json`, `refs.target_canonical_title`'s docstring and backend.md. The shell `server/title_migration.py` keeps its name. | Task 6 updates each and regenerates the registry JSON. |
| The core builds the `contracts/responses.py` models | `StrictModel` is `strict=True`: a `list` field refuses a tuple, and a model takes keyword arguments only. The core's group holds `InventoryPage`s; the model's holds `TitleMigrationPage`s. The response model spells the reason `Literal` again. | Task 7 builds lists, by keyword, converting survivor and sources when it builds the group. `TitleMigrationBlockerReason` moves to `responses.py`. The digest reads attribute names only, which do not change. |
| (not in W13) | `routes_migrations` also copies `TitleMigrationOutcome` into `TitleMigrationApplyResponse` field by field; the review counted it with `_audit_payload`. | Task 7 returns the response model from `apply_title_migration`. |
| `load_config` passes only the keys present | The three key-file defaults are relative paths that `load_config` joins to `config.json`'s directory. The dataclass default alone would resolve against the process's working directory. | Task 14 reads each key file's default from the `Config` field and still joins it to the base. |
| One MIME table; `_DOCUMENT_MIME` derives from it | `mime_category` and its SQL twin `type_where` classify any stored mime by prefix (`image/*`, `text/*`), not only allowlisted ones. `type_where`'s `IN` params come from `_DOCUMENT_MIME`, in order. A fifth copy sits in `web/src/views/filesCore.ts` (`DOCUMENT_MIME`). | Task 3 keeps the prefix rules and adds a test that every row agrees with them. `_DOCUMENT_MIME` stays a tuple in today's order. The web copy is Question 4. |
| (not in W13) | `describe/core.enabled_reason` points at `server/_default_describe_service`, as config's comment does. The function is `server/app._default_describe_service`. | Tasks 3 and 14 fix one each. |
| Move `next_order_idx`, `reorder_is_valid` beside `routes_sidebar.py` | `routes_sidebar.py` is a Shell; the helpers are pure. `brand_registry` lists `importer/sidebar_rows.py` as the `SidebarOrderIdx` mint site. | Task 8: `server/sidebar_core.py` (Functional Core), a registry edit and a regen. |
| `LoginThrottle` moves to `server/throttle.py` | `test_auth.py` patches `pkm.server.auth.MAX_TRACKED_SOURCES` in two places; `app.py` imports the class; `throttle_core`'s docstring names `auth.LoginThrottle`. | Task 12 moves the class with its constants and clock, and the patch targets follow. |
| `assistant.policy` imports `mcp.tools.READ_TOOL_NAMES` | `policy.py` is a Functional Core importing only `contracts.responses`. `mcp/tools.py` is a Shell that imports `pkm.client.api`. The import would point a Core at a Shell and load the HTTP client into the server process. | Task 9 puts the tuple in a constants module, `pkm/mcp/names.py`, which both import. See Question 2. |
| One `parity_corpus(pieces, seed, count, length)` | The generators differ. `title_parity_dump` joins one to seven pieces, excluding nothing. `refs_parity_dump` joins two to nine and excludes its hand cases. `text_limits_parity_dump` composes soup, openers and closers, and drops the empty text. | Task 15: `parity_corpus(draw, *, seed, count, exclude=())`, `piece_soup(pieces, least, most)` and one `shape_tally(texts, shapes)`. Each dump keeps its own draw. |
| Comment lint: add a `Task N` / `Fix A` pattern | `_ORPHAN_POINTER` compiles with `re.IGNORECASE`, so an added `Fix [A-Z]` would flag "fix a race". | Task 16 adds a separate, case-sensitive pattern under the existing rule name `orphan-pointer`. |
| Rationale: `SECURITY.md` and `deploy/README.md` link to backend.md | `deploy/README.md` already links to backend.md § Login throttle. W18's own bullet strips from backend.md every sentence `SECURITY.md` also carries. | Task 13 trims the code and makes sure backend.md holds each why it removes. `SECURITY.md` is left alone: see Question 3. |
| Module docstrings | Confirmed for `routes_pages` ("Task 5"), `routes_search` ("Task 8"), `routes_assets`, `contracts/__init__` (it lists five of nine modules, plus history) and `app.create_app`. `local_docs.py` (review finding 9) is already fixed. `server/openapi_dump.py`'s docstring narrates history too ("now runs"). | Task 5 does the module docstrings, `openapi_dump.py` and `deploy/README.md`. Task 12 fixes `create_app`'s comment, since that task already edits `app.py`. |
| `importer/preflight.py`: four identity re-mints | Confirmed: the `as_raw_title` calls on a `Page.title` and on `RECOVERY_PAGE_TITLE`, both already `RawTitle`. A fifth call, wrapping `ImportTextLimitError`'s title, mints from a `str` and stays. | Task 10 drops the four. |
| One pluraliser | Confirmed: `render._count_label` and `server/title_migration._counted`. Inline `x if n == 1 else y` choices in `render.py` and `export/resolve.py` are not functions. | Task 11 merges the two functions and leaves the inline choices. |
| (not in W13) | `assistant/routes.py` declares `conversation_id: ConversationId` with no check. It is a dict key, and no parser exists, since only the service mints the id. W14 owns the file. | Left alone. |
| What W12 and W17 changed | W12 put `read_txn` into `server/title_migration.py`, and nothing else W13 lists. W17 added `pkm.regen` and moved the web tooling to TypeScript (`web/tooling/perf/check.ts`). | Tasks build on both. |

## Measured

- **OpenAPI probe** (scratch FastAPI app in this venv, not committed). `uid: BlockUid` as a plain path param, `Depends` on a function taking `uid: BlockUid`, and `Depends` on a function taking `segment: Annotated[str, Path(alias="uid", json_schema_extra={"x-brand": "BlockUid"})]` all print `{"name": "uid", "in": "path", "required": true, "schema": {"type": "string", "x-brand": "BlockUid", "title": "Uid"}}`. With `sha256` from a dependency and `filename` on the route, the parameter list reads `filename`, then `sha256`, whichever order the route declares them in.
- **Comment-lint hit list.** Scratch scan of every comment span the sweep reads (`is_scanned`, `_spans`), with candidate patterns. `\bTask \d+` has eight hits; `\bFix [A-Z]\b`, four; `\b[Ff]inding \d+\b`, four. `\bStep \d+` hits only a skill template's own numbered steps, and lowercase "step N" only docs that number their own lists, so neither joins the rule. `server/tooling/perfcheck/fixture.py` has no hit. Task 16 lists the sites.
- **Perf scenarios W13's paths reach:** `/api/block/{uid}`, `/api/block/{uid}/backlinks`, `/api/page/*` (`BLOCK_COLS`), `/api/titles` and `/api/assets/search` (`like_escape`, `type_where`), `/api/sidebar` and `/api/login`. None reaches `/api/current-work`, the migration routes or `/assets/{sha256}/{filename}`.

## Files

| File | Change | Task |
|---|---|---|
| `server/src/pkm/server/path_params.py` | new, Functional Core: `path_uid`, `path_sha256`, `path_link_id` | 1 |
| `server/src/pkm/server/clock.py` | new, Imperative Shell: `now_ms` | 2 |
| `server/src/pkm/assets_core.py` | `MimePolicy`, `MIME_POLICY` and the derived sets | 3 |
| `server/src/pkm/server/tree.py`, `fts.py` | `BLOCK_COLS`; `like_escape` | 4 |
| `server/src/pkm/title_migration_core.py` | renamed from `pkm/title_migration.py`; builds contract models | 6, 7 |
| `server/src/pkm/server/sidebar_core.py` | moved from `importer/sidebar_rows.py`, less `missing_entry_rows` | 8 |
| `server/src/pkm/mcp/names.py` | new, constants: `READ_TOOL_NAMES` | 9 |
| `server/src/pkm/server/throttle.py` | new, Imperative Shell: `LoginThrottle` and its constants | 12 |
| `server/src/pkm/parity_corpus.py` | new, Functional Core | 15 |
| `server/tooling/commentlint/core.py` | `_PLAN_POINTER` | 16 |
| `web/src/api/openapi.json`, `web/src/api/types.d.ts` | regenerated | 1, 2 |
| `web/tooling/brandRegistry.gen.json` | regenerated | 6, 8 |
| `docs/architecture/backend.md`, `files-and-assets.md` | Tasks 13 (Auth whys only) and 17 | 13, 17 |

## Tasks

### Task 1: One parsing dependency per branded path parameter

**Implementer:** opus (path-param statuses and the OpenAPI schema).

**Files:** create `server/src/pkm/server/path_params.py` and `server/tests/test_path_params.py`. Modify `routes_pages.py` (`get_block`, `get_block_backlinks`; drop the `UID_RE as _UID_RE` import), `routes_assets.py` (`delete_asset`, `get_asset`; `export_assets` keeps `parse_sha256` for its form values) and `routes_goodlinks.py` (`get_article`; `_link_payload` keeps `parse_link_id`). Regenerate `web/src/api/openapi.json` and `types.d.ts`.

**Interfaces** (`# pattern: Functional Core`):
- `_segment(name: str, brand: object) -> Any`: returns `Path(alias=name, json_schema_extra={"x-brand": getattr(brand, "__name__")})`, so the brand's name is written once.
- `path_uid(segment: Annotated[str, _segment("uid", BlockUid)]) -> BlockUid`: `parse_block_uid`, else `HTTPException(422, f"malformed uid: {segment!r}")`.
- `path_sha256(segment: Annotated[str, _segment("sha256", Sha256Hex)]) -> Sha256Hex`: `parse_sha256`, else `HTTPException(404, "asset not found")`.
- `path_link_id(segment: Annotated[str, _segment("link_id", GoodlinksId)]) -> GoodlinksId`: `parse_link_id`, else `HTTPException(404, "not found")`.
- Routes declare `uid: BlockUid = Depends(path_uid)` (and the like), as the first dependency in the signature, so the parse runs before `get_db` or `get_goodlinks`. `get_article` puts `response: Response` first, to keep Python's default-argument order. The module docstring says why the parameter is an aliased `str`: the brand marker keeps the schema, and the handler only ever sees the checked brand.

- [ ] **Pin first, own commit:** `test_path_param_statuses`, a table of (client, method, path) → (status, detail):
  - `GET /api/block/no` → 422 `malformed uid: 'no'`; `GET /api/block/zzzzzz` → 404.
  - `GET /api/block/x!/backlinks` → 422; `GET /api/block/uid_nope99/backlinks` → 404.
  - `DELETE /api/assets/not-a-sha` and `GET /assets/not-a-sha/x.png` → 404 `asset not found`.
  - `GET /api/goodlinks/not-hex` → 404 `not found`, with the gateway configured and without.
  - Each malformed request from `anon_client` → 401.

  It passes at the base. That is the point: it must pass unchanged after the change.
- [ ] **Red:** `test_branded_path_params_come_from_a_dependency`: build the app (`create_app(seeded_config)`). For each `APIRoute` whose path holds `{uid}`, `{sha256}` or `{link_id}`, assert the name is not among `route.dependant.path_params`, and that `route.dependant.dependencies` calls the matching `path_*`. It fails today on all five routes. Add unit tests for the three functions, a good and a bad value each.
- [ ] **Implement.** Handlers drop their in-body checks; their docstrings stay byte-identical (they feed OpenAPI).
- [ ] **Regen.** Expected diff, only: in `openapi.json`, the two `parameters` entries of `GET /assets/{sha256}/{filename}` swap order (`filename` first); in `types.d.ts`, the `path` object of `get_asset_assets__sha256___filename__get` lists `filename` first. Under Question 1's other answer, `get_asset` keeps its in-body parse and the expected diff is empty.
- [ ] **Done:** server gates and web static gates green. `git grep -n "_UID_RE\|parse_sha256(sha256)\|parse_link_id(link_id)" -- server/src/pkm/server` is empty. `test_block_endpoint.py`, `test_block_ref_index.py`, `test_routes_goodlinks.py`, `test_no_500_request_props.py` and `test_hostile_requests.py` pass unmodified.

### Task 2: `/api/current-work` reads an injected clock

**Implementer:** opus (the injected clock; a param leaves the API).

**Files:** create `server/src/pkm/server/clock.py`. Modify `routes_pages.get_current_work`, `server/tests/test_current_work.py` and `server/tests/test_hostile_requests.py`. Regenerate.

**Interfaces:** `clock.now_ms() -> int` (`# pattern: Imperative Shell`) returns `int(time.time() * 1000)`. Its docstring says it is a route dependency that tests replace through `app.dependency_overrides[now_ms]`. The route becomes `get_current_work(now: int = Depends(now_ms), db: Db = Depends(get_db))`.

- [ ] **Red:** `test_current_work_takes_no_query_parameters` asserts that `create_app(...).openapi()` gives `GET /api/current-work` no `parameters`. Rewrite the existing tests to set the override instead of `params={"now_ms": ...}`: the two window tests, `test_current_work_survives_the_int64_extremes`, and `test_hostile_requests.test_current_work_answers_at_int64_extremes`. Use one fixture, `fixed_now(client) -> Callable[[int], None]`, that sets the override for that test's app. The rewritten tests fail at the base: the override replaces nothing, so the real clock files every seeded page outside its window.
- [ ] **Implement.** Keep the `max(INT64_MIN, …)` clamps: an overridden clock can be any int64. Their comment says so instead of "`now` is any int64". Add no docstring to the route; one would feed OpenAPI.
- [ ] **Regen.** Expected diff, only: `openapi.json` loses the `parameters` of `GET /api/current-work`; in `types.d.ts`, that operation's `query` becomes `query?: never`.
- [ ] **Done:** server gates and web static gates green. `git grep -n "now_ms" -- web/src ':!web/src/api'` is empty, as at the base (the web never sent it).

### Task 3: One MIME policy table

**Implementer:** opus (the derivation is security policy).

**Files:** `server/src/pkm/assets_core.py`, `server/src/pkm/server/routes_assets.py`, `server/src/pkm/describe/core.py`, `server/tests/test_assets_core.py` (no test imports `ELIGIBLE_MIME`).

**Interfaces** (in `assets_core`):
- `MimePolicy(category: AssetCategory, inline: bool, describable: bool)`, a frozen dataclass.
- `MIME_POLICY: Mapping[str, MimePolicy]`, a `MappingProxyType` whose rows follow today's `ALLOWED_UPLOAD_MIME` listing order. The SVG row's comment holds the rule: it can script, so it is never inline. The HEIC and SVG rows say why they are not describable.
- Derived: `ALLOWED_UPLOAD_MIME = frozenset(MIME_POLICY)`, `INLINE_MIME`, and `DESCRIBABLE_MIME` (frozensets), and `_DOCUMENT_MIME`, a tuple of the `document` rows outside `text/*`, in table order. `mime_category` and `type_where` keep their prefix rules unchanged.
- `routes_assets` imports `ALLOWED_UPLOAD_MIME` and `INLINE_MIME`. `describe.core.describe_action` reads `DESCRIBABLE_MIME`, and `ELIGIBLE_MIME` goes.

- [ ] **Red:** `test_the_mime_sets_derive_from_one_table` compares each derived set with a literal copied from the base: `ALLOWED_UPLOAD_MIME`, `INLINE_MIME`, `ELIGIBLE_MIME` as `DESCRIBABLE_MIME`, and `_DOCUMENT_MIME` as an ordered tuple. It fails on import today. Also add `test_each_row_has_the_category_mime_category_gives`, `test_svg_uploads_but_is_never_inline_or_described`, and `test_describable_types_are_inline_images`.
- [ ] **Implement.** Delete the "Keep in step" comments, the "(spec: …)" and "(see INLINE_MIME in Task 4)" comment, and `describe/core.py`'s duplicate set. Fix `enabled_reason`'s pointer to name `server/app._default_describe_service`.
- [ ] **Done:** server gates green. `test_type_where_matches_mime_category` and the upload tests (`test_asset_upload.py`) pass unmodified. No regen diff: no route changed.

### Task 4: Route copies: block columns, LIKE escaping, the daily title

**Implementer:** sonnet.

**Files:** `server/src/pkm/server/tree.py`, `fts.py`, `routes_pages.py`, `routes_export.py`, `routes_search.py`, `routes_assets.py`, `server/src/pkm/export/writer.py`, `server/tests/test_tree.py`, and a new `server/tests/test_fts.py`.

**Interfaces:**
- `tree.BLOCK_COLS: str`, the column list `build_tree` reads, with text byte-identical to today's `_BLOCK_COLS`.
- `fts.like_escape(text: str) -> str`, the backslash, `%`, `_` escape for `LIKE ? ESCAPE '\'`. `fts.py`'s docstring widens to "untrusted text into FTS5 MATCH expressions and LIKE patterns".

- [ ] **Red:** `test_block_columns_are_spelled_once` greps `server/src` for `parent_uid, order_idx, text, heading, collapsed` and finds one hit, in `tree.py` (three today). `test_like_patterns_are_escaped_in_one_place` greps for `.replace("%", "\\%")` and finds one hit, in `fts.py` (two today). Add a `like_escape` unit test covering all three characters.
- [ ] **Implement.** Delete `routes_pages._daily_title`; its four callers call `canonical_daily_title`. `routes_export`'s comment about matching `routes_pages._BLOCK_COLS` goes.
- [ ] **Done:** server gates green; `git grep -n "_daily_title\|_BLOCK_COLS" -- server` is empty. The SQL text of every touched query is byte-identical (Traps: query text).

### Task 5: Module docstrings and one-time deploy notes

**Implementer:** sonnet.

**Files:** module docstrings of `routes_pages.py`, `routes_search.py` and `routes_assets.py`; `server/src/pkm/contracts/__init__.py`; `server/src/pkm/server/openapi_dump.py`; `deploy/README.md`.

- [ ] Each route module's docstring says what the module serves. `routes_pages`: page read, create, delete and rename; block and block-ref reads; the journal and its cleanup; current work. `routes_search`: full-text search, query, title completion, todos, changed blocks. `routes_assets`: upload, serving, search, delete, and the selected-asset zip. No plan pointers.
- [ ] `contracts/__init__.py` keeps the dependency rule (imports neither `pkm.server` nor `pkm.client`, so both sides depend on it) and drops the history and the module list; backend.md's module map holds the list.
- [ ] `openapi_dump.py`'s docstring states, in the present tense, why the throwaway config points at a writable directory.
- [ ] `deploy/README.md`: delete "An install that predates the Origin guard…" in § Updating and the "Cutover for an install that still runs under `uv run`" paragraph with its "Old `uv` entries" sentence.
- [ ] **Done:** server gates green. `uv run python -m pkm.regen` shows no diff: module docstrings do not feed OpenAPI. `PYTHONPATH=server/tooling python3 -m commentlint.run --all` from the repo root is clean.

### Task 6: Rename the title-migration core (pure move)

**Implementer:** sonnet (mechanical; one commit).

**Files:** `git mv server/src/pkm/title_migration.py server/src/pkm/title_migration_core.py`. Update imports in `server/src/pkm/server/title_migration.py` and `server/tests/test_title_migration_core.py`, the `Sha256Hex` entry and its comment in `brand_registry.py`, and the path in `refs.target_canonical_title`'s docstring. Regenerate `web/tooling/brandRegistry.gen.json`.

- [ ] **Done:** server gates green; the brand sweep is clean. Regen's only diff is the path string in `brandRegistry.gen.json`. `git log --follow` shows the rename, and `git grep -n "pkm/title_migration\.py\|pkm\.title_migration\b" -- server web/tooling` is empty. backend.md waits for Task 17.

### Task 7: The core builds the contract models

**Implementer:** opus (the plan digest must not move).

**Files:** `title_migration_core.py`, `server/title_migration.py`, `routes_migrations.py`, `contracts/responses.py`; tests `test_title_migration_core.py`, `test_title_migration.py`.

**Interfaces:**
- `contracts.responses.TitleMigrationBlockerReason = Literal["all_space", "forbidden_syntax"]`, used by `TitleMigrationBlocker.reason`. The schema is unchanged.
- The core's same-name dataclasses `TitleMigrationBlocker`, `TitleMigrationGroup` and `TitleMigrationSidebarRetitle` are deleted. The core builds the `contracts.responses` models by keyword: `TitleMigrationGroup(survivor=TitleMigrationPage(...), sources=[TitleMigrationPage(...), ...], ...)`, with lists, not tuples. `TitleMigrationPlan` keeps its tuples of models. Grouping and `page != survivor` still run on `InventoryPage`s, which become `TitleMigrationPage`s only when the group is built.
- `routes_migrations._audit_payload` becomes one constructor call: `TitleMigrationAuditPayload(active=…, digest=…, groups=list(plan.groups), blockers=list(plan.blockers), sidebar_retitles=list(plan.sidebar_retitles))`.
- `apply_title_migration(...) -> TitleMigrationApplyResponse`. `TitleMigrationOutcome` is deleted, and the route returns the outcome as it gets it, after the nudge that reads `.generation`.

- [ ] **Red:** in `test_title_migration_core.py`, the survivor and source assertions compare with `TitleMigrationPage(page_id=…, title=…)`, and a new `test_plan_holds_the_wire_models` asserts `isinstance(plan.groups[0], responses.TitleMigrationGroup)`. In `test_title_migration.py`, the outcome assertion compares with `TitleMigrationApplyResponse(...)`. All fail today.
- [ ] **Implement.** `_plan_payload` reads the same attribute names, so it needs no change.
- [ ] **Done:** server gates green. The two literal digests (`test_title_migration.py`, `test_title_migration_endpoint.py`) and `_expected_digest`'s three comparisons pass unmodified. `git grep -n "^class TitleMigration\(Blocker\|Group\|SidebarRetitle\|Outcome\)" -- server/src` lists only `contracts/responses.py`. Regen shows no diff.

### Task 8: Delete the sidebar seed script; ordering helpers beside the route

**Implementer:** sonnet.

**Files:** delete `server/src/pkm/importer/import_sidebar.py` and `server/tests/test_import_sidebar.py`. `git mv importer/sidebar_rows.py server/sidebar_core.py` and `git mv tests/test_sidebar_rows.py tests/test_sidebar_core.py`; delete `missing_entry_rows` and its three tests. Modify `routes_sidebar.py` and the `SidebarOrderIdx` entry in `brand_registry.py`, whose comment becomes "the sidebar route appends one past the current max". Regenerate `brandRegistry.gen.json`.

- [ ] **Red:** `test_server_modules_import_nothing_from_the_importer` parses each `pkm/server/*.py` for an import from `pkm.importer`. It fails today on `routes_sidebar.py` alone.
- [ ] **Done:** server gates green; the brand sweep is clean. Regen's only diff is the mint-site path in `brandRegistry.gen.json`. `git grep -n "import_sidebar\|sidebar_rows\|missing_entry_rows\|SIDEBAR_ENTRIES" -- server web/tooling` is empty.

### Task 9: One read-tool list; no FastMCP built at import

**Implementer:** sonnet.

**Files:** create `server/src/pkm/mcp/names.py` (constants only; no FCIS header needed). Modify `mcp/tools.py`, `mcp/server.py` and `assistant/policy.py`; tests `test_mcp_server.py`, `test_assistant_policy.py`, `test_write_preview.py`.

**Interfaces:** `names.READ_TOOL_NAMES: tuple[str, ...]`, today's tuple. Its comment says it names both the tools whose output `pkm-mcp` bounds and the assistant's read tools. `mcp/tools.py` and `mcp/server.py` import it. `policy.READ_TOOLS: tuple[str, ...] = READ_TOOL_NAMES`, so `claude_engine` and the tests keep their name. `mcp/server.py` deletes `mcp = build_server()`.

- [ ] **Red:** `test_importing_the_mcp_server_builds_no_server` (`not hasattr(mcp_server, "mcp")`), and `test_the_assistant_reads_the_mcp_read_tools` (`policy.READ_TOOLS is names.READ_TOOL_NAMES`), which replaces the set-equality test it makes redundant.
- [ ] **Convert** the four test reads of `mcp_server.mcp` to `mcp_server.build_server()`.
- [ ] **Done:** server gates green; `git grep -n '"get_page", "get_block"' -- server/src` finds one tuple, in `names.py`.

### Task 10: Rename wording, one `raw_page`, the preflight re-mints

**Implementer:** sonnet.

**Files:** `server/src/pkm/render.py`, `cli/main.py`, `mcp/tools.py`, `client/workflows.py`, `importer/preflight.py`; `server/tests/test_render.py`.

**Interfaces:**
- `render.render_rename(old_title: str, result: RenamePageResponse) -> str` gives `merged "X" into "Y"` or `renamed "X" -> "Y"`, with no trailing newline; the CLI adds its own.
- `client.workflows.raw_page(page: str | None) -> RawTitle | None`, beside `default_page_title`. The two `_raw_page` copies go.

- [ ] **Red:** `test_render_rename_names_both_branches`; `test_raw_page_is_defined_once` (`git grep "def _raw_page\|def raw_page" -- server/src` finds one hit).
- [ ] **Preflight:** drop `as_raw_title` around the two `page.title` values and the two `RECOVERY_PAGE_TITLE` uses; pyrefly confirms each is already `RawTitle`. The call wrapping `ImportTextLimitError`'s title stays.
- [ ] **Done:** server gates green; the CLI and MCP rename tests pass unmodified.

### Task 11: One pluraliser

**Implementer:** sonnet. Starts after Task 7 merges (`server/title_migration.py`).

**Files:** `server/src/pkm/render.py`, `server/src/pkm/server/title_migration.py`.

- [ ] `render._count_label` becomes public as `count_label(n: int, singular: str, plural: str | None = None) -> str`. `report_noncanonical_titles` calls it, passing its explicit plurals, and `_counted` is deleted.
- [ ] **Red:** `test_report_noncanonical_titles_pluralises` covers one and two of each noun, if no existing test does. It passes before and after; it pins the wording.
- [ ] **Done:** server gates green; `git grep -n "def _counted" -- server` is empty.

### Task 12: `LoginThrottle` beside its policy

**Implementer:** sonnet (a pure move plus pointers).

**Files:** create `server/src/pkm/server/throttle.py` (`# pattern: Imperative Shell`). Modify `auth.py`, `app.py`, `throttle_core.py` (its docstring's `auth.LoginThrottle`), and `server/tests/test_auth.py`.

**Moves, verbatim:** `MAX_CONCURRENT_SCRYPT`, `SCRYPT_ACQUIRE_TIMEOUT_S`, `MAX_TRACKED_SOURCES` with their comments, `_monotonic_ms`, `_SourceTurn` and `LoginThrottle`. `auth.py` imports `LoginThrottle` only. It must not import `MAX_TRACKED_SOURCES`, or a test's patch of the old module would pass silently (Traps: patch targets).

- [ ] **Red:** `test_login_throttle_lives_beside_its_policy` (`LoginThrottle.__module__ == "pkm.server.throttle"`).
- [ ] **Patch targets follow:** `"pkm.server.auth.MAX_TRACKED_SOURCES"` becomes `"pkm.server.throttle.MAX_TRACKED_SOURCES"` at both sites.
- [ ] **`app.create_app`:** the `init_db` comment loses "run.py used to be the only such call" and states the rule in the present tense. This task owns `app.py`.
- [ ] **Done:** server gates green; `git diff --no-ext-diff --color-moved=dimmed-zebra HEAD~ -- server/src` shows moved blocks plus import and pointer lines only.

### Task 13: Each auth rationale written once

**Implementer:** opus (security rationale; a dropped why reads as an invitation to "simplify"). Invoke `architecture-docs`.

**Files:** `auth_gate.py` and `auth_gate_core.py` module docstrings, `auth.login`'s comments, `throttle.py` (`LoginThrottle`, `take_turn`, `hand_turn_to`), `throttle_core.py`'s module docstring, `run.FORWARDED_ALLOW_IPS`'s comment, and `docs/architecture/backend.md` § Auth and § Login throttle (additions only).

- [ ] For every sentence a code comment or docstring drops, find its counterpart in backend.md § Auth or § Login throttle. If it has none, add it there first, beside the mechanism it explains. The implementer's report lists each dropped sentence and where backend.md now says it.
- [ ] Each code site keeps a sentence or two stating its rule and, where the why is long, a `docs/architecture/backend.md#auth` or `#login-throttle` path. Three sites keep a sentence saying why they look wrong but are right: the gate leaving the connection open after a 401 or 413; `_BodyOverCap` being an `HTTPException`; `LoginThrottle` handing the turn to the check, not the request.
- [ ] Comments only: no route gets a docstring (`login` has none; one would feed OpenAPI). `SECURITY.md` is unchanged (Question 3), and `deploy/README.md` already links.
- [ ] **Done:** server gates green; regen shows no diff; `node .claude/skills/architecture-docs/check-docs.mjs` passes.

### Task 14: Config defaults held once

**Implementer:** opus (config defaults; relative paths).

**Files:** `server/src/pkm/server/config.py`, `server/tests/test_config.py`.

**Interfaces:** `load_config(path) -> Config` passes required keys always, and each optional key only when the JSON has it, converting as today:
- `cookie_secure` as given;
- `bind_hosts` through `tuple`;
- `serve_origins` through `_serve_origins`;
- `max_upload_bytes` through `int`;
- `image_descriptions` through `bool`;
- `image_description_model` and `goodlinks_api_url` through `str`;
- `web_dist` and `local_docs_root`: `base / value` when truthy, `None` when present but empty.

The three key files always pass `base / raw.get(name, _field_default(name))`, where `_field_default(name: str) -> object` reads `Config`'s field default. Fix the `openai_api_key_file` comment's pointer to `server/app._default_describe_service`.

- [ ] **Red:** `test_load_config_restates_no_default` asserts that none of the default literals appears in `inspect.getsource(load_config)`: `"gpt-4o-mini"`, `"../openai_key"`, `"../zai_key"`, `"../goodlinks_key"`, the GoodLinks URL, `"127.0.0.1"`, `150 * 1024 * 1024`. It fails today. Add `test_an_empty_config_gets_every_dataclass_default`: for each `Config` field with a default, `load_config(minimal)` gives that default, joined to the base when it is a `Path`. It passes before and after.
- [ ] **Done:** server gates green; every existing `test_config.py` test passes unmodified.

### Task 15: One parity-corpus generator and one shape tally

**Implementer:** opus (parity fixtures stay byte-identical).

**Files:** create `server/src/pkm/parity_corpus.py` (`# pattern: Functional Core`; not named `*_dump.py`, so `test_regen` asks no regen step of it). Modify `refs_parity_dump.py`, `title_parity_dump.py`, `text_limits_parity_dump.py`, and their `test_*_parity_fixture.py`.

**Interfaces:**
- `parity_corpus(draw: Callable[[random.Random], str], *, seed: int, count: int, exclude: Iterable[str] = ()) -> list[str]`: one seeded `random.Random`, and `count` distinct draws that are not in `exclude`, in draw order.
- `piece_soup(pieces: Sequence[str], least: int, most: int) -> Callable[[random.Random], str]`: `"".join(rng.choice(pieces) for _ in range(rng.randint(least, most)))`, which makes the same RNG calls in the same order as today.
- `shape_tally(texts: Iterable[str], shapes: Mapping[str, Callable[[str], bool]]) -> dict[str, int]`.
- Each dump's `generated_cases` becomes one call. Title: `piece_soup(_PIECES, 1, 7)`. Refs: `piece_soup(_PIECES, 2, 9)`, `exclude=CASES`. Text limits: its own draw, `exclude=("",)`, which matches today's `if text and …`. Each module's `SHAPES` becomes `CORPUS_SHAPES` (it collides with `brand_registry.SHAPES`), and its `shape_tally` is deleted.

- [ ] **Red:** `test_parity_corpus_*` unit tests in a new `test_parity_corpus.py`: distinct results, `exclude` honoured, the same seed giving the same list.
- [ ] **Byte check** before committing, from `server/`: `uv run python -m pkm.<name>_parity_dump | cmp - ../shared/fixtures/<name>.json` for `refs_parity`, `title_parity` and `text_limits_parity`. All three are silent. Then `uv run python -m pkm.regen` shows no diff.
- [ ] **Done:** server gates green; the three fixture tests' shape floors pass.

### Task 16: Comment lint catches `Task N`, `Fix A` and `finding N`; the tree is fixed

**Implementer:** sonnet. Starts after Task 5 merges: Tasks 3 and 5 remove three of the hits.

**Files:** `server/tooling/commentlint/core.py`, `server/tests/test_commentlint_core.py`, and the sites below.

**Interfaces:** `_PLAN_POINTER = re.compile(r"\bTask \d+[a-z]?\b|\bFix [A-Z]\b(?![\w/])|\b[Ff]inding \d+\b")`, compiled without `IGNORECASE`. `_rules_broken` reports `orphan-pointer` when `_ORPHAN_POINTER` or `_PLAN_POINTER` matches and `_PATH_POINTER` does not. Rule names are unchanged, so `test_rule_names_are_stable` stands. The module docstring's orphan-pointer bullet names a plan's task, fix or review-finding numbering.

- [ ] **Red:** in the orphan-pointer table, add flag cases `(backlinks: Task 5)`, `Task 2/3/5 semantics`, `Manual recovery (Fix A)` and `regression for review finding 4`. In the pass table, add `fix a race in the loop`, `Step 1: navigate to the form`, `check 1: the server holds the ack`, and `Task 3 of docs/superpowers/plans/x.md`.
- [ ] **Fix the tree** (measured at the base, less the three sites Tasks 3 and 5 remove). State the rule the comment means, or drop the pointer:
  - `web/eslint.config.js` (exhaustive-deps bullet);
  - `web/src/replica/queue.ts` (`poisonedBatches` doc);
  - `web/src/sync/syncState.ts` (header "Task 2/3/5 semantics"; the re-report comment naming "Task 6's engine");
  - `web/src/sync/SyncProvider.tsx` (two "Fix A");
  - `web/src/sync/replicaSync.ts` (stall-detection comment);
  - `web/src/sync/SyncProvider.test.tsx` (section marker);
  - `web/src/sync/replicaSync.test.ts` (one "Task 2", one "finding 2");
  - `server/tests/test_asset_upload.py` ("review finding 4");
  - `server/tests/test_blank_titles.py` (two "Finding 2").

  Also fix `web/tooling/perf/check.ts`'s "(spec Determinism step 2)", an orphan spec pointer the current rule misses.
- [ ] **Leave `server/tooling/perfcheck/fixture.py` byte-identical.** No pattern here matches it. If a reviewer widens the pattern and the sweep then flags the file, fix that line and the stale `ops_core.replay_title_rewrites` pointer (now `replay_core.replay`) in the same commit. Say so in the report, so the orchestrator runs `perf/check.sh backend --rebaseline` and `perf/check.sh frontend --rebaseline` on a quiet machine (Traps: perf fixture hash).
- [ ] **Done:** `PYTHONPATH=server/tooling python3 -m commentlint.run --all` is clean; server gates and web static gates green; `git diff --stat main -- server/tooling/perfcheck/fixture.py` is empty.

### Task 17: Docs say what W13 made true

**Implementer:** opus. Invoke `architecture-docs`. Small edits only: W18 moves these sections later.

**Files:** `docs/architecture/backend.md`, `docs/architecture/files-and-assets.md`.

- [ ] **Module map:** `title_migration.py` → `title_migration_core.py`. Under `server/`, add rows for `path_params.py` (Core: branded path parameters), `clock.py` (Shell: the clock routes read), `throttle.py` (Shell: `LoginThrottle`; the `auth.py` row stops naming it) and `sidebar_core.py` (Core: sidebar order and reorder checks). Add `tag_chars.py` under `contracts/`, since Task 5 points `contracts/__init__.py` here.
- [ ] **§ Wire models and brands:** one sentence. A branded path parameter is parsed by its `path_params` dependency, which keeps each brand's status (422 for a uid, 404 for a sha256 or a GoodLinks id), so a handler only ever receives the checked brand.
- [ ] **§ HTTP API reference:** the `/api/current-work?now_ms` row becomes `/api/current-work`, without the "for tests" clause.
- [ ] **§ Configuration and entrypoints:** one sentence. `Config` holds every default, and `load_config` passes only the keys the file sets, joining path keys to its directory.
- [ ] **§ Title integrity:** the core's path. **§ Login throttle:** `LoginThrottle` (`throttle.py`, policy in `throttle_core.py`).
- [ ] **files-and-assets.md § Assets:** `INLINE_MIME` is the `inline` column of `assets_core.MIME_POLICY`, beside the allowlist. The sha256 sentence names `path_params.path_sha256` (404 when malformed) in place of `routes_assets.py`.
- [ ] **Done:** `node .claude/skills/architecture-docs/check-docs.mjs` passes. `git grep -n "_UID_RE\|title_migration\.py.*Core\|now_ms\b.*current-work\|current-work?now_ms" -- docs/architecture` is empty. No troubleshooting row: W13 fixes no reported failure.

## Order and parallel lanes

```
Lane A (routes):          T1 -> T2 -> T3 -> T4 -> T5
Lane B (registry chain):  T6 -> T7 -> T8
Lane C (client side):     T9 -> T10 -> T11        T11 after T7 merges
Lane D (auth):            T12 -> T13
Lane E (config):          T14
Lane F (parity):          T15
Lane G (lint):            T16                     after Lane A merges
Docs:                     T17                     after everything
```

Lanes A to F can start together in separate worktrees. Within a lane, tasks are serial and rebase onto the branch before merging.

| File | Tasks | Rule |
|---|---|---|
| `routes_pages.py`, `routes_assets.py` | T1, T2 (pages), T3 (assets), T4, T5 | Lane A only |
| `web/src/api/openapi.json`, `types.d.ts` | T1, T2 | Lane A only; regenerate, never hand-merge |
| `brand_registry.py`, `web/tooling/brandRegistry.gen.json` | T6, T8 | Lane B only; regenerate, never hand-merge |
| `server/title_migration.py` | T6, T7, T11 | T11 starts from a branch with T7 merged |
| `render.py`, `mcp/tools.py` | T9, T10, T11 | Lane C only |
| `auth.py`, `throttle.py`, `throttle_core.py`, `app.py` | T12, T13 | Lane D only |
| `describe/core.py` | T3 | |
| `config.py` | T14 | |
| `docs/architecture/backend.md` | T13 (§ Auth, § Login throttle), T17 | T17 after T13 |
| `web/src/sync/*`, `web/src/replica/queue.ts`, `web/eslint.config.js` | T16 | comment lines only |

Other branches:
- **W8** (`refactor/sync-session`, in progress) edits `web/src/sync/replicaSync.ts`, `SyncProvider.tsx` and their tests, where Task 16 changes comment lines. Whichever merges second rebases. W8 must not keep a `Fix A` or `Task N` comment, or `test_the_tracked_tree_is_clean` fails on its merge.
- **W14** edits `assistant/policy.py`, `test_assistant_policy.py` and `test_write_preview.py`, as Task 9 does (different hunks). Whichever merges second rebases.
- **W18** moves backend.md sections after W13 merges, so Task 17's edits stay within the sections they name.

## Traps

- **OpenAPI and generated types.** Only Tasks 1 and 2 may change `openapi.json` or `types.d.ts`, and only as their expected diffs state. A route function's docstring feeds the OpenAPI description, so Tasks 1, 2 and 13 add or change none. *Detect:* `test_openapi_sync.py` in `pytest -q`; `git status --short web/src/api` after each regen.
- **Dependency order and statuses.** A path dependency raises before the route's own query params are validated. A request with a bad sha256 and a bad `if_unreferenced` moves from 422 to 404; that change is accepted. With the path dependency declared first, a malformed parameter answers before `get_db` opens a connection or `get_goodlinks` looks up the gateway. Both answer `404 not found` for GoodLinks, so the order does not change that status. `require_auth`, a router dependency, still runs before every endpoint dependency, and the auth gate runs before routing. *Detect:* Task 1's status table, with its anonymous rows.
- **The brand marker.** A `str` path parameter without `json_schema_extra={"x-brand": …}` drops the marker, and gen-types then types the path as `string`. *Detect:* the regen diff.
- **Query text.** The perf check's plan analysis reads SQL text. `BLOCK_COLS` must be byte-identical to `_BLOCK_COLS`, `like_escape` must give the same parameters, and `type_where` must keep its placeholder count and parameter order. *Detect:* `perf/check.sh backend` (Final gates) reports no count or plan change in `page/*`, `block/*`, `titles` or `assets/search`.
- **Perf fixture hash.** `server/tooling/perfcheck/fixture.py`'s bytes are the baselines' `fixture_hash`: editing it, a comment included, makes both baselines incomparable. No W13 task edits it; its stale pointer waits for the next change that edits the file anyway (Question 5). *Detect:* `git diff --stat main -- server/tooling/perfcheck/fixture.py` is empty at the end. If it is not, the orchestrator runs `perf/check.sh backend --rebaseline` and `perf/check.sh frontend --rebaseline` on a quiet machine and says why in the commit.
- **Patch targets after a move.** `monkeypatch.setattr("pkm.server.auth.MAX_TRACKED_SOURCES", …)` raises once the name leaves `auth`, which is the loud case. The silent case is `auth.py` re-importing the name: the patch then lands on a copy `LoginThrottle` never reads. *Detect:* the two eviction tests fail when their patch is removed.
- **The plan digest.** `_plan_payload` reads attribute names. A model that renamed a field, or a survivor still held as an `InventoryPage` in one place and as a `TitleMigrationPage` in another, would change the digest, or fail the strict model. *Detect:* the two literal digests, unmodified.
- **Strict models.** `StrictModel` refuses a tuple for a `list` field and positional arguments. A frozen `TitleMigrationPlan` holding pydantic models is not hashable; nothing hashes it today, and nothing should start. *Detect:* the run.
- **Relative key-file paths.** A `Config` built without `load_config` (`openapi_dump`, `shim_parity_dump`, the perf harness, tests) gets the dataclass's relative default, as today. Only `load_config` joins it to the base. *Detect:* `test_config.py`'s `*_default` tests.
- **Parity RNG order.** `piece_soup` must call `rng.randint` once, then `rng.choice` per piece, exactly as today. `exclude` must be checked against the same set that collects the draws. A different order gives a different corpus that still passes the shape floors. *Detect:* the three `cmp`s in Task 15, then regen.
- **Comment-lint case.** The new pattern is case-sensitive. Adding it to the `IGNORECASE` `_ORPHAN_POINTER` would flag ordinary prose ("fix a race", "the task 3 queue"). *Detect:* Task 16's pass cases.
- **Brand registry JSON.** `rows_dump` writes `brandRegistry.gen.json` from `brand_registry.py`. A hand-merged conflict there passes review and fails `test_rows_artifact.py`. *Detect:* regenerate after every rebase in Lane B.
- **Coverage.** `--cov-fail-under` is enforced over `pkm`. The deletions remove covered code with its tests; each new module has its own tests. *Detect:* `uv run pytest -q`'s last line.
- **FCIS and the brand rules.** `path_params.py`, `sidebar_core.py` and `parity_corpus.py` are Functional Core; `clock.py` and `throttle.py` are Imperative Shell; `mcp/names.py` holds constants only. `path_params` mints nothing itself: it calls the registered parsers. *Detect:* the brand sweep and `test_brandlint_*.py` inside `pytest -q`.

## Final gates

| Gate | Who |
|---|---|
| Server gates after every commit | each implementer |
| Web static gates | Tasks 1, 2 and 16 |
| `uv run python -m pkm.regen` with the expected diff | Tasks 1, 2, 6, 8; a no-diff check in Tasks 5, 7, 13 and 15 |
| `node .claude/skills/architecture-docs/check-docs.mjs` | Tasks 13 and 17 |
| `cd server && uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check` on the merged branch | orchestrator, after each merge |
| `cd web && pnpm verify` | orchestrator, once, after T16 and T17 |
| `perf/check.sh backend`: expect no count or plan change in any scenario; a moved count is a regression to read against the diff before any `--bootstrap` | orchestrator, at the end, on a quiet machine |
| `git diff --stat main -- server/tooling/perfcheck/fixture.py` is empty | orchestrator, before merge |

`proptest/check.sh` is not a W13 gate: no task touches sync, ops, planning, outline commands or undo history. `test_no_500_request_props.py`, which draws requests from the OpenAPI schema, runs inside `pytest -q`.

## Questions for Arthur

1. **`GET /assets/{sha256}/{filename}`'s parameter order.** Moving the sha256 parse into a dependency lists `filename` first in `openapi.json` and in the generated path type, because FastAPI puts a route's own path params before its dependencies'. Nothing reads that order. *Recommendation and default:* accept the swap, so every branded path param has one idiom. The alternative keeps that one route's in-body parse.
2. **Who owns the read-tool list?** W13 said `assistant.policy` imports `mcp.tools.READ_TOOL_NAMES`. That points a Functional Core at a Shell that imports the HTTP client, and loads it into the server process. *Recommendation and default:* a constants module, `pkm/mcp/names.py`, imported by both, with `policy.READ_TOOLS` bound to the same tuple.
3. **`SECURITY.md`'s copies of the auth rationale.** W18's bullet already strips from backend.md § Auth, § Login throttle and § Hostile input every sentence `SECURITY.md` carries, and `deploy/README.md` already links. *Recommendation and default:* W13 trims the code and makes sure backend.md holds each why; `SECURITY.md` waits for W18, so the sections move once.
4. **The web's copy of the document MIME list** (`web/src/views/filesCore.ts`, `DOCUMENT_MIME`). Pinning it to `MIME_POLICY` needs a generated artifact or a parity fixture, a regen step and a web test. *Recommendation and default:* a follow-up bean; W13 stays server-side.
5. **The stale `ops_core.replay_title_rewrites` pointer in `perfcheck/fixture.py`.** Fixing it alone costs a rebaseline of both perf sides. *Recommendation and default:* leave it, as W12 did, until a change edits that file anyway. Task 16's pattern does not reach it.
