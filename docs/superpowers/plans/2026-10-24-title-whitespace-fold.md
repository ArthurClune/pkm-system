# Title Whitespace Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A page title's whitespace runs fold to one U+0020 at creation and at
lookup, on the server and the replica alike, so a lookup key can no longer
reach a different page than the one its spelling names (bean pkm-ak4e).

**Architecture:** One explicit character list, `TITLE_WHITESPACE` in
`server/src/pkm/contracts/titles.py`, is the whitespace set. The web gets it as
a generated constant (`web/src/grammar/titleWhitespace.gen.ts`), guarded like
`baseSchema.gen.ts`. `refs.normalize_title` and the web's `normalizeRefTitle`
fold every run of it; every title path already funnels through those two, so
creation, lookup, ref extraction, the importer and the CLI/MCP client all
follow. The one-time title migration then groups pages that now share a
spelling, may run again on an already-active database that holds such pages,
and a startup check logs any stored title the live rule no longer leaves
unchanged.

**Tech Stack:** Python 3 / FastAPI / SQLite (server), TypeScript / Vite /
vitest / fast-check (web), Hypothesis (server properties).

**Spec:** `docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md`,
row pkm-ak4e. The finding: `docs/security-review-2026-10-23.md` § "Low: a
title with control whitespace resolves to a different page".

## Global Constraints

- Spec, verbatim: "A title's whitespace runs fold to one plain space at page
  creation and at lookup: U+0020, control whitespace and NBSP (U+00A0) alike.
  Other Unicode space characters fold too."
- Spec, verbatim: "The whitespace set is one explicit character list shared by
  server and web, not either language's `\s`."
- Spec, verbatim: "The title migration groups pages that now share a spelling
  (imports); a database already migrated under the old rule gets a startup
  check for titles that are no longer canonical."
- Spec, verbatim: "Title proptest gate required."
- The plan never touches prod data. Prod's three NBSP titles are renamed by
  the orchestrator through the API before deploy; prod has no title or link
  with a double space or control whitespace.
- Worktree `/Users/arthur/code/llm/pkm/.claude/worktrees/ak4e`, branch
  `security/ak4e`. Run every command from it; absolute paths. Stage by
  explicit path, never `git add -A` (`web/node_modules` is untracked there).
- FCIS header on every new file with runtime behaviour; comments carry no bean
  ids, line numbers or spec nicknames; comment lines at most 80 columns, code
  at most 120. Never write "load-bearing".
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context)
  <noreply@anthropic.com>` and carry no session URL (`.githooks/commit-msg`
  rejects one).
- Gates before claiming a task done: `cd server && uv run pytest -q`,
  `uv run pyrefly check`, `uv run ruff check`; `cd web && pnpm verify` (not
  `typecheck` + `test:unit` alone). Use `set -o pipefail` when piping a gate.
- Any route docstring, response model or query param change: regenerate
  `web/src/api/openapi.json` and `types.d.ts` per `backend.md § Generated
  artifacts and parity fixtures`. `test_openapi_sync.py` says when.

### Rulings this plan makes (record them in the bean on completion)

1. **The list is Unicode's White_Space property**: U+0009-U+000D, U+0020,
   U+0085, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F,
   U+3000. Out: U+001C-U+001F (Python's `isspace` and `\s` take them; they are
   not White_Space), U+FEFF (JS `\s` takes it), U+180E, and the zero-width
   characters U+200B-U+200D. A title holding one of those stays byte-exact.
2. **The fold, flag by flag.** `normalize_title(t)`: fold every maximal run of
   `TITLE_WHITESPACE` to one U+0020; if that changed nothing, return `t`
   byte-for-byte; otherwise also strip leading and trailing U+0020. Under the
   plain-space flag, `canonicalize_title` additionally strips edge U+0020 as
   today. So with the flag on, a canonical title is its words joined by single
   spaces; with it off (fresh and test databases only: every import
   activates), a title with nothing to fold keeps its legacy single-space edge
   padding, as today. After the fold every listed character is U+0020, so the
   strip is `strip(" ")`, never a language's own `strip()`/`trim()`.
3. **Blankness and attribute-name edges keep their mirrored Python set**
   (`is_blank_title`, `stripLikePython`). Only the fold uses the new list.
   Widening blankness to the list is not in the spec.
4. **The startup check logs; it neither refuses nor repairs.** It runs in the
   app lifespan, compares each `pages.title` and `sidebar_entries.title` with
   the live `title_reader`, and logs one ERROR on logger `pkm.titles` naming
   the count, up to 20 offending titles (repr, sorted) and the remedy
   (`pkm migrate-titles`). Why not refuse: `pkm migrate-titles` is an HTTP
   call, so a server that refuses to start removes the only remedy, and
   launchd's KeepAlive turns a refusal into a crash loop. Why not repair:
   backend.md holds that startup never runs the title migration, and a merge
   is irreversible, so it stays an audited, digest-confirmed operator action.
   The exposure while such a row exists is bounded: a lookup key folds, so the
   non-canonical row is unreachable, and a key reaching its canonical twin is
   the identity the new rule defines.
5. **The audited apply runs on an active database when its audit has
   groups.** "Already active" no longer implies "canonical" once the rule
   changes, and without this the startup check would name rows nothing can
   fix (they are unreachable by key, so rename cannot touch them). Apply on an
   active database with no groups is still refused 409 "already active", so
   the existing guard against a pointless second generation rotation stands.

## Review Focus

1. **Renaming a page to a fold-equal spelling of itself** (`A B` to `A  B` or
   `A\u00a0B`): a person expects "title is unchanged" (400), not a merge with
   itself or a 409. Test: Task 1, `test_rename_to_fold_equal_title_is_unchanged`.
2. **Renaming onto a fold-twin of another page** (`Foo` to `A\u00a0B` while
   `A B` exists): expects the 409 "already exists" without `allow_merge`, and
   the merge into `A B` with it. Test: Task 1,
   `test_rename_onto_fold_twin_conflicts`.
3. **A title that is only listed whitespace** (`\u3000`, `\u00a0\u00a0`,
   `\u2028`): blank everywhere, so `POST /api/pages` answers 422, the ops path
   files it under `Untitled`, and `[[\u3000]]` is no ref. Test: Task 1,
   `test_whitespace_only_titles_are_blank`.
4. **Look-alikes outside the list** (U+200B, U+FEFF, U+001C, U+180E): not
   folded, on both sides, so `A\u200bB` is its own page and is not `A B`.
   Test: Task 1, `test_lookalikes_outside_the_list_are_not_folded` (server)
   and the matching case in `titles.test.ts` (web).
5. **An offline create with an NBSP title**: the replica must file it under
   `A B`, as the server will, or the page splits on sync. Test: Task 1, a
   case in `web/src/replica/localOps.test.ts` creating `A\u00a0B` and reading
   back the local page `A B`.

---

### Task 1: The fold rule, server and web, from one list

**Model:** opus. It changes the identity function every title path uses, on
two runtimes that must agree byte for byte; the parity and flipped-test
judgement is subtle.

**Files:**
- Modify: `server/src/pkm/contracts/titles.py` (add `TITLE_WHITESPACE`)
- Modify: `server/src/pkm/refs.py` (`_CONTROL_WS`, `_WS_RUN`,
  `normalize_title`, the `canonicalize_title` / `is_blank_title` docstrings)
- Create: `server/src/pkm/title_whitespace_dump.py` (Imperative Shell,
  modelled on `schema_dump.py`)
- Create: `web/src/grammar/titleWhitespace.gen.ts` (generated)
- Modify: `web/src/grammar/scan.ts` (`CONTROL_WS_RE`, `WS_RUN_RE`,
  `normalizeRefTitle`); `web/src/replica/titles.ts` header comment
- Modify: `server/src/pkm/title_parity_dump.py` (pieces and shapes)
- Regenerate: `shared/fixtures/title_parity.json`,
  `shared/fixtures/refs_parity.json`, and `shared/fixtures/shim_parity.json`
  if `test_shim_parity_fixture.py` reports it stale
- Create: `server/tests/test_title_whitespace_fold.py`,
  `server/tests/test_title_whitespace_artifact.py`
- Modify tests that pin the old rule (expected flips, below);
  `web/src/replica/titles.test.ts`, `web/src/replica/localOps.test.ts`,
  `web/src/App.test.tsx`

**Interfaces:**
- Produces: `pkm.contracts.titles.TITLE_WHITESPACE: str` (the 25 characters
  of ruling 1, ascending code point order).
- Produces: `pkm.title_whitespace_dump.ts_module(chars: str) -> str` and
  `main() -> int`; output starts with the same two-line GENERATED header shape
  as `schema_dump.HEADER` and exports
  `export const TITLE_WHITESPACE = "…";` with every character written as a
  `\uXXXX` escape.
- Produces: `normalize_title`, `canonicalize_title`, `normalizeRefTitle`,
  `canonicalizeTitle` with the behaviour of ruling 2; signatures unchanged.

- [ ] **Step 1: Write the red server tests in `server/tests/test_title_whitespace_fold.py`**

Build them from the probes `sec-pages/p1_titles.py` and `p1b_fold_rename.py`
(main checkout, `docs/superpowers/handoffs/security-review-2026-10-23-probes/`,
read-only). Use `conftest` fixtures (`client`, `seeded_config`) and, for
exact paths, an `httpx.ASGITransport` request as the probe's `raw()` does
(TestClient decodes percent escapes twice); `server/tests/asgi_harness.py`
may already offer one. Parametrize every route test over the flag
(`set_plain_space_title_canonicalization(con, active)` for `active` in
`(False, True)`).

```python
def test_create_folds_onto_existing_page(client, active):
    # "A  B", "A\u00a0B", "A\u3000B", "A\u2009B", "A\tB" each POSTed after
    # "A B": every response title == "A B"; one row in pages for "A B";
    # no row whose title is any of the spellings.

def test_get_both_spellings_reach_one_page(active):
    # POST "A  B" then "A B": GET /api/page/A%20%20B, /A%20%20B%0A, /A%20B
    # all 200 with the same page id and title "A B".

def test_delete_with_control_suffix_leaves_no_twin(active):
    # POST "A  B", "A B"; DELETE /api/page/A%20%20B%0A -> 200;
    # no page title folds to "A B" afterwards (today "A  B" survives).

def test_rename_with_control_suffix_renames_the_one_page(active):
    # POST "A  B", "A B"; POST /api/page/A%20%20B%09/rename
    # {"new_title": "Renamed"} -> 200; titles hold "Renamed", none folds
    # to "A B".

def test_pkm_client_rename_path(active):
    # p1b's PkmClient(CliConfig(url="http://testserver", token=cookie),
    # http=client): create "A  B" and "A B"; rename_page("A  B\n",
    # "ViaClient") -> result "renamed", title "ViaClient"; no title folds
    # to "A B" afterwards.

def test_rename_to_fold_equal_title_is_unchanged(client):
    # POST "A B"; rename to "A  B" and to "A\u00a0B" -> 400
    # "title is unchanged" each time.

def test_rename_onto_fold_twin_conflicts(client):
    # POST "A B" and "Foo"; rename Foo -> "A\u00a0B": 409; with
    # allow_merge: 200, result "merged", title "A B".

def test_whitespace_only_titles_are_blank(client):
    # "\u3000", "\u00a0\u00a0", "\u2028": POST /api/pages -> 422;
    # an ops create_page with that title lands on "Untitled";
    # extract(f"[[{t}]]").refs == ().

def test_lookalikes_outside_the_list_are_not_folded(client):
    # "A\u200bB", "A\ufeffB", "A\x1cB", "A\u180eB": normalize_title returns
    # each byte-for-byte; POST creates a page with exactly that title,
    # distinct from "A B".

def test_title_whitespace_is_unicode_white_space():
    # set(TITLE_WHITESPACE) == {chr(c) for c in range(0x110000)
    #   if chr(c).isspace()} - set("\x1c\x1d\x1e\x1f")
    # and TITLE_WHITESPACE is sorted with no duplicates.

def test_normalize_title_fold_table():
    # parametrized: (input, inactive result, active result)
    # ("A  B", "A B", "A B"), ("A\u00a0B", "A B", "A B"),
    # (" A ", " A ", "A"), ("  A", "A", "A"), ("\tA\u3000", "A", "A"),
    # ("Foo\n", "Foo", "Foo"), ("A B", "A B", "A B"), ("", "", "")
    # inactive = normalize_title / canonicalize_title(plain_space=False),
    # active = canonicalize_title(plain_space=True); idempotent on each.
```

- [ ] **Step 2: Run them and confirm they fail for the right reason**

Run: `cd server && uv run pytest -q --no-cov tests/test_title_whitespace_fold.py`
Expected: FAIL. `TITLE_WHITESPACE` import errors first; once a stub constant
exists, the route tests fail on the second page (two pages where one is
expected), and the lookalike and blank tests may already pass (guards).

- [ ] **Step 3: Add `TITLE_WHITESPACE` and fold `normalize_title` by it (ruling 2)**

Build both regexes in `refs.py` from the constant with `re.escape`, each a
single character class with one quantifier (the existing comment on
backtracking applies). Rewrite `normalize_title`'s docstring: the old
"deliberately narrow" paragraph is now false.

- [ ] **Step 4: Run the new tests; then the whole server suite**

Run: `cd server && uv run pytest -q`
Expected: the new file passes. Expected flips elsewhere, each updated to the
new rule rather than deleted, the change named in the commit message:
`test_refs.py::test_normalize_title_leaves_control_free_titles_byte_for_byte`
(`"Two  Spaces"` now folds; keep the single-space-padding cases),
`test_refs.py::test_canonicalize_title_preserves_plain_space_when_inactive_and_strips_only_plain_space_when_active`
(NBSP now folds), `test_newline_titles.py` (`"Two  Spaces"` creation),
`test_sidebar_endpoint.py` (NBSP title), every test seeding
`"\u00a0Gamma\u00a0"` or `"\u00a0Acme\u00a0"` (title-migration core,
apply, endpoint, `test_cli_main_read.py`: now grouped under `Gamma` /
`Acme`; update the expected groups and digests),
and `test_title_routes_props.py` (its generator asserts the old rule; Task 3
rewrites it, so here only make it pass with the minimum: drop NBSP from
`_GAP`). Any other failure is a finding: stop and diagnose it.

- [ ] **Step 5: Write the generator and its guard**

`server/tests/test_title_whitespace_artifact.py`: the committed
`web/src/grammar/titleWhitespace.gen.ts` equals
`ts_module(TITLE_WHITESPACE)`, and `ts_module` round-trips: every character
of its input appears as one `\uXXXX` escape. Then:

Run: `cd server && uv run python -m pkm.title_whitespace_dump > ../web/src/grammar/titleWhitespace.gen.ts && uv run pytest -q --no-cov tests/test_title_whitespace_artifact.py`
Expected: PASS.

- [ ] **Step 6: Write the red web tests**

In `web/src/replica/titles.test.ts`, under `canonicalizeTitle`, the same fold
table as Step 1 for both flag values, the lookalike cases, and:

```ts
test("the list is JS whitespace less U+FEFF plus U+0085", () => {
  // every BMP code unit c: /\s/.test(c) && c !== "\ufeff", plus "\x85",
  // equals new Set(TITLE_WHITESPACE)
});
```

In `web/src/replica/localOps.test.ts`: a local `create_page` of `A\u00a0B`
makes the replica page `A B`, and a second of `A  B` lands on the same page.
In `web/src/App.test.tsx`, beside the existing `%0A` redirect case:
`/page/A%20%20B` and `/page/A%C2%A0B` redirect to `/page/A%20B`.

Run: `cd web && pnpm vitest run src/replica/titles.test.ts src/replica/localOps.test.ts src/App.test.tsx`
Expected: FAIL on the fold cases.

- [ ] **Step 7: Mirror the fold in `grammar/scan.ts` from the generated list**

`normalizeRefTitle` builds its run regex from `TITLE_WHITESPACE` (escape each
character into a class), returns the input unchanged when the fold changes
nothing, else the folded text with edge U+0020 removed. `stripLikePython`
stays for blankness and attribute names (ruling 3). Update the `PY_SPACE`
comment and `replica/titles.ts`'s header, which still say NBSP is preserved.

- [ ] **Step 8: Widen the parity corpus and regenerate the fixtures**

In `title_parity_dump.py`, add a piece for every `TITLE_WHITESPACE` character
not already drawn (the excluded look-alikes U+200B, U+FEFF and U+001C are
already pieces; keep them), and shapes `"internal_space_run"` (two adjacent U+0020 strictly inside) and
`"listed_space_inside"` (a non-U+0020 listed character strictly inside).
`test_title_parity_fixture.py` must assert both shapes have a nonzero tally.

Run: `cd server && uv run python -m pkm.title_parity_dump > ../shared/fixtures/title_parity.json && uv run python -m pkm.refs_parity_dump > ../shared/fixtures/refs_parity.json`
then, only if `uv run pytest -q --no-cov tests/test_shim_parity_fixture.py`
fails as stale, `uv run python -m pkm.server.shim_parity_dump > ../shared/fixtures/shim_parity.json`.

- [ ] **Step 9: Run every gate**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
then `cd web && set -o pipefail && pnpm verify 2>&1 | tail -40`
Expected: all green. A web test pinning NBSP preservation (search
`web/src` for `\u00a0` and `\xa0` in tests) is an expected flip; update it
like Step 4.

- [ ] **Step 10: Commit**

```bash
git add server/src/pkm/contracts/titles.py server/src/pkm/refs.py \
  server/src/pkm/title_whitespace_dump.py server/src/pkm/title_parity_dump.py \
  web/src/grammar/titleWhitespace.gen.ts web/src/grammar/scan.ts \
  web/src/replica/titles.ts shared/fixtures/title_parity.json \
  shared/fixtures/refs_parity.json server/tests/test_title_whitespace_fold.py \
  server/tests/test_title_whitespace_artifact.py <each updated test file>
git commit -m "fix: fold title whitespace runs to one space on server and replica"
```

---

### Task 2: Pages that now share a spelling: migration, re-apply, startup check

**Model:** opus. Migration and merge semantics, a reversed guard, and a
startup behaviour with an availability trade-off.

**Files:**
- Modify: `server/src/pkm/title_migration.py` (rename `padded_groups` to
  `fold_groups`; add `noncanonical_titles`)
- Modify: `server/src/pkm/server/title_migration.py` (`apply_title_migration`
  guard; add `report_noncanonical_titles`)
- Modify: `server/src/pkm/server/app.py` (`_lifespan`)
- Modify: `server/src/pkm/render.py` (`_title_migration_state`)
- Modify: `server/src/pkm/server/routes_migrations.py` only if a docstring
  states the old refusal (then regenerate openapi.json)
- Test: `server/tests/test_title_migration_core.py`,
  `server/tests/test_title_migration.py`,
  `server/tests/test_title_migration_endpoint.py`,
  `server/tests/test_importer_e2e.py`, new
  `server/tests/test_noncanonical_titles_check.py`

**Interfaces:**
- Consumes: Task 1's `normalize_title` / `target_canonical_title`.
- Produces: `pkm.title_migration.noncanonical_titles(titles: Iterable[str],
  canonical: Callable[[str], str]) -> tuple[str, ...]` (sorted, distinct,
  those where `canonical(t) != t`).
- Produces: `pkm.server.title_migration.report_noncanonical_titles(db_path:
  Path) -> int` (opens its own connection, reads `pages.title` and
  `sidebar_entries.title`, uses `title_reader(db)`, logs one ERROR on
  `logging.getLogger("pkm.titles")` when the count is nonzero, returns the
  count).
- Produces: `_title_migration_state` strings `"active"` (active, no groups),
  `"active, ready"`, `"active, blocked"`, and the existing three.

- [ ] **Step 1: Write the red tests**

```python
# test_title_migration_core.py
def test_plan_groups_pages_that_fold_to_one_spelling():
    # pages "A B"(1), "A  B"(2), "A\u00a0B"(3), "Lone\u3000Page"(4):
    # one group "A B" survivor page 1 has_clean_twin, sources (2, 3);
    # one group "Lone Page" survivor 4, no clean twin;
    # replacements {"A  B": "A B", "A\u00a0B": "A B",
    #               "Lone\u3000Page": "Lone Page"}.

def test_noncanonical_titles_lists_only_changed_titles():
    # noncanonical_titles(["A B", "A  B", " P "], reader(active=True))
    #   == ("A  B", " P ")
    # with reader(active=False) == ("A  B",)

# test_title_migration.py (raw-SQL legacy rows, as _seed_migration_graph does)
def test_apply_on_active_database_merges_fold_twins():
    # flag '1'; pages "A B" with block b1, legacy "A  B" with block b2;
    # block b3 on another page "see [[A  B]]" indexed to "A  B".
    # audit -> one group; apply(digest) succeeds: one page "A B" holding
    # b1 then b2, b3 text "see [[A B]]", flag still active, generation
    # rotated.

# replaces test_apply_rejects_already_active_database_without_rotation
def test_apply_rejects_active_database_with_nothing_to_do():
    # flag '1', every title canonical: apply raises
    # AlreadyActiveTitleMigration and _state(db) is unchanged.

# test_title_migration_endpoint.py: the already-active 409 test seeds a
# canonical graph; a new test posts the digest for an active database with
# a fold twin and gets 200 with groups_applied == 1.

# test_importer_e2e.py
def test_import_merges_pages_that_fold_to_one_title():
    # an export with pages "A B", "A  B", "A\u00a0B" and a block linking
    # [[A\tB]]: rc 0; one page "A B" holding all their blocks; the
    # linking block's refs row targets that page; title_changes record
    # the merged spellings with merged=True.

# test_noncanonical_titles_check.py
def test_startup_logs_noncanonical_titles(caplog):
    # seeded db, flag '1', raw-SQL page "A\u00a0B" and sidebar entry
    # "X  Y": `with TestClient(create_app(cfg)):` -> one ERROR record on
    # "pkm.titles" whose message holds the count 2, both titles' repr and
    # "pkm migrate-titles"; the app still answers GET /api/pages 200.

def test_startup_is_silent_on_a_canonical_database(caplog):
    # conftest seed: no "pkm.titles" record at all.

def test_inactive_database_keeps_legacy_padding_quiet(caplog):
    # flag '0', raw-SQL page " Padded ": no record (a fixed point of the
    # inactive rule); page "Two  Spaces": reported.
```

- [ ] **Step 2: Run them; confirm the failures**

Run: `cd server && uv run pytest -q --no-cov tests/test_title_migration_core.py tests/test_title_migration.py tests/test_title_migration_endpoint.py tests/test_importer_e2e.py tests/test_noncanonical_titles_check.py`
Expected: FAIL on the active re-apply (AlreadyActive raised), the new check
(no such function), and `noncanonical_titles`. The grouping and importer
tests may already pass after Task 1; keep them as guards.

- [ ] **Step 3: Implement**

Apply guard: raise `AlreadyActiveTitleMigration` only when `plan.active and
not plan.groups`; stale-digest and blocker checks keep their order before it.
`_lifespan` calls `report_noncanonical_titles(app.state.config.db_path)`
before `yield`, after uvicorn has configured logging (which is why it is not
in `create_app`). Bound the logged sample at 20 titles in code.

- [ ] **Step 4: Run the server gates**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: green. If `test_openapi_sync.py` fails, regenerate:
`uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json`,
then `cd web && pnpm gen-types`, and include both files in the commit.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/title_migration.py server/src/pkm/server/title_migration.py \
  server/src/pkm/server/app.py server/src/pkm/render.py \
  server/tests/test_title_migration_core.py server/tests/test_title_migration.py \
  server/tests/test_title_migration_endpoint.py server/tests/test_importer_e2e.py \
  server/tests/test_noncanonical_titles_check.py
git commit -m "fix: group fold twins in the title migration; log non-canonical titles at startup"
```

---

### Task 3: Title properties reach the fold and have teeth

**Model:** opus. Property design, reach and mutant judgement.

**Files:**
- Modify: `server/tests/test_title_routes_props.py`
- Modify: `web/src/outline/titleKeys.props.test.tsx`

**Interfaces:**
- Consumes: `TITLE_WHITESPACE` (server) and the generated web constant.

- [ ] **Step 1: Rewrite the server generator from the documented rule**

`tidy_titles` joins words with one U+0020 only (an NBSP gap is no longer
canonical). Replace the `nbsp` family with a variant kind `fold`: each gap
widened into a run drawn from `TITLE_WHITESPACE` (at least one non-U+0020
character or a doubled U+0020, so the inactive rule folds it), with edges
drawn from the same list. Run `fold` under both flags; keep `padded` and
`padded_control` under the flag. The generator keeps its own
`canonicalize_title` assertion. Labels, each added to `ROUTE_LABELS` and
`CLI_LABELS` so `assert_reach` requires it: `"NBSP in the variant"`,
`"non-Latin space in the variant"` (any of U+1680, U+2000-U+200A, U+202F,
U+205F, U+3000), `"line separator in the variant"` (U+0085, U+2028,
U+2029), `"doubled space in the variant"`. Update `ROUTE_BUDGET` /
`CLI_BUDGET` keys to the new family names and the module docstring.

- [ ] **Step 2: The same widening on the web**

`titleKeys.props.test.tsx` draws its variants from the generated
`TITLE_WHITESPACE` the same way, and counts the same four labels in a tally
it asserts nonzero after the run.

- [ ] **Step 3: Show reach**

Run: `cd server && uv run pytest -q --no-cov tests/test_title_routes_props.py --hypothesis-show-statistics`
and `cd web && pnpm vitest run src/outline/titleKeys.props.test.tsx`
Expected: PASS; each new label reached; note the rates for the review.

- [ ] **Step 4: Show teeth (do not commit the mutants)**

Mutant A: remove `"\u00a0"` from `TITLE_WHITESPACE` in `contracts/titles.py`
only (do not regenerate the web constant). Expected: the server property
fails on an NBSP variant, and `test_title_whitespace_artifact.py` fails.
Mutant B: in `scan.ts`, return the input unchanged when it holds no control
character (the old trigger). Expected: `titleKeys.props.test.tsx` and
`titleParity.test.ts` fail. Revert each with `git checkout -- <file>` and
record both outcomes in the commit message.

- [ ] **Step 5: Run the property gate**

Run: `proptest/check.sh server` then `proptest/check.sh web` (serial, on a
quiet machine).
Expected: both pass. A failure follows AGENTS.md: a product bug is fixed with
the shrunk example as a unit test on its side; a flaky property gets a bean
against the gate.

- [ ] **Step 6: Commit**

```bash
git add server/tests/test_title_routes_props.py web/src/outline/titleKeys.props.test.tsx
git commit -m "test: title properties draw every listed whitespace character"
```

---

### Task 4: Docs and the merge gates

**Model:** opus. The docs must state the invariants the code cannot (why the
list is explicit, why the check logs), verified against the shipped code.

**Files:**
- Modify: `docs/architecture/backend.md` (§ Title integrity and one-time
  activation; § Generated artifacts and parity fixtures; § Ref grammar if it
  states the old fold)
- Modify: `docs/architecture/sync-and-offline.md` (§ Title activation across
  online and offline paths: "Whitespace means Python's" is now false for the
  fold)
- Modify: `docs/cli.md` (§ One-time title canonicalization: the apply refusal
  condition and "What the title rules are")
- Modify: `docs/troubleshooting.md` (one row)

- [ ] **Step 1: Invoke the `architecture-docs` skill, then edit**

backend.md: replace the flag table's rows with ruling 2's two layers; one
sentence naming `contracts/titles.TITLE_WHITESPACE` as the set and why it is
explicit (Python's `\s` adds U+001C-U+001F, JS's adds U+FEFF and drops
U+0085, so either would split a page between server and replica); one
sentence on the startup check with ruling 4's reason; amend "Apply … answers
409 to … an active flag" to ruling 5. Generated-artifacts table: one row for
`web/src/grammar/titleWhitespace.gen.ts` (regenerate with
`uv run python -m pkm.title_whitespace_dump > ../web/src/grammar/titleWhitespace.gen.ts`;
guarded by `test_title_whitespace_artifact.py` and the `titles.test.ts` list
case; pins `TITLE_WHITESPACE`). Grep `docs/architecture` and `docs/cli.md`
for `NBSP`, `control whitespace`, `Internal spaces` and fix each claim the
fold made false. No counts of characters in prose: name the constant.

- [ ] **Step 2: Troubleshooting row**

Under `### Titles and the ref grammar` in `docs/troubleshooting.md`: symptom "`GET`, `DELETE`
or `rename` on `/api/page/A%20%20B%0A` (or `PkmClient.rename_page("A  B\n")`)
acts on page `A B` while a page `A  B` exists"; cause "the fold ran only when
a control character was present, so `A  B` and `A B` were distinct titles yet
one key reached both; every listed whitespace run now folds at creation and
lookup"; owner `backend.md § Title integrity and one-time activation`; bean
`pkm-ak4e`.

- [ ] **Step 3: Check the docs**

Run: `node .claude/skills/architecture-docs/check-docs.mjs` and
`PYTHONPATH=server/tooling python3 -m commentlint.run --all`
Expected: clean.

- [ ] **Step 4: Merge gates on the finished branch**

Run, serially: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`;
`cd web && set -o pipefail && pnpm verify`; `perf/check.sh` (no
`--allow-busy`). A regression: read the diff along the regressed path
(`normalize_title` runs per ref in extraction, so a VM-work or timing change
on ingest or ops paths is the likely spot), fix and re-run; bring it to
Arthur only if it survives. Keep the perf table for the review package.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/backend.md docs/architecture/sync-and-offline.md \
  docs/cli.md docs/troubleshooting.md
git commit -m "docs: title whitespace fold, its shared list and the startup check"
```
