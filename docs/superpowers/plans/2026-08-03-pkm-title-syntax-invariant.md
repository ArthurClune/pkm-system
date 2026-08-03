# PKM Title-Syntax Invariant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the failed nested-title migration closure with strict cross-stack title validation, import-only syntax sanitization, and reasoned migration blockers while retaining metadata-only sync notification and authoritative broadcasts.

**Architecture:** `pkm.refs` and `web/src/replica/titles.ts` own equivalent pure forbidden-title predicates driven by one shared fixture. Server and replica shells preflight complete operation batches before mutation; the importer uses a separate pure recursive sanitizer before row derivation; title migration returns to boundary-U+0020-only grouping with typed blockers. The existing forced equal-cursor generation frame and fail-closed authoritative broadcast remain unchanged.

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2, SQLite/FTS5, pytest, TypeScript, sqlite-wasm, Vitest, pnpm, generated OpenAPI types.

## Global Constraints

- The approved requirements source is `docs/superpowers/specs/2026-08-02-pkm-title-syntax-invariant-design.md`.
- Never read, copy, audit, or mutate the production PKM database or production CLI configuration.
- Never use port `8974`; isolated verification uses exactly `http://127.0.0.1:18974` with disposable data and CLI configuration.
- After control-whitespace normalization, every normal title containing `#`, `[[`, or `]]` is invalid and must be rejected, never silently sanitized.
- Boundary U+0020 handling remains independently gated by the existing plain-space migration activation flag; blank-title behavior remains unchanged.
- Imports alone remove every `#` and recursively balanced `[[`/`]]` marker from title spellings while preserving visible text; malformed title syntax and blank sanitized results refuse publication.
- Import collision selection is deterministic: an exact already-sanitized page wins; otherwise the first page in the importer’s stable title order wins. Survivor root blocks remain first, followed by source root blocks in stable source order.
- Reads and authoritative snapshot/feed application do not gain rejection paths for legacy rows; migration audit exposes legacy invalid titles as blockers.
- Operation batches and durable replica queue writes validate the complete batch before the first page, block, ref, receipt, or pending-op mutation.
- Generic rename replacement values are opaque simultaneous one-pass values; replacement strings are never recursively interpreted.
- Migration planning handles boundary U+0020 only: exact clean twin wins, otherwise lowest page ID. No nested enclosing-title closure, intermediate identity, final identity, or replacement expansion remains.
- Migration blockers have reason `all_space` or `forbidden_syntax`, participate in the digest, and prevent apply before mutation.
- Preserve the forced equal-cursor frame’s real journal maximum and committed generation; never fabricate or advance a cursor.
- Preserve fail-closed authoritative broadcasts and same-page null semantics.
- Python and TypeScript validators consume `shared/fixtures/title_syntax.json` and produce equivalent results.
- Every behavior change follows RED/GREEN TDD. Every changed runtime file retains an accurate FCIS declaration.
- Regenerate `web/src/api/openapi.json` and `web/src/api/types.d.ts` after blocker-contract changes.
- Keep `pkm-2ilw` in progress until all revised checklist items and final title-lane review pass. Keep `pkm-8kw2` in progress with its three parity-lane items unchecked.

---

### Task 1: Restore opaque rename behavior and add the Python title predicate

**Files:**
- Create: `shared/fixtures/title_syntax.json`
- Modify: `server/src/pkm/refs.py`
- Modify: `server/src/pkm/rename.py`
- Modify: `server/tests/test_refs.py`
- Modify: `server/tests/test_rename.py`

**Interfaces:**
- Produces:
  ```python
  TitleSyntaxReason = Literal["forbidden_syntax"]

  def title_syntax_reason(title: str) -> TitleSyntaxReason | None: ...
  ```
- Preserves:
  ```python
  def rewrite_title_refs_map(
      text: str, replacements: Mapping[str, str]
  ) -> str: ...
  ```
  Replacement values are opaque and are never scanned for more replacements.

- [ ] **Step 1: Add the shared validator fixture and RED Python test**

  Create `shared/fixtures/title_syntax.json` with named cases that pin valid literal single brackets and invalid tokens after normalization:

  ```json
  {
    "cases": [
      {"name": "plain", "title": "Acme", "reason": null},
      {"name": "single-open-bracket", "title": "Project [Acme]", "reason": null},
      {"name": "single-close-bracket", "title": "Project ]Acme[", "reason": null},
      {"name": "hash", "title": "Project #Acme", "reason": "forbidden_syntax"},
      {"name": "empty-hash", "title": "#", "reason": "forbidden_syntax"},
      {"name": "open-pair", "title": "Project [[Acme", "reason": "forbidden_syntax"},
      {"name": "close-pair", "title": "Project Acme]]", "reason": "forbidden_syntax"},
      {"name": "balanced-ref", "title": "Project [[Acme]]", "reason": "forbidden_syntax"},
      {"name": "nested-ref", "title": "Outer [[Inner [[Leaf]]]]", "reason": "forbidden_syntax"},
      {"name": "control-plus-hash", "title": "Project\n#Acme", "reason": "forbidden_syntax"}
    ]
  }
  ```

  In `server/tests/test_refs.py`, load this fixture beside `ref_grammar.json` and assert `title_syntax_reason(case["title"]) == case["reason"]` for every case.

  Run:
  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_refs.py -k title_syntax
  ```
  Expected: FAIL because `title_syntax_reason` does not exist.

- [ ] **Step 2: Implement the minimal pure predicate**

  Add to `pkm.refs`:

  ```python
  from typing import Literal

  TitleSyntaxReason = Literal["forbidden_syntax"]

  def title_syntax_reason(title: str) -> TitleSyntaxReason | None:
      normalized = normalize_title(title)
      if "#" in normalized or "[[" in normalized or "]]" in normalized:
          return "forbidden_syntax"
      return None
  ```

  Run the Step 1 command. Expected: PASS.

- [ ] **Step 3: Add opaque-replacement RED regressions**

  In `server/tests/test_rename.py`, remove the nested mapped-target expansion expectation introduced by `3f2fc3b` and add:

  ```python
  assert rewrite_title_refs_map(
      "[[Old]] and [[Other]]",
      {"Old": "New #Old", "Other": "Old"},
  ) == "[[New #Old]] and [[Old]]"
  ```

  Also retain mapping-order independence, code-span/fence protection, tag conversion, and attribute rewrite coverage.

  Run:
  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_rename.py
  ```
  Expected: FAIL because recursive mapped-target expansion rewrites the replacement value.

- [ ] **Step 4: Restore the reviewed one-pass implementation**

  Compare `server/src/pkm/rename.py` with `689cedf`, then remove `_mapped_title()`, the `expanding` argument, recursive scanning of replacement values, and the nested expansion test. Keep original-span collection and right-to-left splicing so mappings remain simultaneous and order-independent.

  Run:
  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_refs.py tests/test_rename.py
  uv run pyrefly check
  uv run ruff check
  ```
  Expected: all pass.

- [ ] **Step 5: Commit the pure invariant foundation**

  ```bash
  git add shared/fixtures/title_syntax.json server/src/pkm/refs.py server/src/pkm/rename.py server/tests/test_refs.py server/tests/test_rename.py
  git commit -m "fix(pkm-2ilw): define forbidden title syntax"
  ```

### Task 2: Reject forbidden titles atomically at server write boundaries

**Files:**
- Modify: `server/src/pkm/server/store.py`
- Modify: `server/src/pkm/server/routes_pages.py`
- Modify: `server/src/pkm/server/ops_core.py`
- Modify: `server/src/pkm/server/ops_apply.py`
- Modify: `server/tests/test_blank_titles.py`
- Modify: `server/tests/test_rename_endpoint.py`
- Modify: `server/tests/test_ops_apply.py`
- Modify: `server/tests/test_ops_endpoint.py`
- Modify: `server/tests/test_client_api.py`
- Modify: `server/tests/test_cli_main_write.py`
- Modify: `server/tests/test_mcp_server.py`

**Interfaces:**
- Consumes `title_syntax_reason()` from Task 1.
- Produces:
  ```python
  class ForbiddenTitleError(ValueError):
      title: str

  @dataclass(frozen=True)
  class OpTitleViolation:
      op_index: int
      source: Literal["page_title", "reference"]
      title: str
      reason: TitleSyntaxReason

  def find_op_title_violation(
      ops: Sequence[BlockOp],
  ) -> OpTitleViolation | None: ...
  ```
- `apply_batch()` raises existing `OpError(index, reason)` before `_context_for()` or any mutation when preflight finds a violation.

- [ ] **Step 1: Write direct create/rename RED tests**

  Add parameterized route/store tests for `"#"`, `"Project #Acme"`, `"Project [[Acme"`, `"Project Acme]]"`, and `"Project [[Acme]]"`. Assert:

  - `POST /api/pages` returns 422 with a clear forbidden-title detail and creates no page;
  - rename to `New #Old` returns 422 before rewrite/merge and leaves pages, blocks, refs, sidebar, FTS, and journal unchanged;
  - daily generated titles still create normally;
  - existing blank-title behavior and inactive/active plain-space behavior remain unchanged.

  Run:
  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_blank_titles.py tests/test_rename_endpoint.py
  ```
  Expected: forbidden create cases persist and hash rename is accepted.

- [ ] **Step 2: Add store defense and route adaptation**

  In `store.py`, canonicalize, perform the existing blank check, then reject forbidden syntax before `fetch_page()` or `INSERT`:

  ```python
  class ForbiddenTitleError(ValueError):
      def __init__(self, title: str) -> None:
          super().__init__(f"unsupported page-title syntax: {title!r}")
          self.title = title

  if title_syntax_reason(title) is not None:
      raise ForbiddenTitleError(title)
  ```

  Catch `ForbiddenTitleError` in `POST /api/pages` and return 422. In rename, replace the bracket-only condition with `title_syntax_reason(new_title)` after canonicalization and before fetching or mutating rows. Do not catch `ForbiddenTitleError` in `index_ref()`; only `BlankTitleError` remains non-reference behavior.

  Run the Step 1 command. Expected: PASS.

- [ ] **Step 3: Write complete-batch and ref-derived RED tests**

  Add pure/preflight tests and real `/api/ops` tests covering:

  ```text
  create_page.page_title
  create.page_title
  move.page_title when non-null
  every extracted ref target in create.text
  every extracted ref target in update_text.text
  ```

  Use a two-op batch whose first op is valid and whose second op contains an invalid title/reference. Assert HTTP 400 detail identifies index `1`, and no page, block, ref, journal row, batch receipt, or first-op mutation exists afterward. Pin nested ref target rejection, `New #Old`, CLI batch/save, and MCP save/batch server-error propagation.

  Run:
  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_ops_apply.py tests/test_ops_endpoint.py tests/test_client_api.py tests/test_cli_main_write.py tests/test_mcp_server.py
  ```
  Expected: one or more tests show partial mutation or late `ForbiddenTitleError` rather than indexed atomic refusal.

- [ ] **Step 4: Implement pure operation-title preflight**

  In `ops_core.py`, iterate operations in wire order. Check explicit page titles first, then refs from create/update text in extraction order. Return the first `OpTitleViolation`; do not inspect replacement strings or authoritative sync rows.

  In `ops_apply.apply_batch()`, run preflight before allocating contexts:

  ```python
  violation = find_op_title_violation(batch.ops)
  if violation is not None:
      raise OpError(
          violation.op_index,
          f"unsupported {violation.source} title syntax: {violation.title!r}",
      )
  ```

  Keep blank op-page fallback, forced sync notification, `_require_page_title()`, authoritative overwrite, and same-page null semantics unchanged.

- [ ] **Step 5: Verify all normal server callers**

  Run:
  ```bash
  cd server
  uv run pytest -q -o addopts='' \
    tests/test_refs.py \
    tests/test_blank_titles.py \
    tests/test_rename_endpoint.py \
    tests/test_ops_apply.py \
    tests/test_ops_endpoint.py \
    tests/test_client_api.py \
    tests/test_cli_main_write.py \
    tests/test_mcp_server.py \
    tests/test_newline_titles.py
  uv run pyrefly check
  uv run ruff check
  ```
  Expected: all pass.

- [ ] **Step 6: Commit server-boundary enforcement**

  ```bash
  git add server/src/pkm/server/store.py server/src/pkm/server/routes_pages.py server/src/pkm/server/ops_core.py server/src/pkm/server/ops_apply.py server/tests/test_blank_titles.py server/tests/test_rename_endpoint.py server/tests/test_ops_apply.py server/tests/test_ops_endpoint.py server/tests/test_client_api.py server/tests/test_cli_main_write.py server/tests/test_mcp_server.py
  git commit -m "fix(pkm-2ilw): reject forbidden server titles"
  ```

### Task 3: Restore simple migration planning and expose blocker reasons

**Files:**
- Modify: `server/src/pkm/title_migration.py`
- Modify: `server/src/pkm/server/title_migration.py`
- Modify: `server/src/pkm/server/routes_migrations.py`
- Modify: `server/src/pkm/contracts/responses.py`
- Modify: `server/src/pkm/cli/render.py`
- Modify: `server/tests/test_title_migration_core.py`
- Modify: `server/tests/test_title_migration.py`
- Modify: `server/tests/test_title_migration_endpoint.py`
- Modify: `server/tests/test_client_api.py`
- Modify: `server/tests/test_cli_render.py`
- Modify: `server/tests/test_cli_main_read.py`
- Modify: `server/tests/test_journal_advancing_contract.py`
- Regenerate: `web/src/api/openapi.json`
- Regenerate: `web/src/api/types.d.ts`

**Interfaces:**
- Consumes `title_syntax_reason()` and opaque `rewrite_title_refs_map()`.
- Produces:
  ```python
  TitleMigrationBlockerReason = Literal["all_space", "forbidden_syntax"]

  @dataclass(frozen=True)
  class TitleMigrationBlocker:
      page_id: int
      title: str
      reason: TitleMigrationBlockerReason
  ```
- `TitleMigrationPlan.blockers`, `BlockedTitleMigration.blockers`, and API audit blockers use `TitleMigrationBlocker`.

- [ ] **Step 1: Write simple-planner and blocker RED tests**

  Restore assertions for boundary-U+0020 grouping only: exact clean twin wins, otherwise lowest page ID, and sources sort by page ID. Remove tests that require recursive mapped-target expansion, nested final groups, intermediate identities, or nested survivor retitles.

  Add cases where:

  - an all-space title yields reason `all_space`;
  - `Bad #Title`, `Bad [[Title`, and `Bad Title]]` yield `forbidden_syntax` even without boundary spaces;
  - a padded forbidden title is one blocker and never a migration group;
  - blocker ordering is deterministic by `(title, page_id, reason)`;
  - blocker reason is included in the canonical payload and changing/adding a blocker changes the digest.

  Run:
  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_title_migration_core.py
  ```
  Expected: FAIL because blockers are unreasoned pages and nested closure remains.

- [ ] **Step 2: Restore the boundary-space core and typed blockers**

  Compare `server/src/pkm/title_migration.py` with `689cedf`. Remove `boundary_replacements`, `final_groups`, `intermediate_titles`, recursive canonical-title rewriting, and final-identity selection. Before grouping each inventory page:

  ```python
  canonical = canonicalize_title(page.title, plain_space=True)
  if is_blank_title(canonical):
      blockers.append(TitleMigrationBlocker(page.page_id, page.title, "all_space"))
  elif title_syntax_reason(canonical) is not None:
      blockers.append(TitleMigrationBlocker(
          page.page_id, page.title, "forbidden_syntax"
      ))
  elif page.title != canonical:
      padded_groups.setdefault(canonical, []).append(page)
  ```

  Add blocker `reason` to `_plan_payload()` and increment payload `version` from `1` to `2`.

- [ ] **Step 3: Write shell/apply RED tests**

  Assert inventory includes every forbidden page, including unpadded pages that are not migration candidates. Audit remains side-effect free. Apply with either blocker reason raises `BlockedTitleMigration` before page/ref/sidebar/FTS/journal/activation/generation mutation. Restore the transaction order regression to require rewrite/reindex before activation, with full `BaseException` rollback preserved.

  Remove nested-final inventory/sidebar/apply/import expectations introduced by `3f2fc3b`. Keep orphan canonical-sidebar digest and atomic rollback tests.

  Run:
  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_title_migration.py
  ```
  Expected: failures from nested inventory/order and missing forbidden blockers.

- [ ] **Step 4: Restore shell inventory and apply order**

  Compare `server/src/pkm/server/title_migration.py` with `689cedf`. Remove `rewrite_title_refs_map` import, `final_titles`, final sidebar inventory, and nested survivor logic. Select:

  ```text
  every padded boundary-space candidate
  every existing exact boundary canonical twin
  every forbidden title blocker
  blocks/refs/sidebar rows affected by migration candidates
  ```

  Apply in one existing rollback-protected transaction:

  ```text
  BEGIN IMMEDIATE
  fresh inventory + digest comparison
  active/blocker refusal
  snapshot inbound blocks
  retitle/merge by stable page ID
  opaque one-pass rewrite and reindex
  set activation
  rotate generation
  COMMIT
  ```

  Generalize `BlockedTitleMigration` text to `title migration is blocked by invalid titles`.

- [ ] **Step 5: Add API/client/CLI blocker-reason RED tests**

  Change the Pydantic contract so audit blockers include required reason:

  ```python
  class TitleMigrationBlocker(BaseModel):
      page_id: int
      title: str
      reason: Literal["all_space", "forbidden_syntax"]
  ```

  Pin authenticated GET JSON, typed client validation, `--json`, and human output such as:

  ```text
  - [18] "Bad #Title" (forbidden_syntax)
  ```

  Keep 409 status semantics. Keep the zero-group forced frame test proving unchanged journal maximum, committed generation, and `force: true`.

- [ ] **Step 6: Implement contracts/rendering and regenerate artifacts**

  Update route serialization as needed, then run:

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_title_migration_endpoint.py tests/test_client_api.py tests/test_cli_render.py tests/test_cli_main_read.py tests/test_journal_advancing_contract.py
  uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
  cd ../web
  pnpm gen-types
  cd ../server
  uv run pytest -q -o addopts='' tests/test_openapi_sync.py tests/test_title_migration_endpoint.py
  uv run pyrefly check
  uv run ruff check
  ```
  Expected: all pass and generated artifacts include required blocker reason.

- [ ] **Step 7: Commit migration simplification and contract change**

  ```bash
  git add server/src/pkm/title_migration.py server/src/pkm/server/title_migration.py server/src/pkm/server/routes_migrations.py server/src/pkm/contracts/responses.py server/src/pkm/cli/render.py server/tests/test_title_migration_core.py server/tests/test_title_migration.py server/tests/test_title_migration_endpoint.py server/tests/test_client_api.py server/tests/test_cli_render.py server/tests/test_cli_main_read.py server/tests/test_journal_advancing_contract.py web/src/api/openapi.json web/src/api/types.d.ts
  git commit -m "fix(pkm-2ilw): block unsupported legacy titles"
  ```

### Task 4: Sanitize imported title syntax before row creation

**Files:**
- Create: `server/src/pkm/importer/titles.py`
- Modify: `server/src/pkm/importer/run.py`
- Modify: `server/src/pkm/importer/report.py`
- Create: `server/tests/test_import_titles.py`
- Modify: `server/tests/test_report.py`
- Modify: `server/tests/test_importer_e2e.py`

**Interfaces:**
- Consumes `Export`, `Page`, and `Block` from `pkm.importer.parse_export`, plus `normalize_title()`, `is_blank_title()`, `title_syntax_reason()`, `extract()`, and opaque `rewrite_title_refs_map()`.
- Produces:
  ```python
  ImportTitleErrorReason = Literal["malformed_syntax", "blank"]

  class ImportTitleError(ValueError):
      original_title: str
      location: str
      reason: ImportTitleErrorReason

  @dataclass(frozen=True)
  class ImportTitleChange:
      original_title: str
      sanitized_title: str
      locations: tuple[str, ...]
      merged: bool

  @dataclass(frozen=True)
  class SanitizedImport:
      export: Export
      title_changes: tuple[ImportTitleChange, ...]

  def sanitize_import_title(title: str, *, location: str) -> str: ...

  def sanitize_export_titles(export: Export) -> SanitizedImport: ...
  ```

- [ ] **Step 1: Write pure sanitizer RED tests**

  In `test_import_titles.py`, assert:

  ```python
  sanitize_import_title("Project [[Acme]]", location="page[0]") == "Project Acme"
  sanitize_import_title(
      "Wrapper [[Outer [[Inner]]]]", location="page[0]"
  ) == "Wrapper Outer Inner"
  sanitize_import_title("Project #Acme", location="page[0]") == "Project Acme"
  sanitize_import_title("Project #[[Acme]]", location="page[0]") == "Project Acme"
  sanitize_import_title("C#", location="page[0]") == "C"
  ```

  Assert lone `[[`/`]]`, crossed/unbalanced pairs, and premature closes raise `ImportTitleError(reason="malformed_syntax")` naming original title and location. Assert `"#"`, `"[[#]]"`, and control-whitespace-only results raise reason `blank`.

  Run:
  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_import_titles.py
  ```
  Expected: missing module.

- [ ] **Step 2: Implement recursive marker stripping**

  Implement a deterministic index-based parser. On `[[`, recursively consume until its matching `]]` and append only the recursively sanitized visible inner text. A `]]` without an open frame or end-of-input with an open frame raises `ImportTitleError`. After bracket removal, remove every `#`, call `normalize_title()`, apply existing blank policy, and assert `title_syntax_reason(result) is None`.

  Keep this module `# pattern: Functional Core`; it performs no file/database/report I/O.

- [ ] **Step 3: Write export transformation and collision RED tests**

  Build `Export` objects directly and assert `sanitize_export_titles()`:

  - sanitizes explicit page titles and balanced reference targets extracted from page and orphan block text;
  - rewrites block text to sanitized target spellings before `to_rows()` can derive refs;
  - does not reject unmatched bracket prose that does not form an extracted title target;
  - chooses an exact already-sanitized page as survivor;
  - otherwise chooses the first page in `Export.pages` stable order;
  - keeps survivor root blocks first and appends each source’s root blocks in stable source order without changing UIDs/subtrees;
  - preserves survivor timestamps;
  - emits sorted `ImportTitleChange` records with all page/block-UID locations and truthful `merged` flags.

  Run the Step 1 command. Expected: export/collision cases fail.

- [ ] **Step 4: Implement pure export sanitization**

  First collect every explicit page title and every `extract(block.text).refs` title across page and orphan trees. Sanitize each title once into a complete mapping. Rewrite each block’s original text once with `rewrite_title_refs_map()`, rebuilding immutable `Block` trees. Group rebuilt pages by sanitized title, choose the required survivor, and concatenate top-level children without changing child order or UIDs. Rebuild `Export` with the transformed pages and transformed `orphan_blocks`, while copying `orphan_block_count`, `skipped_entities`, and `attr_counts` unchanged so recovery-page publication and `((uid))` preservation still see every orphan subtree. Return that rebuilt `Export` plus deterministic report records.

  Do not create rows, page IDs, files, or a database in this module.

- [ ] **Step 5: Add report and E2E RED tests**

  Extend `ImportReport` with required `title_changes: tuple[ImportTitleChange, ...]` and render:

  ```text
  title spellings sanitized: 2
    "Project [[Acme]]" -> "Project Acme" (merged; page[...], block uid-...)
  ```

  When empty, render `title spellings sanitized: none`.

  Replace `NESTED_MIGRATION_EXPORT` closure expectations with imports covering bracket refs, nested refs, `#Tag`, `#[[Tag]]`, exact-clean collision, stable blocks/refs, report output, malformed syntax, blank result, and unchanged previously published DB/report on refusal. Assert successful output has no forbidden page title, correct refs, preserved block UIDs/order, and activation `"1"`.

  Run:
  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_import_titles.py tests/test_report.py tests/test_importer_e2e.py
  ```
  Expected: report fields/order and pre-row sanitization fail.

- [ ] **Step 6: Integrate sanitizer before row and filesystem work**

  In `run.main()` execute:

  ```text
  verify export file
  parse EDN
  parse_export
  sanitize_export_titles
  linked-file indexing / asset text transform
  to_rows
  create output/temp database
  shared title audit/apply activation
  render report and publish
  ```

  Catch only `ImportTitleError`, print `error: import refused at {location}: ...`, and return 2 before `out.mkdir()`. Pass `title_changes` to `ImportReport`. The later importer-follow-up lane may insert structural preflight between `parse_export` and sanitization; do not duplicate that future work here.

- [ ] **Step 7: Verify and commit importer sanitization**

  ```bash
  cd server
  uv run pytest -q -o addopts='' tests/test_import_titles.py tests/test_rows.py tests/test_report.py tests/test_importer_e2e.py tests/test_title_migration.py
  uv run pyrefly check
  uv run ruff check
  cd ..
  git add server/src/pkm/importer/titles.py server/src/pkm/importer/run.py server/src/pkm/importer/report.py server/tests/test_import_titles.py server/tests/test_report.py server/tests/test_importer_e2e.py
  git commit -m "feat(pkm-2ilw): sanitize imported title markup"
  ```

### Task 5: Enforce TypeScript parity and offline atomic refusal

**Files:**
- Modify: `web/src/replica/titles.ts`
- Modify: `web/src/replica/titles.test.ts`
- Modify: `web/src/replica/localOps.ts`
- Modify: `web/src/replica/localOps.test.ts`
- Modify: `web/src/replica/queue.ts`
- Modify: `web/src/replica/queue.test.ts`
- Modify: `web/src/replica/localApi/router.ts`
- Modify: `web/src/replica/localApi/router.test.ts`
- Modify: `web/src/replica/apply.test.ts`

**Interfaces:**
- Consumes `BlockOp`, `extractRefs()`, and existing `canonicalizeTitle()`.
- Produces:
  ```typescript
  export type TitleSyntaxReason = "forbidden_syntax";

  export function titleSyntaxReason(title: string): TitleSyntaxReason | null;

  export interface OpTitleViolation {
    opIndex: number;
    source: "page_title" | "reference";
    title: string;
    reason: TitleSyntaxReason;
  }

  export function findOpTitleViolation(
    ops: readonly BlockOp[],
  ): OpTitleViolation | null;
  ```

- [ ] **Step 1: Add shared-fixture RED parity tests**

  In `titles.test.ts`, load `shared/fixtures/title_syntax.json` using `readFileSync(new URL(..., import.meta.url), "utf-8")`. Assert every case matches `titleSyntaxReason()`, alongside existing control-whitespace/plain-space/NBSP canonicalization tests.

  Run:
  ```bash
  cd web
  pnpm vitest run src/replica/titles.test.ts
  ```
  Expected: missing export.

- [ ] **Step 2: Implement the TypeScript predicate and op preflight**

  `titleSyntaxReason()` calls existing `normalizeRefTitle()` and returns `"forbidden_syntax"` when the normalized title includes `#`, `[[`, or `]]`. `findOpTitleViolation()` checks the same explicit fields and create/update extracted refs, in the same order as Python Task 2.

  Run the Step 1 command. Expected: PASS.

- [ ] **Step 3: Write local-op and durable-queue RED tests**

  Add two-op batch tests where op 1 is valid and op 2 has a forbidden explicit/ref-derived title. Assert:

  - `applyLocalOps()` leaves pages, blocks, refs, sidebar, and metadata unchanged;
  - `enqueueBatch()` inserts no `pending_ops`, captures no partial optimistic state, and throws a validation error rather than swallowing it as best-effort cache maintenance;
  - create/update refs and explicit create/create_page/move targets all reject;
  - authoritative `SyncPage` snapshot/feed rows remain accepted by `replica/apply.ts`.

  Run:
  ```bash
  cd web
  pnpm vitest run src/replica/localOps.test.ts src/replica/queue.test.ts src/replica/apply.test.ts
  ```
  Expected: invalid batches partially apply or persist.

- [ ] **Step 4: Preflight local application and queue persistence**

  Call `findOpTitleViolation()` once before `applyLocalOps()` enters its transaction. In `enqueueBatch()`, validate the full incoming batch before update-hash capture, savepoints, optimistic application, or `pending_ops` insert. Convert a violation to `LocalOpError` with operation index/source/title. Do not catch this validation error in the optimistic savepoint branch.

  Keep ordinary behind-replica optimistic failures best-effort and durable, as before.

- [ ] **Step 5: Write local API RED tests and adapt 422 behavior**

  Parameterize local `POST /api/pages` with shared forbidden cases. Assert 422, no negative page, and no queued batch. Add a defensive `getOrCreateLocalPage()` test. In the router, canonicalize, keep blank 422, then return forbidden-title 422 before create/enqueue. `getOrCreateLocalPage()` also throws `LocalOpError` for future callers.

  Run:
  ```bash
  cd web
  pnpm vitest run src/replica/localApi/router.test.ts src/replica/localOps.test.ts src/replica/queue.test.ts
  ```
  Expected: local page rows/queue entries are created before refusal.

- [ ] **Step 6: Verify and commit TypeScript parity**

  ```bash
  cd web
  pnpm vitest run \
    src/replica/titles.test.ts \
    src/replica/localOps.test.ts \
    src/replica/queue.test.ts \
    src/replica/localApi/router.test.ts \
    src/replica/apply.test.ts
  pnpm typecheck
  pnpm lint
  pnpm check:fcis
  cd ..
  git add web/src/replica/titles.ts web/src/replica/titles.test.ts web/src/replica/localOps.ts web/src/replica/localOps.test.ts web/src/replica/queue.ts web/src/replica/queue.test.ts web/src/replica/localApi/router.ts web/src/replica/localApi/router.test.ts web/src/replica/apply.test.ts
  git commit -m "fix(pkm-2ilw): reject forbidden offline titles"
  ```

### Task 6: Reconcile documentation, beans, and title-lane verification

**Files:**
- Modify: `README.md`
- Modify: `.claude/skills/pkm/SKILL.md`
- Modify: `docs/architecture/backend.md`
- Modify: `docs/architecture/sync-and-offline.md`
- Modify: `.beans/pkm-2ilw--canonicalize-existing-space-padded-page-titles-dat.md`
- Verify: `.beans/pkm-8kw2--clientserver-parity-remaining-depth-100-caps-and-b.md`

**Interfaces:**
- Documents only behavior present in Tasks 1–5.
- Preserves the existing authenticated migration commands and API paths.
- Leaves `pkm-8kw2` in progress with traversal/ancestor/blank-ref items unchecked.

- [ ] **Step 1: Invoke `superpowers:writing-skills` before editing the PKM skill**

  Follow its test-first workflow. Verify migration/help examples against current CLI parser and tests rather than editing from the plan alone.

- [ ] **Step 2: Remove stale nested-closure claims and document the invariant**

  Update README, backend architecture, sync/offline architecture, and PKM skill to state:

  - normal writes reject `#`, `[[`, and `]]` after control normalization;
  - operations/ref-derived writes and offline queueing refuse atomically;
  - imports recursively remove title markers before rows and report deterministic merges;
  - migration audit returns `all_space`/`forbidden_syntax` blockers and apply refuses them;
  - migration replacement values are opaque and boundary-space-only;
  - forced equal-cursor generation frames use the real journal maximum;
  - applied-page broadcasts require authoritative stored titles and fail closed;
  - production migration remains an explicit later operator action.

  Verify backend API table/model text against generated OpenAPI and current route registration. Search stale nested/final-title/count claims:

  ```bash
  rg -n 'nested|closure|final title|final-title|blocker|forbidden|title syntax|plain-space|plain_space_title' README.md docs/architecture .claude/skills/pkm/SKILL.md
  ```

- [ ] **Step 3: Reconcile bean history without erasing retained fixes**

  In `pkm-2ilw`, mark revised implementation items complete only when their reviewed tasks are complete. Rewrite the old nested-support final-review checklist/summary as superseded by strict syntax validation. Keep the forced notification and fail-closed broadcast outcomes. Append a corrected `## Summary of Changes` that states exactly: `Production title migration/inventory was NOT executed.`

  Do not complete `pkm-8kw2`; confirm its authoritative-broadcast item remains checked and its three parity items remain unchecked.

- [ ] **Step 4: Run consolidated focused gates**

  ```bash
  cd server
  uv run pytest -q -o addopts='' \
    tests/test_refs.py \
    tests/test_rename.py \
    tests/test_blank_titles.py \
    tests/test_rename_endpoint.py \
    tests/test_ops_apply.py \
    tests/test_ops_endpoint.py \
    tests/test_title_migration_core.py \
    tests/test_title_migration.py \
    tests/test_title_migration_endpoint.py \
    tests/test_journal_advancing_contract.py \
    tests/test_client_api.py \
    tests/test_cli_render.py \
    tests/test_cli_main_read.py \
    tests/test_cli_main_write.py \
    tests/test_mcp_server.py \
    tests/test_import_titles.py \
    tests/test_rows.py \
    tests/test_report.py \
    tests/test_importer_e2e.py \
    tests/test_openapi_sync.py
  uv run pyrefly check
  uv run ruff check
  cd ../web
  pnpm vitest run \
    src/sync/SyncProvider.test.tsx \
    src/sync/replicaSync.test.ts \
    src/replica/apply.test.ts \
    src/replica/titles.test.ts \
    src/replica/localOps.test.ts \
    src/replica/queue.test.ts \
    src/replica/localApi/router.test.ts
  pnpm typecheck
  pnpm lint
  pnpm check:fcis
  ```

  Expected: all pass; forced notification, fail-closed broadcast, migration rollback, import publication ordering, and cross-stack fixture parity remain green.

- [ ] **Step 5: Repeat the supported lifecycle only on disposable port 18974**

  Create a temporary data directory and temporary CLI config, start this worktree’s server at exactly `127.0.0.1:18974`, and abort if the configured URL differs from `http://127.0.0.1:18974`. Exercise:

  ```text
  stable repeated audit
  forbidden_syntax blocker visibility and apply refusal
  blocker removal only in the disposable database
  stale digest refusal after disposable mutation
  fresh audit/apply
  activation and generation change
  zero-group forced equal-cursor pull behavior from automated tests
  valid canonical create/read
  forbidden create/rename/op refusal
  ```

  Stop the process and delete the temporary data/config. Do not inspect production again.

- [ ] **Step 6: Commit documentation and reviewed bean state**

  ```bash
  git add README.md .claude/skills/pkm/SKILL.md docs/architecture/backend.md docs/architecture/sync-and-offline.md .beans/pkm-2ilw--canonicalize-existing-space-padded-page-titles-dat.md .beans/pkm-8kw2--clientserver-parity-remaining-depth-100-caps-and-b.md
  git commit -m "docs(pkm-mk87): document strict title syntax"
  ```

## Final review and stopping point

After all six tasks have clean task reviews, the SDD controller requests a fresh whole-title-lane review of `9770753..HEAD` against both title plans and the approved syntax design. Require explicit verdicts on strict boundary coverage, batch/ref atomicity, import collision/ref preservation, migration blocker digest/apply behavior, opaque rename regression, retained forced notification, retained authoritative broadcast, generated artifacts, FCIS, docs, beans, and production safety. Fix every load-bearing finding test-first and obtain a scoped re-review.

Complete `pkm-2ilw` only after the review is clean, every revised checklist item is checked, and the bean summary records focused counts and production non-use. Do not merge the title branch into the integration branch or `main`; stop and ask the user.
