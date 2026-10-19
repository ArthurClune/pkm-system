# Brand check, tests mint through named helpers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every test, test-support file and tooling file under the
brand rules: tests mint brands only through checked, named helpers, and the
walk-arounds tests would reach are closed.

**Architecture:** One registry (`server/src/pkm/brand_registry.py`) gains
`TEST_MINT_SITES`, `TEST_HELPERS` and `TEST_CODE` and loses the exempting
`TEST_SUPPORT`; both lints (server `brandlint`, web `eslint-plugin-brands`)
read it. Each side gets one test mint module whose helpers check the
brand's shape. The two raw readers (`rawread.read`, `ReplicaDb.introspect`)
refuse brand-carrying columns under tests. Then the server and web tests
are migrated until both lints and all suites are green.

**Tech Stack:** Python 3.12 stdlib AST lint, pytest, pyrefly; TypeScript,
typescript-eslint flat config with a local type-aware plugin, vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-brand-check-design.md`,
section "Tests, test support and tooling (amended 2026-10-18)" and the
2026-10-18 lines under "Decided by Arthur" and "Calls I made". Tasks 1-16
of this bean (pkm-zv2s, follow-ups pkm-78r0 and pkm-e9q8) are done on
`feat/brand-check-web`; this plan continues at Task 17.

## Global Constraints

- No exemption for tests, test support or tooling; no allow-list or
  baseline of existing violations. Every violation is fixed.
- Everyday helpers check shape: a brand with a `SHAPES` regex must match
  it; an integer brand takes an integer (not a bool, not a float); others
  take their base type. A deliberately bad value goes through
  `malformedUid` / `malformedSha` (`malformed_uid` / `malformed_sha`).
- Helper names come from registry `TEST_HELPERS` (brand -> snake stem):
  `<stem>_of` in Python, `<camelStem>Of` on the web.
- Short uid tags become uid-shaped as `tuid-<tag>` (`"a"` -> `"tuid-a"`).
- A rewritten value is rewritten everywhere that test spells it (setup,
  expected text, SQL, regexes, negative assertions). Never delete or
  weaken an assertion to make a test pass.
- The runtime row check, and the raw readers' refusal, run only under
  tests, never in production.
- `brandlint` stays stdlib only and runs under the system `python3`.
- Every lint message names the fix; in test code it names the helper.
- `model_validate` stays allowed in tests. `web/e2e/**` stays outside the
  lints. Seeding by raw SQL then reading through `select` stays allowed.
- AGENTS.md rules: FCIS header on new runtime files, comment rules (80/120
  columns, no bean ids or line numbers in comments), no session URLs in
  commit messages. Docs edits under `docs/architecture/` use the
  `architecture-docs` skill.

## Review Focus

1. **A rewritten uid that leaves a negative assertion vacuous**: setup now
   says `tuid-a` but `expect(text).not.toContain("((a))")` still names `a`
   and passes forever. Expected: negative assertions move with the value.
   Pinned in Tasks 18 and 20 (Step "audit negative assertions").
2. **`True`/`1.5` into an integer helper**: Python `bool` is an `int`.
   Expected: `page_id_of(True)` and `pageIdOf(1.5)` throw. Pinned in
   Tasks 17 and 19.
3. **The read refusal leaking into production**: `introspect` is product
   code. Expected: with the row check off, `introspect` returns any column
   unchanged. Pinned in Task 19 (`introspect refuses only under the row
   check`).
4. **Importing the test mint module by another spelling**:
   `from pkm.test_data import ids`, `import pkm.test_data.ids as t`,
   `../test-helpers`, `./test-helpers.ts`. Expected: each is reported from
   product code. Pinned in Tasks 17 and 19.
5. **Lint cost**: tests roughly double the files the type-aware block and
   brandlint read. Expected: `pnpm lint` and the pre-commit hook stay
   usable; report before/after timings in Tasks 17, 19 and 21.

---

### Task 17: Registry and server lint cover tests; the server test mint module

**Files:**
- Modify: `server/src/pkm/brand_registry.py`, `server/src/pkm/rows_dump.py`,
  `web/tooling/brandRegistry.gen.json` (regenerated),
  `server/tooling/brandlint/core.py`, `server/tooling/brandlint/registry.py`,
  `web/tooling/eslint-plugin-brands/index.mjs` (read the renamed key only),
  `server/tests/rawread.py`, `docs/architecture/enforced-checks.md`,
  `docs/architecture/backend.md` (testing policy, if it states the exemption)
- Create: `server/src/pkm/test_data/ids.py`, `server/tests/test_test_ids.py`
- Test: `server/tests/test_brandlint_mints.py`,
  `server/tests/test_brandlint_names.py`, `server/tests/test_rows_artifact.py`

**Interfaces:**
- Produces (registry):
  - `TEST_MINT_SITES: tuple[str, ...] = ("server/src/pkm/test_data/ids.py",
    "web/src/test-helpers.ts")`: may mint every brand.
  - `TEST_HELPERS: dict[str, str]`, brand -> snake stem: BlockUid `uid`,
    PageId `page_id`, SidebarEntryId `sidebar_entry_id`, OrderIdx
    `order_idx`, SidebarOrderIdx `sidebar_order_idx`, SyncSeq `seq`,
    ClientId `client_id`, BatchId `batch_id`, Sha256Hex `sha`,
    ConversationId `conversation_id`, ConfirmId `confirm_id`, GoodlinksId
    `goodlinks_id`, NormalizedTitle `normalized_title`, CanonicalTitle
    `canonical_title`, CanonicalQueryNode `canonical_query_node`,
    PendingRowId `pending_row_id`, TicketId `ticket_id`, RequestId
    `request_id`, Revision `revision`, ParkedTitle `parked_title`.
  - `MALFORMED: dict[str, str]`: BlockUid `uid`, Sha256Hex `sha`
    (helpers `malformed_uid`, `malformed_sha`; web `malformedUid`,
    `malformedSha`).
  - `TEST_CODE: tuple[str, ...]`: files that are tests by location, not
    exempt from anything: `server/tests/`, `server/src/pkm/test_data/`,
    `web/src/test-setup.ts`, `web/src/test-helpers.ts`, `web/src/props/`,
    `web/src/replica/replayArbs.ts`, `web/src/sync/memReplica.ts`.
    (`*.test.*` files are tests by name on the web.)
  - `TEST_SUPPORT` keeps only its four web paths until Task 19 deletes it;
    `server/src/pkm/test_data/` leaves it now.
  - `SQLITE_SITES` gains `server/tests/rawread.py` (the test-side raw
    reader) and each server test whose subject is SQLite itself (backup,
    corruption, integrity, WAL), each with its reason beside it.
- Produces (gen.json): keys `testMintSites`, `testHelpers` (brand ->
  camel stem), `malformed` (brand -> camel stem), `testCode`, and
  `testSupport` (web paths, until Task 19).
- Produces (`pkm.test_data.ids`): `uid_of(value: str) -> BlockUid`,
  `page_id_of(value: int) -> PageId`, ... one `<stem>_of` per
  `TEST_HELPERS` brand that exists on the server (not in `WEB_BRANDS`), and
  `malformed_uid(value: str) -> BlockUid`, `malformed_sha(value: str) ->
  Sha256Hex`. Shapes read from `brand_registry.SHAPES`.
- Produces (`rawread.read`): raises `AssertionError("<col> carries <Brand>:
  read it with Db.select under its row key")` when a returned column name
  is a row-vocabulary key whose type carries a brand.

- [ ] **Step 1: Write failing lint tests** (in `test_brandlint_mints.py` /
  `test_brandlint_names.py`, using the existing `rules(text, path)` helper):
  - `test_server_tests_are_in_scope`: `rules("x = BlockUid(raw)\n",
    "server/tests/test_x.py") == ["brand-mint"]`; same for
    `"server/src/pkm/test_data/core.py"`.
  - `test_the_test_mint_module_may_mint_every_brand`: `BlockUid(raw)`,
    `PageId(1)`, `Sha256Hex(raw)` in `server/src/pkm/test_data/ids.py` -> `[]`.
  - `test_a_mint_in_a_test_names_the_helper`: the violation message for
    `PageId(1)` in a test contains `page_id_of` and `pkm.test_data.ids`;
    for `BlockUid("")` it also names `malformed_uid`.
  - `test_product_code_may_not_import_the_test_mint_module`, parametrized
    over `from pkm.test_data.ids import uid_of`, `from pkm.test_data import
    ids`, `import pkm.test_data.ids as t` in `STORE` -> `["test-mint-import"]`;
    the same lines in `server/tests/test_x.py` -> `[]`.
  - `test_an_aliased_brand_import_is_still_a_mint`: `"from
    pkm.contracts.ops import BlockUid as U\nx = U(raw)\n"` in `ROUTES` ->
    `["brand-mint"]`.
  - `test_a_brand_passed_as_a_value_is_a_mint`, parametrized over
    `list(map(BlockUid, xs))`, `sorted(xs, key=PageId)`,
    `defaultdict(BlockUid)` -> `["brand-mint"]`; `TypeAdapter(list[BlockUid])`
    and `NewType("X", BlockUid)` -> `[]`.
  - `test_newtype_declared_through_typing_or_indented_is_a_brand`:
    `declared_newtypes` finds `X = typing.NewType("X", str)`,
    `X: TypeAlias = NewType("X", str)` and an indented declaration.
  - `test_an_ignore_comment_does_not_launder_a_brand_literal`:
    `'SetHeadingOp(op="set_heading", uid="uid_b2", heading=5)  #
    pyrefly: ignore[bad-argument-type]\n'` in a test -> `["brand-ignore"]`;
    the same call with `uid=uid_of("uid_b2")` -> `[]`; also for `# type:
    ignore` and for a multi-line call whose span holds the comment.
  - `test_an_unannotated_brand_name_parameter_is_flagged` (names file):
    `def make(uid): ...` -> `["brand-name"]`, message says to annotate it
    `BlockUid`; `lambda uid: uid` -> `[]`.
  - `test_cast_model_construct_and_raw_sqlite_apply_in_tests`: each in
    `server/tests/test_x.py` is reported; `.raw` in
    `server/tests/rawread.py` is clean.
  - Replace `test_test_support_and_other_trees_are_exempt` with
    `test_other_trees_are_not_checked` (non-Python and non-server paths
    only).
- [ ] **Step 2: Write failing helper tests** in `server/tests/test_test_ids.py`:
  `uid_of("tuid-a") == "tuid-a"`; `uid_of("a")`, `uid_of("")` raise
  `ValueError` naming `malformed_uid`; `malformed_uid("")` returns `""`;
  `sha_of("0"*64)` passes and `sha_of("zz")` raises; `page_id_of(3) == 3`;
  `page_id_of(True)` and `page_id_of(1.5)` raise; and
  `test_every_test_helper_exists`: for every `TEST_HELPERS` brand not in
  `WEB_BRANDS`, `ids` has `<stem>_of`, and every `MALFORMED` brand has
  `malformed_<stem>`. Add a `test_rawread_refuses_brand_columns` case
  (`rawread.read(db, "SELECT uid FROM blocks")` raises naming
  `Db.select`; `"SELECT count(*) AS n FROM blocks"` passes).
- [ ] **Step 3: Run them; expect failures** (`cd server && uv run pytest
  tests/test_brandlint_mints.py tests/test_brandlint_names.py
  tests/test_test_ids.py -q`).
- [ ] **Step 4: Implement** the registry tables, `rows_dump` keys and
  regenerated gen.json; `ids.py`; the `rawread` refusal (vocabulary from
  `pkm.rows`); in `brandlint/core.py`: `SCOPE_ROOTS` gains `server/tests/`,
  `in_scope` no longer consults `test_support`, rule ids
  `test-mint-import` and `brand-ignore` join `RULES` with remedies,
  aliases resolved from `ImportFrom ... as`, brand-as-argument reported
  (except `cast`, `NewType`, `TypeAdapter`, `isinstance`), unannotated
  rule-1 parameters reported (not lambdas), and test-code messages built
  from `TEST_HELPERS`/`MALFORMED`. In `registry.py`, broaden
  `declared_newtypes` and load the new tables. The web plugin's
  `isExempt` reads `testSupport` exactly as before (no web behaviour
  change in this task).
- [ ] **Step 5: Run the new tests; expect PASS.** Then run the sweep
  `PYTHONPATH=server/tooling python3 -m commentlint.run --all` and record
  the violation count in `server/tests` by rule. It is expected red until
  Task 18 (so is `test_the_tracked_tree_is_clean`); every other test,
  `uv run pyrefly check`, `uv run ruff check`, `cd web && pnpm lint &&
  pnpm typecheck` pass. Time the sweep before and after.
- [ ] **Step 6: Docs**: enforced-checks.md brand-rules section (scope now
  includes tests, the three new tables, the new rule ids, the refusal);
  remove any "tests are exempt" statement from backend.md.
- [ ] **Step 7: Commit** `feat(pkm-78r0): server tests under the brand
  rules; test mint module and helper registry`, staging files by path.

### Task 18: Server tests pass the brand rules

**Files:**
- Modify: every file `commentlint.run --all` reports under `server/tests/`
  and `server/src/pkm/test_data/` (about 45 files with brand constructor
  calls, 29 with unannotated rule-1 parameters, the raw-sqlite and
  `rawread` users).

**Interfaces:**
- Consumes: Task 17's `pkm.test_data.ids` helpers, `rawread` refusal,
  `SQLITE_SITES` entries.

- [ ] **Step 1: Codemod the mints.** A throwaway script (scratchpad, not
  committed) rewrites `Brand(literal)` to `<stem>_of(literal)` and adds the
  import. Short uid tags become `tuid-<tag>` per the Global Constraints;
  a literal used to test rejection (`""`, `"nope"`, `"uidé12"` ...)
  becomes `malformed_uid(...)`. Decide rejection-vs-fixture per test by
  reading it, not by pattern.
- [ ] **Step 2: Fix the rest by hand**: unannotated rule-1 parameters,
  `cast`, `model_construct`, ignore-comment lines (split the call so each
  ignore covers only the argument it is for, the others through helpers),
  raw sqlite (move to `Db` or `rawread`), and every read `rawread` now
  refuses (move to `Db.select` with explicit aliased columns, e.g. `SELECT
  seq, page_id AS change_page_id, ... FROM changes`).
- [ ] **Step 3: Audit negative assertions**: for every file whose values
  changed, list each `not in` / `!=` / `assert not` / `pytest.raises`
  assertion that names a rewritten value, and confirm it names the new
  value. Put the list in the report.
- [ ] **Step 4: Verify**: sweep clean (0 violations), `uv run pytest -q`
  (coverage enforced) green, `uv run pyrefly check` 0, `uv run ruff
  check` clean.
- [ ] **Step 5: Commit** in a few commits by area,
  `test(pkm-78r0): server tests mint through pkm.test_data.ids`.

### Task 19: Web lint covers tests; checked test helpers; introspect refusal

**Files:**
- Modify: `web/eslint.config.js`, `web/tooling/eslint-plugin-brands/index.mjs`,
  `web/src/test-helpers.ts`, `web/src/replica/db.ts`,
  `server/src/pkm/brand_registry.py` (delete `TEST_SUPPORT`),
  `server/src/pkm/rows_dump.py`, `web/tooling/brandRegistry.gen.json`,
  `docs/architecture/enforced-checks.md`, `docs/architecture/frontend.md`
  (test helpers, `introspect` under tests)
- Create: eslint fixtures under `web/tooling/eslint-fixtures/` as needed
- Test: `web/tooling/lintConfig.test.ts`, `web/src/test-helpers.test.ts`,
  `web/src/replica/db.test.ts`

**Interfaces:**
- Consumes: Task 17's gen.json keys `testMintSites`, `testHelpers`,
  `malformed`, `testCode`.
- Produces (`test-helpers.ts`): `<camelStem>Of` for every `testHelpers`
  brand the web declares (`uidOf(value: string): BlockUid`,
  `pageIdOf(value: number): PageId`, `seqOf`, `orderIdxOf`,
  `sidebarEntryIdOf`, `sidebarOrderIdxOf`, `clientIdOf`, `batchIdOf`,
  `shaOf`, `pendingRowIdOf`, `ticketIdOf`, `requestIdOf`, `revisionOf`,
  `confirmIdOf`, `goodlinksIdOf`, `conversationIdOf`,
  `normalizedTitleOf`, `canonicalTitleOf`, `parkedTitleOf`), plus
  `malformedUid(value: string): BlockUid` and `malformedSha(value:
  string): Sha256Hex`. Shapes from `BRAND_SHAPES` in
  `replica/columns.gen.ts`. The old helpers (`uid`, the tag-deriving
  `uidOf`, `pageId`, `entryId`, `ord`, `sidebarOrd`, `title`,
  `normTitle`, Task 16's unchecked `batchIdOf`) stay, marked
  `@deprecated`, until Task 20 removes them; the new checked `uidOf`
  replaces the deriving one now, so its handful of callers move here.
- Produces (`ReplicaDb.introspect`): under the row check (vitest), throws
  `"<col> carries <Brand>: read it with select<K>"` for a returned column
  that is a brand-carrying `Columns` key; unchanged otherwise.

- [ ] **Step 1: Write failing tests.**
  - `lintConfig.test.ts`: `a test file is linted by the brand rules`
    (`"x" as BlockUid` in `src/foo.test.ts` reports
    `brands/no-brand-assertion` whose message contains `uidOf` and
    `test-helpers`); `test-helpers.ts may mint every brand` (clean);
    `props files are linted` (`src/props/ops/a.ts` reports);
    `product code may not import the test helpers` (imports of
    `../test-helpers` and `./test-helpers.ts` from `src/outline/x.ts`
    report `no-restricted-imports`; from `src/outline/x.test.ts` they are
    clean); `ts-ignore and ts-nocheck are banned, ts-expect-error needs a
    description`; `any reaches a branded slot only with a report in tests`
    (`const u: BlockUid = JSON.parse(s)` in a test reports
    `no-unsafe-assignment`). Update the `isExempt` assertions: nothing
    under `src/` is exempt any more.
  - `test-helpers.test.ts`: `uidOf("tuid-a")` returns it; `uidOf("a")`
    throws naming `malformedUid`; `malformedUid("")` returns `""`;
    `pageIdOf(1.5)` throws; `shaOf("zz")` throws; `every registry test
    helper is exported` (for each `testHelpers` brand declared in
    `api/brands.ts` or a web brand, the module exports `<stem>Of`).
  - `db.test.ts`: `introspect refuses a brand column under the row check`
    (`SELECT uid FROM blocks` throws naming `select`), `introspect allows
    catalog columns` (`PRAGMA quick_check`), `introspect refuses only
    under the row check` (with `checkRows: false` the same query returns
    rows).
- [ ] **Step 2: Run; expect failures** (`cd web && pnpm test:unit --
  lintConfig test-helpers replica/db`).
- [ ] **Step 3: Implement.** Config: drop the type-aware block's
  `ignores` for tests; add a block for test files (`**/*.test.{ts,tsx}`
  plus `testCode` paths) that re-states `no-restricted-imports` without
  the test-helpers pattern; product files get a `**/test-helpers`
  pattern ("test helpers mint brands without a parse; product code reads
  or parses them"); add `@typescript-eslint/ban-ts-comment` (`ts-ignore`,
  `ts-nocheck` banned, `ts-expect-error: "allow-with-description"`).
  Plugin: delete `isExempt` and `testSupport`; `test-helpers.ts` and the
  other `testMintSites` are mint sites for every brand; in a test file
  the remedy names `<stem>Of` (and `malformed<Stem>`) from test-helpers.
  Registry: delete `TEST_SUPPORT` and the gen.json `testSupport` key.
- [ ] **Step 4: Run the new tests; expect PASS.** Run `pnpm lint` and
  record the report count by rule and by file area (tests, props,
  replayArbs, memReplica); red is expected until Task 21. `pnpm
  typecheck` passes. Time `pnpm lint` before and after.
- [ ] **Step 5: Docs** (enforced-checks.md web rows; frontend.md test
  helpers and `introspect`).
- [ ] **Step 6: Commit** `feat(pkm-78r0): web tests under the brand rules;
  checked test helpers; introspect refuses brand columns`.

### Task 20: Web tests use the checked helpers

**Files:**
- Modify: the ~77 web test files calling `uid(...)` and every caller of
  the other deprecated helpers; `web/src/test-helpers.ts` (delete the
  deprecated helpers at the end).

**Interfaces:**
- Consumes: Task 19's helpers.

- [ ] **Step 1: Codemod the helper calls** (throwaway script in the
  scratchpad): `uid(x)` -> `uidOf(x)`, `pageId` -> `pageIdOf`, `entryId`
  -> `sidebarEntryIdOf`, `ord` -> `orderIdxOf`, `sidebarOrd` ->
  `sidebarOrderIdxOf`, `title` -> `canonicalTitleOf`, `normTitle` ->
  `normalizedTitleOf`, fixing imports. About 940 `uid("<short>")` calls
  (94 distinct tags) become `tuid-<tag>`, and the script rewrites the
  same tag where that file spells it as the same uid (`((a))` refs,
  expected text, SQL literals, regexes); review each file's diff, since a
  bare `"a"` may also be text that is not the uid. Deliberately bad
  values (`uid('a"b')`) become `malformedUid`.
- [ ] **Step 2: Run `pnpm test:unit`; fix failures** by completing the
  rewrite in the test, never by loosening an assertion.
- [ ] **Step 3: Audit negative assertions** (`not.toContain`,
  `not.toBe`, `toBeUndefined` on a lookup by uid, ...) naming a rewritten
  tag; list them in the report.
- [ ] **Step 4: Delete the deprecated helpers**; `pnpm typecheck` and
  `pnpm test:unit` pass.
- [ ] **Step 5: Commit** `test(pkm-78r0): web tests use the checked test
  helpers` (several commits by directory are fine).

### Task 21: Web tests pass the whole lint

**Files:**
- Modify: every file `pnpm lint` reports after Task 20.

**Interfaces:**
- Consumes: Task 19's helpers and `introspect` refusal.

- [ ] **Step 1: Casts**: the ~580 `as Brand` casts in tests become
  helper calls; a cast toward a composite (`{ uid: ... } as BlockNode`)
  becomes an annotated literal built with helpers; `introspect(...) as
  T[]` reads with brand columns become `select<K>` (aliases per the row
  vocabulary); catalog and count reads stay on `introspect`.
- [ ] **Step 2: The other rules**: `no-unsafe-*` (type the mock with
  `vi.fn<...>()`, parse `res.json()` into its generated type),
  `no-floating-promises`, `only-throw-error`, and transport tests that
  must import `apiFetch` join the existing per-file override block.
- [ ] **Step 3: Verify**: `pnpm lint` 0 problems, `pnpm typecheck`,
  `pnpm test:unit` green; record lint time.
- [ ] **Step 4: Commit** `test(pkm-78r0): web tests pass the brand and
  type-aware lint`.

### After Task 21 (controller, as zv2s Task 14)

Full gates: `cd web && pnpm verify`; `cd server && uv run pytest -q`,
pyrefly, ruff, sweep; `proptest/check.sh web` and `server`;
`perf/check.sh backend --rebaseline` and `frontend --rebaseline` (perf
`fixture.py` changed in Task 16), then both checks. Whole-branch review on
the strongest model, merge `--no-ff`, beans: pkm-78r0 complete (Optional
item left open or split), pkm-e9q8 first four items plus the server alias
part of its brandlint item ticked, pkm-zv2s Task 14 ticked and complete.
