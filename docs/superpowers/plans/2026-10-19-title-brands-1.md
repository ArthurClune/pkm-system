# Title brands, branch 1: RawTitle and the kind-specific names

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `RawTitle` brand at the top of the title hierarchy, type the
wire's raw title fields with it, and register the kind-specific title names
with the brand check, converting every site on both sides.

**Architecture:** `CanonicalTitle` ⊂ `NormalizedTitle` ⊂ `RawTitle` ⊂ string,
on the server as a NewType chain and on the web as an intersection chain with
one subtype key per level. Raw text becomes `RawTitle` through one mint
function per side, at the place it enters. NAMES gains the branch-1 names;
bare `title` is branch 2 and is not registered here.

**Tech Stack:** Python 3 / pydantic / pyrefly / the AST brandlint
(`server/tooling/brandlint`); TypeScript / the ESLint brands plugin
(`web/tooling/eslint-plugin-brands`).

**Spec:** `docs/superpowers/specs/2026-10-19-title-brands-design.md`

**Bean:** pkm-hc95. Branch `feat/title-brands-1`, in a worktree.

## Global Constraints

- No runtime behaviour change: no value, response body, SQL result or op
  changes. A brand is a type only.
- No allow-list, no baseline: every violation is converted.
- No cast or `as` to a title brand outside its mint sites. A site that seems
  to need one is a provenance question: trace where the value comes from and
  type that origin.
- `as_raw_title` / `asRawTitle` are called only on a plain `str`/`string` at
  the place raw text enters, never on a value already typed as a title.
- Every generated artifact (`openapi.json`, `types.d.ts`, `columns.gen.ts`,
  `brandRegistry.gen.json`) is regenerated in the commit that stales it.
- FCIS headers and the comment rules in AGENTS.md apply. Comments carry no
  bean ids.

## Review Focus

1. **Laundering upward**: a value typed `CanonicalTitle` that a task re-mints
   through `asRawTitle` (weakens its type silently, so a later need for the
   canonical spelling is not caught). Task 2 and Task 4 reviewers grep every
   new `asRawTitle(`/`as_raw_title(` call and check its argument is a plain
   string.
2. **Request validation unchanged**: `Field(min_length=1)` on a field retyped
   to `RawTitle` still rejects `""` with 422. Pinned in Task 2.
3. **Schema markers**: after the supertype change, `NormalizedTitle` and
   `CanonicalTitle` fields still carry their own `x-brand`, not `RawTitle`.
   Pinned in Task 1.
4. **`block_rewrites` reads**: every SELECT of `old_title`/`new_title` reads
   under the new aliases; one that does not is caught only by the test-time
   row check, so each read path must be exercised by an existing test.
   Pinned in Task 3 by grepping the SELECTs against tests.
5. **The lint's subtype chain**: an `as NormalizedTitle` in a `RawTitle`
   mint site, or an `as CanonicalTitle` in a `NormalizedTitle` mint site,
   is still reported. Pinned in Task 1.

---

### Task 1: The RawTitle brand and the three-level hierarchy

**Files:**
- Create: `server/src/pkm/contracts/titles.py` (Functional Core): declares
  `RawTitle`, `NormalizedTitle`, `CanonicalTitle` and `as_raw_title`, each
  NewType `brand()`ed in its own statement.
- Modify: `server/src/pkm/refs.py`: delete the two NewType declarations and
  import all three from `pkm.contracts.titles` (existing
  `from pkm.refs import CanonicalTitle` imports keep working; do not sweep
  them). `refs.py` stays a mint site of all three (add it to `MINT_SITES`,
  since it no longer declares them).
- Modify: `server/src/pkm/brand_registry.py`: `MINT_SITES["RawTitle"] =
  (_CONTRACTS, "server/src/pkm/refs.py", "web/src/replica/titles.ts",
  _WEB_ROWS, _WEB_WIRE)`, with a comment that `as_raw_title`/`asRawTitle`
  are the mints; add `refs.py` to NormalizedTitle and CanonicalTitle;
  `TEST_HELPERS["RawTitle"] = "raw_title"`; `SHAPES["RawTitle"] =
  ("text", None)`.
- Modify: `server/src/pkm/test_data/ids.py`: `raw_title_of(value: str) ->
  RawTitle`; `normalized_title_of`/`canonical_title_of` build through the
  chain.
- Modify: `web/src/api/brands.ts`: `RawTitle`; `NormalizedTitle = RawTitle &
  { readonly __normalized: true }`; `CanonicalTitle` unchanged. Update the
  header comment's example to the chain.
- Modify: `web/src/replica/titles.ts`: `export function asRawTitle(text:
  string): RawTitle`.
- Modify: `web/src/test-helpers.ts`: `rawTitleOf(value: string): RawTitle`.
- Modify: `web/tooling/eslint-plugin-brands/index.mjs`: replace
  `SUBTYPE_KEY`/`SUBTYPE_BRAND`/`SUBTYPE_PARENT` with a chain
  `SUBTYPES = [["__canonical", "CanonicalTitle"], ["__normalized",
  "NormalizedTitle"]]` (most-derived first): an intersection carrying a
  subtype key names that key's brand and drops every ancestor brand;
  `BRAND_TAGS` holds `__brand` plus every subtype key.
- Regenerate: `web/tooling/brandRegistry.gen.json` and
  `web/src/replica/columns.gen.ts` (`cd server && uv run python -m
  pkm.rows_dump`), `web/src/api/openapi.json` (`uv run python -m
  pkm.server.openapi_dump`) and `types.d.ts` (`cd web && pnpm gen-types`)
  if they change.
- Docs (invoke `architecture-docs`): `docs/architecture/backend.md`
  "Title integrity and one-time activation" gains the hierarchy and the
  `RawTitle` mint in one short paragraph or table row;
  `docs/architecture/enforced-checks.md` `no-brand-assertion` row: "A
  subtype brand (`CanonicalTitle`, `NormalizedTitle`) counts as its own
  brand rather than its parent's".
- Test: `server/tests/test_title_brands.py` (new);
  `web/tooling/lintConfig.test.ts`; `web/src/replica/titles.test.ts`.

**Interfaces:**
- Produces: `pkm.contracts.titles.RawTitle`, `NormalizedTitle`,
  `CanonicalTitle`, `as_raw_title(text: str) -> RawTitle`;
  `web/src/api/brands.ts` `RawTitle`; `asRawTitle(text: string): RawTitle`
  from `web/src/replica/titles.ts`; test helpers `raw_title_of` /
  `rawTitleOf`.

- [ ] **Step 1: Write the failing tests**

`server/tests/test_title_brands.py`:
- `test_each_title_brand_carries_its_own_schema_marker`: a throwaway
  pydantic model with fields `a: RawTitle`, `b: NormalizedTitle`,
  `c: CanonicalTitle`; `model_json_schema()["properties"]` has `x-brand`
  `"RawTitle"`, `"NormalizedTitle"`, `"CanonicalTitle"` respectively.
- `test_as_raw_title_returns_the_text_unchanged`: `as_raw_title(" a\tb ")
  == " a\tb "`.

`web/tooling/lintConfig.test.ts`, beside the existing scan.ts
`CanonicalTitle` case:
- `as RawTitle` in a non-mint file is reported naming `RawTitle`.
- `as NormalizedTitle` in `web/src/replica/titles.ts` is not reported, and
  in a non-mint file is reported naming `NormalizedTitle`, not `RawTitle`.
- `as CanonicalTitle` in `web/src/grammar/scan.ts` is still reported
  naming `CanonicalTitle` only (the existing case must keep passing).

`web/src/replica/titles.test.ts`: `asRawTitle(" a\tb ")` equals the input.

- [ ] **Step 2: Run them; they fail** (`cd server && uv run pytest
  tests/test_title_brands.py -q`: ImportError; `cd web && pnpm vitest run
  tooling/lintConfig.test.ts src/replica/titles.test.ts`: no `RawTitle`).

- [ ] **Step 3: Implement the files above.** On the server, a
  `NormalizedTitle(x)` now needs `x: RawTitle`; in `refs.py` wrap with
  `RawTitle(...)` where a plain `str` is normalized.

- [ ] **Step 4: Regenerate the artifacts; run the gates.**
  `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff
  check`; `cd web && pnpm typecheck && pnpm lint && pnpm test:unit`.
  Expected: all pass, no new pyrefly errors.

- [ ] **Step 5: Commit** (`feat: RawTitle brand atop the title hierarchy`).

---

### Task 2: Raw titles on the wire

**Files:**
- Modify: `server/src/pkm/contracts/ops.py`: `page_title` of `CreateOp`,
  `CreatePageOp` (`RawTitle`), `UpdateTextOp`, `MoveOp` (`RawTitle | None`);
  keep every `Field(...)` constraint.
- Modify: `server/src/pkm/server/routes_pages.py`: `CreatePageRequest.title`,
  `RenamePageRequest.new_title` → `RawTitle`;
  `server/src/pkm/server/routes_sidebar.py`: `AddSidebarEntryRequest.title`
  → `RawTitle`.
- Modify: `server/src/pkm/contracts/responses.py`:
  `DeleteBlockerModel.page_title` → `CanonicalTitle`; trace its builder so
  the value it is given is already canonical (it is, per the survey; if the
  builder holds a `str`, type the builder's source rather than casting).
- Regenerate `openapi.json` and `types.d.ts`.
- Modify (web fallout): every place `tsc` now rejects. Type the value at its
  origin: an input box's text, a URL segment (`titleFromPathname` returns
  `RawTitle`), a typed query. Where a caller already holds a
  `NormalizedTitle` or `CanonicalTitle`, it passes as is. Intermediate
  parameters along the path change from `string` to `RawTitle` (or the
  narrower kind they really hold).
- Test: `server/tests/test_title_brands.py`; the existing route tests.

**Interfaces:**
- Consumes: Task 1's brands and `asRawTitle`.
- Produces: `titleFromPathname(pathname: string): RawTitle` in
  `web/src/paths.ts`; generated request types carrying `Brands.RawTitle`.

- [ ] **Step 1: Write the failing tests**

In `server/tests/test_title_brands.py`:
- `test_raw_title_request_fields_are_branded`: for `CreatePageRequest`
  (`title`), `RenamePageRequest` (`new_title`), `AddSidebarEntryRequest`
  (`title`), `CreateOp`/`CreatePageOp`/`UpdateTextOp`/`MoveOp`
  (`page_title`), the field's schema (through `anyOf` for the optional
  ones) has `x-brand == "RawTitle"`.
- `test_empty_raw_title_is_still_rejected`: `CreatePageRequest(title="")`
  and `CreateOp(..., page_title="")` raise `ValidationError`.
- `test_delete_blocker_page_title_is_canonical`: its schema `x-brand` is
  `"CanonicalTitle"`.

- [ ] **Step 2: Run; the brand tests fail, the empty-title test passes.**

- [ ] **Step 3: Retype the fields; regenerate; fix the web fallout** as
  described under Files.

- [ ] **Step 4: Run the gates** (as Task 1 Step 4, plus `pnpm verify` once
  at the end of the task: request-building code has e2e coverage).

- [ ] **Step 5: Commit** (`feat: raw titles on the wire are RawTitle`).

---

### Task 3: Server sites for the branch-1 names

The NAMES additions are made locally to find the sites and are **not**
committed in this task (the web side would fail until Task 4); Task 5
commits them.

**Names (from the spec):** `raw_title` → RawTitle; `ref_title`,
`normalized_title` → NormalizedTitle; `canonical_title`, `daily_title`,
`src_page_title` → CanonicalTitle; `page_title`, `new_title`, `old_title` →
RawTitle, NormalizedTitle or CanonicalTitle.

**Files:**
- Modify: every file under `server/src` and `server/tests` that
  `PYTHONPATH=server/tooling python3 -m commentlint.run --all` (brandlint
  runs inside it) reports once the names are added locally to `NAMES`.
- Modify: `server/src/pkm/server/ops_core.py` `BlockRewrite`: rename
  `old_title`/`new_title` to `old_text`/`new_text` (they hold a block uid
  or text for `inline`, `""` for `unlink`), and every use.
- Modify: `server/src/pkm/brand_registry.py` `COLUMN_KEYS["block_rewrites"]`:
  `"old_title": "rewrite_old_text"`, `"new_title": "rewrite_new_text"`; every
  SELECT of those columns reads under the alias. Regenerate
  `columns.gen.ts`/`brandRegistry.gen.json`. (This part is committed: it
  does not depend on NAMES.)
- Test: existing suites; `server/tests/test_brandlint_names.py` gains the
  teeth cases in Task 5.

**How to type each site.** Read where the value comes from, not the name.
The survey (`survey-server.md`, summarised in the spec) lists each site's
kind, but treat it as a lead, not a verdict. A `page_title: str` that holds
the stored spelling becomes `CanonicalTitle`. An op's hint stays `RawTitle`.
`rename.py`'s titles, called with canonical values from the store and
normalized ones from the importer, become `NormalizedTitle`. A test's
untyped `page_title` parameter gets the kind its test passes, built with
`canonical_title_of`/`raw_title_of`.

- [ ] **Step 1: Add the names locally; list the violations.** Save the
  count per file to the task's report file.
- [ ] **Step 2: Rename `BlockRewrite`'s fields and alias the columns.** Run
  `uv run pytest -q`; the row check must stay green. Grep every
  `FROM block_rewrites` / `JOIN block_rewrites` SELECT and name in the report
  the test that exercises each one.
- [ ] **Step 3: Convert the sites**, file by file; `pyrefly check` after
  each file.
- [ ] **Step 4: With the local names in place, brandlint reports 0;
  revert the NAMES edit; run** `uv run pytest -q && uv run pyrefly check
  && uv run ruff check`. Expected: all pass.
- [ ] **Step 5: Commit** (`refactor: server titles carry their kind`),
  without the NAMES edit.

---

### Task 4: Web sites for the branch-1 names

The same, on `web/src` (including tests and test support). The camelCase
names are derived: `rawTitle`, `refTitle`, `normalizedTitle`,
`canonicalTitle`, `dailyTitle`, `srcPageTitle`, `pageTitle`, `newTitle`,
`oldTitle`.

Note: `canonicalTitle` and `dailyTitle` are also function names in
`replica/meta.ts` and `replica/daily.ts`. The name rule checks parameters
and members, not function names, so only a parameter or property so named
is affected.

**Files:**
- Modify: every file `pnpm lint` reports once the names are added locally
  to `NAMES` and `brandRegistry.gen.json` is regenerated locally.
- Test: existing suites.

**How to type each site.** As Task 3. From the survey: `pageTitle` in
`tree.ts`, `history.ts`, `baseTextHash.ts`, `outlineState`'s pending ops,
`BlockDragSource`, `DropTarget.page_title` and `filesCore` hold a
`CanonicalTitle`; `linkUnlinkedReference`'s `canonicalTitle` parameter is
canonical; `newTitle` in `PageTitle` and `SidebarNav` is typed text
(`RawTitle`, minted where the input's value is read).

- [ ] **Step 1: Add the names locally, regenerate, list the violations** to
  the report file.
- [ ] **Step 2: Convert the sites**, running `pnpm typecheck` as you go.
- [ ] **Step 3: With the local names, `pnpm lint` reports 0; revert the
  local registry edits; run** `pnpm verify`. Expected: pass.
- [ ] **Step 4: Commit** (`refactor: web titles carry their kind`).

---

### Task 5: Register the names

**Files:**
- Modify: `server/src/pkm/brand_registry.py` `NAMES`: the branch-1 names
  above, grouped under a `# Titles` comment saying the wire-shared names
  accept any title brand and the internal names one kind.
- Regenerate `brandRegistry.gen.json`.
- Test: `server/tests/test_brandlint_names.py`: `page_title: str` reported;
  `page_title: RawTitle | None` accepted; `ref_title: CanonicalTitle`
  reported (a kind-specific name takes only its brand);
  `canonical_title: CanonicalTitle` accepted. `web/tooling/lintConfig.test.ts`
  (or a new `eslint-fixtures/brand-name-titles.ts`): `pageTitle: string`
  reported, `pageTitle: NormalizedTitle` accepted, `rawTitle:
  CanonicalTitle` reported.
- Docs: `docs/architecture/enforced-checks.md`: if it enumerates NAMES or
  counts names, update it; grep for counts.

- [ ] **Step 1: Write the teeth tests; they fail** (names not registered).
- [ ] **Step 2: Register; regenerate.**
- [ ] **Step 3: Run everything:** `cd server && uv run pytest -q && uv run
  pyrefly check && uv run ruff check`; `cd web && pnpm verify`. Expected:
  pass with no new violations (Tasks 3 and 4 converted them).
- [ ] **Step 4: Commit** (`feat: brand check registers the title names`).

---

### Task 6: Branch-end checks

- [ ] `perf/check.sh` (the BlockRewrite rename and aliased SELECTs touch
  server SQL text); handle per AGENTS.md.
- [ ] `proptest/check.sh server` (ops and planning signatures changed).
- [ ] Update pkm-hc95: branch 1 done, branch 2 next; commit the bean.
- [ ] Whole-branch review on the strongest model, with the perf table and
  the Review Focus list.
