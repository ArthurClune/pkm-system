# Tables and Queries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Query results shown as a filterable, sortable, editable table of each
result's `::` attributes, and plain `{{table}}` blocks with the same filter,
sort, editing and "+ New row", with views saved as options in the macro text.

**Architecture:** The server gains a records route that maps each query
result to its record (a page or a line) and returns that record's `::`
blocks keyed by attribute page. A Python/TS pair of option parsers, kept in
step by a parity fixture, splits ` | name: value` options off both macros.
The web side builds pure cores (filter, sort, view state, cell editor,
write planning) under `web/src/tables/`, and two shells use them:
`QueryBlock` writes through the op queue, and `RoamTable` writes through new
outline handlers, so table edits join undo history.

**Tech Stack:** FastAPI, Pydantic, SQLite (server); React, TypeScript,
vitest, fast-check, Playwright (web).

**Spec:** `docs/superpowers/specs/2026-11-15-tables-and-queries-design.md`
(bean pkm-l79g). Read it before any task; this plan argues from it.

## Global Constraints

- Work in a worktree on branch `feat/tables-and-queries`. Create task beans in
  that worktree, as children of pkm-l79g (`beans create … --parent pkm-l79g`).
- Every cell editor is a one-line `<textarea>`, never an `<input>`: iPad
  Safari never delivers Tab to an `<input>`.
- Viewing never writes. Only a cell commit, "+ New row" and "Save this view"
  write.
- Sorting never reorders blocks.
- No silent truncation: every record is a row, and the count reads
  `N of M results` (queries) or `N of M rows` (tables).
- Queries stay online-only. Offline, or in a read-only surface (sidebar
  panel, no `BlockEditContext`), cells are not editable and Save is hidden.
- Option syntax is ` | name: value` after the expression or bare `table`.
  Names: `view` (`table` | `cards` | `blocks`), `filter`, `sort`
  (`<column> asc|desc`), `columns` (comma-separated). `view` and `columns`
  are for queries only.
- A saved view adds no pages and no refs (see Task 3 for how).
- FCIS header on every new file (`// pattern: Functional Core` /
  `# pattern: Functional Core`, or Imperative Shell). Comments: no bean ids,
  no line numbers, 80 columns.
- Any route, model or docstring change regenerates `web/src/api/openapi.json`
  per backend.md § Generated artifacts and parity fixtures.
- Web verification is `cd web && pnpm verify`, never typecheck plus unit
  alone. Server: `cd server && uv run pytest -q && uv run pyrefly check &&
  uv run ruff check`.
- `web/node_modules` in the worktree is a symlink: stage by explicit path,
  never `pnpm install`.
- New e2e specs import `test` from `web/e2e/ownPage.ts`. Give spec runs their
  own `E2E_PORT` when another session is running specs.

## Review Focus

1. **A value edited elsewhere since the table loaded.** The write must be
   stamped with the loaded text's hash, so the existing conflict rules keep
   both texts rather than silently overwriting. Pinned in Task 9.
2. **A query with hundreds of records** (e.g. `{and: [[Paper]]}`). Every
   record comes back as a row with a bounded number of statements. Pinned in
   Task 6.
3. **Saving a filter that contains `[[`, `#`, `|` or braces.** Save refuses
   with a message and the block text is unchanged. Pinned in Tasks 3 and 12.
4. **Read-only and offline surfaces.** No editor opens and nothing is
   enqueued. Pinned in Task 12.
5. **Multi-line values, and `::` blocks with children.** Shift-Enter keeps
   newlines, and a commit leaves children alone. Pinned in Tasks 9 and 11.

---

## Phase A: Blocks-view breadcrumbs (shippable alone)

### Task 1: `/api/query` items carry their ancestors

**Files:**
- Create: `server/src/pkm/server/ancestors_db.py` (Shell)
- Modify: `server/src/pkm/server/routes_pages.py` (move `_fetch_ancestors`
  out; import it back)
- Modify: `server/src/pkm/contracts/responses.py`,
  `server/src/pkm/server/grouping.py`, `server/src/pkm/server/routes_search.py`
- Test: `server/tests/test_query.py`, `server/tests/test_grouping.py`

**Interfaces:**
- Produces: `fetch_ancestors(db: Db, uids: list[BlockUid]) -> Ancestors`.
- Produces: models `QueryItem(GroupItem)` with `ancestors: list[int]`
  (indices into the group's lists, omitted when empty, the same convention
  as `BacklinkItem`), and `QueryGroup(BlockGroup)` with
  `ancestor_texts: list[str]` and `ancestor_uids: list[BlockUid]` (aligned,
  both omitted when empty). `QueryPayload.groups: list[QueryGroup]`.
- Produces: `group_query_results(rows, ancestors) -> list[QueryGroup]` in
  `grouping.py`.

- [ ] **Step 1: Write the failing tests**

`test_query.py::test_query_item_carries_parent_line`: seed, via `/api/ops`, a
page "Reading" holding a top-level block "Some Paper" whose child is
`Tags:: #Paper`. Query `{and: [[Paper]]}`. Assert that the group for
"Reading" has an item whose `text` starts `Tags::`, whose `ancestors ==
[0]`, and whose group has `ancestor_texts == ["Some Paper"]` and
`ancestor_uids == [<uid of Some Paper>]`.

`test_query.py::test_top_level_result_has_no_ancestor_fields`: a top-level
`Tags:: #Paper` result's JSON item has no `ancestors` key, and its group has
no `ancestor_texts` key.

`test_grouping.py::test_group_query_results_dedupes_shared_ancestors`: two
items under the same parent share one `ancestor_texts` entry.

- [ ] **Step 2: Run them, and confirm they fail**

Run: `cd server && uv run pytest -q tests/test_query.py tests/test_grouping.py -k "ancestor"`
Expected: FAIL (fields missing).

- [ ] **Step 3: Implement**

Move `_fetch_ancestors` unchanged to `ancestors_db.fetch_ancestors`. The
query route fetches ancestors for `matches.rows` uids and calls
`group_query_results`, which mirrors `group_backlinks` but keeps
`page_id`/`page_title` keys and adds `ancestor_uids`.

- [ ] **Step 4: Run the tests, and confirm they pass**

Run: `cd server && uv run pytest -q`
Expected: PASS.

- [ ] **Step 5: Regenerate openapi, add the backend.md row, and commit**

Regenerate `web/src/api/openapi.json` (and `types.d.ts`) per the generated
artifacts table. Amend the `/api/query` row in backend.md's API table to say
that items carry ancestors.

```bash
git add server/src/pkm/server/ancestors_db.py server/src/pkm/server/routes_pages.py \
  server/src/pkm/contracts/responses.py server/src/pkm/server/grouping.py \
  server/src/pkm/server/routes_search.py server/tests/test_query.py \
  server/tests/test_grouping.py web/src/api/openapi.json web/src/api/types.d.ts \
  docs/architecture/backend.md
git commit -m "feat(query): results carry their parent lines"
```

### Task 2: Blocks view shows a nested result's parent line

**Files:**
- Modify: `web/src/components/QueryBlock.tsx`
- Test: `web/src/components/QueryBlock.test.tsx`

**Interfaces:**
- Consumes: `QueryGroup`/`QueryItem` from Task 1.

- [ ] **Step 1: Write the failing test**

`QueryBlock.test.tsx`, "a nested result shows its parent line as a link":
stub `/api/query` with a group holding an item with `ancestors: [0]`,
`ancestor_texts: ["Some Paper"]` and `ancestor_uids: ["abcdef123"]`. Assert a
`.query-crumb` with text "Some Paper" renders before the item. Clicking it
navigates to `/page/<title>#abcdef123` (use `MemoryRouter` and a location
probe).

- [ ] **Step 2: Run it, and confirm it fails**

Run: `cd web && pnpm vitest run src/components/QueryBlock.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Render each item's crumbs (joined `›`, the backlinks idiom) as
`<a className="query-crumb">`. A click calls
`navigate(\`${pagePath(title)}#${uid}\`)`, and shift-click opens the
sidebar, as `BlockRef` does.

- [ ] **Step 4: Run `pnpm verify`, and confirm it passes**

- [ ] **Step 5: Commit**

Phase A can merge to `main` here; the rest of the branch continues.

---

## Phase B: Macro options

### Task 3: Python option parser, parity fixture and server stripping

**Files:**
- Create: `server/src/pkm/macro_options.py` (Core)
- Create: `server/src/pkm/macro_options_parity_dump.py`,
  `shared/fixtures/macro_options_parity.json`
- Modify: `server/src/pkm/regen.py` (add a `Step`),
  `server/src/pkm/export/resolve.py` (`find_query_macros` returns the expression
  without options), `docs/architecture/backend.md` (a generated-artifacts row)
- Test: `server/tests/test_macro_options.py`,
  `server/tests/test_macro_options_parity_fixture.py`,
  `server/tests/test_export_resolve.py`

**Interfaces:**
- Produces:
  ```python
  @dataclass(frozen=True)
  class MacroOptions:
      view: Literal["table", "cards", "blocks"] | None = None
      filter: str | None = None
      sort: tuple[str, Literal["asc", "desc"]] | None = None
      columns: tuple[str, ...] | None = None

  def split_macro_options(body: str) -> tuple[str, MacroOptions]
  def format_macro_options(opts: MacroOptions) -> str   # "" or " | view: …"
  def options_refusal(opts: MacroOptions) -> str | None
  ```
- Produces: the fixture shape `{"cases": [{"body": str, "head": str,
  "options": {...}, "formatted": str}]}`, which Task 4 replays.

Why `options_refusal` and not ref-aware extraction: `refs.extract` and its
TS twin scan the whole macro, so `[[x]]` in an option would become a ref.
Teaching both extractors about options would change the ref grammar and its
fixtures. Refusing ref syntax in options at Save keeps the anti-goal (a
saved view adds no refs) with no grammar change.

- [ ] **Step 1: Write the failing tests**

`test_macro_options.py`:
- `test_split_query_body`:
  `split_macro_options("{and: [[Book]]} | view: table | filter: -status:read | sort: Published desc | columns: Author, Reading Status")`
  returns `("{and: [[Book]]}", MacroOptions(view="table",
  filter="-status:read", sort=("Published", "desc"), columns=("Author",
  "Reading Status")))`.
- `test_split_bare_table`: `split_macro_options("table | sort: Cache hit asc")`
  returns `("table", MacroOptions(sort=("Cache hit", "asc")))`.
- `test_no_options`: `("{and: [[A]]}", MacroOptions())`.
- `test_unknown_option_ignored`: `" | colour: red"` is dropped, not an
  error, because a hand-typo must not break the query.
- `test_round_trip`: for each case,
  `split_macro_options(head + format_macro_options(opts)) == (head, opts)`.
- `test_refusal`: `options_refusal(MacroOptions(filter="[[x]]"))`, and the same
  for `#x`, `a|b`, `}` and `{`, each returns a message naming the character.
  Clean options return `None`.

`test_export_resolve.py::test_query_macro_with_options_resolves`:
`find_query_macros("{{query: {and: [[AI]]} | view: table}}")` yields the
expression `{and: [[AI]]}`.

- [ ] **Step 2: Run them, and confirm they fail**

Run: `cd server && uv run pytest -q tests/test_macro_options.py tests/test_export_resolve.py`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Split on ` | ` only at brace depth 0. An option is `name: value`, with the
name lower-cased and the value trimmed. `sort`'s last word must be `asc` or
`desc`, otherwise the option is ignored.

- [ ] **Step 4: Add the parity dump and its `Step`, generate the fixture, and add the fixture test**

Follow the `mime_parity_dump.py` template: `fixture()` builds about twelve
cases, covering both macro heads, every option, odd spacing and an unknown
option. The fixture test asserts the file equals `fixture()`.

- [ ] **Step 5: Run `uv run pytest -q`, and confirm it passes; this includes `test_regen.py`**

- [ ] **Step 6: Commit**

### Task 4: TS option parser, tokenizer and table macro

**Files:**
- Create: `web/src/grammar/macroOptions.ts` (Core),
  `web/src/grammar/macroOptions.test.ts`,
  `web/src/grammar/macroOptions.props.test.ts`
- Modify: `web/src/grammar/tokenize.ts` (query segment),
  `web/src/outline/roamTableRows.ts` (`TABLE_MACRO`),
  `web/src/props/outline/visibleTree.ts` (`isMacro`),
  `web/src/components/QueryBlock.tsx` (send `expr` without options)
- Test: `web/src/grammar/tokenize.test.ts`,
  `web/src/outline/roamTableRows.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MacroOptions { view?: "table"|"cards"|"blocks"; filter?: string;
    sort?: { col: string; dir: "asc"|"desc" }; columns?: string[] }
  export function splitMacroOptions(body: string): { head: string; options: MacroOptions }
  export function formatMacroOptions(o: MacroOptions): string
  export function optionsRefusal(o: MacroOptions): string | null
  export function rewriteMacroOptions(text: string, span: [number, number], o: MacroOptions): string
  ```
- Produces: `BlockSegment` query kind becomes
  `{ kind: "query"; expr: string; options: MacroOptions; span: [number, number] }`.
  `expr` excludes options, and `span` covers the whole macro in the block
  text.
- Produces: `roamTableRows(node)` also returns the table's options:
  `roamTable(node): { rows: RoamTableRows; options: MacroOptions } | null`.
  Keep `roamTableRows` as a wrapper so existing callers are unchanged.

- [ ] **Step 1: Write the failing tests**

- `macroOptions.test.ts`: replay
  `shared/fixtures/macro_options_parity.json` (head, options and formatted
  must equal the fixture for every case), and test `optionsRefusal` on the
  same five characters as Task 3.
- `macroOptions.props.test.ts`: a fast-check round trip over generated clean
  options.
- `rewriteMacroOptions`: given `"{{[[query]]: {and: [[A]]}}}"`, its span and
  `{view:"cards"}`, it returns `"{{[[query]]: {and: [[A]]} | view: cards}}"`,
  keeping the original prefix spelling.
- `tokenize.test.ts`: `"{{query: {and: [[A]]} | sort: X asc}}"` yields one query
  segment with `expr` `{and: [[A]]}`, options `{sort:{col:"X",dir:"asc"}}`,
  and span `[0, len]`.
- `roamTableRows.test.ts`: `{{table | sort: Lab desc}}` with children still
  yields rows, and `roamTable` returns options `{sort:{col:"Lab",dir:"desc"}}`.
  `{{table}}` behaves as today.

- [ ] **Step 2: Run them, and confirm they fail**

Run: `cd web && pnpm vitest run src/grammar src/outline/roamTableRows.test.ts`

- [ ] **Step 3: Implement**

Use the same depth-0 split rule as Task 3. The tokenizer takes the span
from `scanMacro`'s start and end. `TABLE_MACRO` becomes a prefix match on
`{{table` or `{{[[table]]`, followed by optional options and `}}`. Update
`visibleTree.ts`'s `isMacro` to match.

- [ ] **Step 4: Run `pnpm verify`, and confirm it passes**

Also grep `web/src` and `server/src` for other recognisers of `{{table` or
`query:`, and route each one through the split.

- [ ] **Step 5: Commit**

---

## Phase C: Records

### Task 5: Record building (server Core)

**Files:**
- Create: `server/src/pkm/server/query_records.py` (Core)
- Test: `server/tests/test_query_records.py`

**Interfaces:**
- Produces:
  ```python
  @dataclass(frozen=True)
  class ResultBlock:      # one query match
      uid: BlockUid; page_id: PageId; page_title: CanonicalTitle
      parent_uid: BlockUid | None; text: str; attribute: CanonicalTitle | None

  @dataclass(frozen=True)
  class AttrBlock:        # a :: block under a record
      uid: BlockUid; holder: str          # record key, see below
      key: CanonicalTitle; text: str; order_idx: int; child_count: int

  @dataclass(frozen=True)
  class HolderInfo:
      key: str; kind: Literal["page", "line"]; page_id: PageId
      page_title: CanonicalTitle; uid: BlockUid | None; title: str
      insert_before_order_idx: int | None   # sibling after last :: block, or first child

  def record_key(r: ResultBlock) -> tuple[str, Literal["page", "line"], BlockUid | None]
  def build_records(results: Sequence[ResultBlock], holders: Mapping[str, HolderInfo],
                    attrs: Sequence[AttrBlock]) -> RecordsResult
  ```
  `record_key` gives `"page:<id>"` for a top-level attribute result,
  `"block:<parent_uid>"` for a nested one, and `"block:<uid>"` otherwise.
  `RecordsResult(records: list[QueryRecordModel], keys: list[KeyStat])` uses
  Task 6's models.

- [ ] **Step 1: Write the failing tests** (pure, no DB)

- `test_top_level_attribute_maps_to_page`
- `test_nested_attribute_maps_to_parent_line`
- `test_plain_block_is_its_own_record`
- `test_two_results_same_record_one_row`: two results on one page give one
  record with both `result_uids`.
- `test_duplicate_key_first_wins`: two `Reading Status` attr blocks give a
  cell whose `uid` is the lower `order_idx` and `extra_uids == [second]`.
- `test_value_offset`: for `"Reading Status::  Read"`, `cell.value ==
  "Read"` and `cell.text[:cell.value_start] == "Reading Status::"`.
- `test_keys_ranked`: `keys` is ordered by record count descending, ties by
  first appearance, and each entry carries its count and the first raw
  spelling.
- `test_child_count_carried`: an attr block with two children gives
  `child_count == 2`.

- [ ] **Step 2: Run them, and confirm they fail**

- [ ] **Step 3: Implement**

Use `refs.attribute_title_span(strip_code(text), text)` for `value_start`
and the raw key.

- [ ] **Step 4: Run them, and confirm they pass**

- [ ] **Step 5: Commit**

### Task 6: `GET /api/query/records`

**Files:**
- Create: `server/src/pkm/server/query_records_db.py` (Shell)
- Modify: `server/src/pkm/server/routes_search.py`,
  `server/src/pkm/contracts/responses.py`, `docs/architecture/backend.md`
- Test: `server/tests/test_query_records_route.py`

**Interfaces:**
- Produces: route `GET /api/query/records?expr` → `QueryRecordsPayload`, with
  a 400 on `QueryParseError`, the same bounds as `/api/query`.
- Produces: the models
  ```python
  class RecordCell(BaseModel):
      uid: BlockUid; key_raw: str; text: str; value: str; value_start: int
      extra_uids: list[BlockUid] = []; child_count: int = 0
  class QueryRecordModel(BaseModel):
      key: str; kind: Literal["page", "line"]; page_id: PageId
      page_title: CanonicalTitle; uid: BlockUid | None; title: str
      result_uids: list[BlockUid]; cells: dict[CanonicalTitle, RecordCell]
      insert_parent_uid: BlockUid | None
      insert_before_order_idx: int | None; last_attr_order_idx: int | None
  class KeyStat(BaseModel):
      key: CanonicalTitle; label: str; count: int
  class QueryRecordsPayload(BaseModel):
      records: list[QueryRecordModel]; keys: list[KeyStat]; total: int
  ```
  `total` is the number of records. `cells` are keyed by attribute page
  title.

- [ ] **Step 1: Write the failing tests**

- `test_records_books_shape`: seed two `Book/` pages through `/api/ops`, with
  `Tags:: #Book`, `Author:: X`, and `Reading Status::` (empty on one).
  `GET /api/query/records?expr={and: [[Book]]}` returns two page records.
  `keys` includes `Author` with count 2, and the empty status cell has
  `value == ""`.
- `test_records_line_result`: a list page line "Some Paper", with children
  `Tags:: #Paper` and `Local copy:: x`, gives a `line` record whose `title`
  is "Some Paper", whose `insert_parent_uid` is that line's uid, and whose
  cells include `Local copy`.
- `test_records_key_spelling_follows_page`: `Reading status::` on one page and
  `Reading Status::` on another fall in one column if and only if they
  resolve to the same page title. Assert whichever the title rules give, by
  reading `read_title`.
- `test_records_many`: seed 600 `Book/` pages in one ops batch (or raw SQL
  plus refs). All 600 come back and `total == 600`. Count statements with a
  `db` wrapper and assert the count does not grow with N (this is Review
  Focus 2).
- `test_records_bad_expr_400`.

- [ ] **Step 2: Run them, and confirm they fail**

- [ ] **Step 3: Implement the shell**

Run the plan (`parse_canonical_query`, `plan_sql`, `iter_plan_rows`). Then
make chunked fetches (`chunk_ids`) for:
- result blocks' `parent_uid` and attribute targets (`refs.kind =
  'attribute'` joined to `pages.title`);
- holders' `::` blocks, as top-level blocks of record pages, or children of
  record uids, with an attribute ref;
- child counts;
- the next sibling `order_idx`.

Then call `build_records`.

- [ ] **Step 4: Run `uv run pytest -q`, `pyrefly` and `ruff`, and confirm they pass**

- [ ] **Step 5: Regenerate openapi, add a backend.md API row, and commit**

---

## Phase D: Web cores

### Task 7: Filter and sort

**Files:**
- Create: `web/src/tables/filter.ts`, `web/src/tables/sort.ts` (Core), with
  tests beside them

**Interfaces:**
- Produces:
  ```ts
  export interface FilterTerm { neg: boolean; col: string | null; value: string }
  export function parseFilter(text: string): FilterTerm[]
  export type FilterRow = Readonly<Record<string, string | undefined>>
  export function matchesFilter(row: FilterRow, terms: FilterTerm[], columns: readonly string[]): boolean
  export function compareCells(a: string | undefined, b: string | undefined, dir: "asc" | "desc"): number
  export function sortRows<T>(rows: readonly T[], get: (r: T) => string | undefined, dir: "asc" | "desc"): T[]
  ```

- [ ] **Step 1: Write the failing tests** (spec values)

- `kind` matches a row with `Format: "Kindle"`; `read` does not match
  `"Unread"`.
- `status:read` matches only the `Reading Status` column.
- `-status:read` keeps `""` and `"Unread"`, and drops `"Read"`.
- `status:` matches empty cells only.
- `"take smart"` matches the phrase's word starts.
- Matching ignores `#`, `[[` and `]]`: `author:slobodian` matches
  `"[[Quinn Slobodian]]"`.
- `source:unlinked` uses the `Source` column.
- `compareCells`: empty cells sort last for both `asc` and `desc`; `"Mar 2026"`
  sorts after `"Feb 2026"`, and `"Jan 2026"` after `"2025"`; `"0.014"`
  sorts before `"0.044"`; text compares case-insensitively without markup.

- [ ] **Step 2: Run them, and confirm they fail**

- [ ] **Step 3: Implement**

Words are `\p{L}\p{N}.` runs. Dates are `<Mon> <yy|yyyy>` or a 4-digit
year. Numbers start with a digit or a `.`.

- [ ] **Step 4: Run `pnpm verify`, and confirm it passes**

- [ ] **Step 5: Commit**

### Task 8: View state machine and its property suite

**Files:**
- Create: `web/src/tables/viewState.ts` (Core), `viewState.test.ts`
- Create: `web/src/props/tables/` (`arbitraries.ts`, `model.ts`,
  `viewState.prop.ts`, `teeth.prop.ts`)

**Interfaces:**
- Produces:
  ```ts
  export interface ViewFields { filter: string; sort: { col: string; dir: "asc"|"desc" } | null;
    view: "table"|"cards"|"blocks"; columns: string[] }
  export interface ViewState { saved: ViewFields; live: ViewFields; frozen: string[] | null }
  export type ViewEvent =
    | { kind: "filter"; text: string } | { kind: "sortClick"; col: string }
    | { kind: "view"; view: ViewFields["view"] } | { kind: "columns"; columns: string[] }
    | { kind: "edited"; visibleIds: string[] } | { kind: "reset" }
    | { kind: "saved" } | { kind: "loaded"; saved: ViewFields }
  export function initialView(saved: ViewFields): ViewState
  export function stepView(s: ViewState, e: ViewEvent): ViewState
  export function isDirty(s: ViewState): boolean
  export function viewFromOptions(o: MacroOptions, defaults: ViewFields): ViewFields
  export function optionsFromView(v: ViewFields, defaults: ViewFields): MacroOptions
  ```
  `sortClick` cycles asc, desc, off. `edited` sets `frozen` when it is null.
  `filter`, `sortClick`, `view`, `columns` and `reset` clear `frozen`.
  `loaded` (a refetch) keeps `live` and `frozen`. `optionsFromView` omits
  every field equal to the default.

- [ ] **Step 1: Write the unit tests**

Cover each transition named above, `isDirty` after `reset` (false), and the
round trip `viewFromOptions(optionsFromView(v))` equal to `v`.

- [ ] **Step 2: Write the property suite**

Use `checkGateProperty` with the model from the spec's "Unsaved state" and
"Editing" bullets. The properties:
- `isDirty` is true if and only if `live` differs from `saved`.
- `frozen` is non-null only between an `edited` and the next
  `filter`/`sort`/`view`/`columns`/`reset`.
- `loaded` never changes `live`.

Show reach with floors per AGENTS.md. Add a teeth mutant (`loaded`
overwriting `live`) that the suite must catch.

- [ ] **Step 3: Implement, and run `pnpm verify` and `proptest/check.sh web --file tables`, confirming both pass**

- [ ] **Step 4: Commit**

### Task 9: Records rows, columns, suggestions and write planning

**Files:**
- Create: `web/src/tables/records.ts` (Core), `records.test.ts`

**Interfaces:**
- Consumes: the `QueryRecordsPayload` types (generated).
- Produces:
  ```ts
  export function defaultColumns(p: QueryRecordsPayload): string[]   // KeyStat.key, count*2 >= total
  export function recordRow(r: QueryRecordModel, labels: Map<string, string>): FilterRow // Result, Source, label->value
  export function suggestions(records: QueryRecordModel[], key: string, typed: string):
    { value: string; count: number }[]   // [] unless some value repeats; case-merged, capitalised wins
  export function similarKey(r: QueryRecordModel, label: string): string | null
  export function planCellWrite(r: QueryRecordModel, key: string, label: string, value: string,
    mint: () => BlockUid): BlockOp[]
  ```
  `planCellWrite` covers four cases:
  - An existing cell gives one `update_text` with text
    `cell.text.slice(0, value_start) + " " + value` (no trailing space when
    `value` is empty) and `base_text_hash` set to `sha256Hex(cell.text)`.
  - A missing cell gives one `create` under `insert_parent_uid`, with
    `order_idx = insert_before_order_idx ?? (last_attr_order_idx !== null ?
    orderIdxAfter(last_attr_order_idx) : FIRST_ORDER_IDX)`, text
    `` `${label}:: ${value}` `` and `page_title: r.page_title`.
  - Unchanged text, or an empty value on a missing cell, gives `[]`.
  - The result never touches `extra_uids` or children.

- [ ] **Step 1: Write the failing tests**

- the update text for `"Reading Status::"` → `"Reading Status:: Read"`, and for
  `"Reading Status:: Read"` → `"Reading Status::"` when the value is empty
- create placement for each of the three `order_idx` sources
- `base_text_hash` set (Review Focus 1)
- a multi-line value is written verbatim (Review Focus 5)
- a missing cell with an empty value gives `[]`
- `suggestions` merges `Read`/`read` into `Read` with count 2, and returns
  `[]` for an all-unique column
- `similarKey` finds `Publication` for the label `Published`, and returns
  null for `Format`

- [ ] **Step 2: Run them, and confirm they fail**

- [ ] **Step 3: Implement**

The `similarKey` rule is the builder's choice, within these bounds: the two
keys share a stem of at least four letters, or are within edit distance 2.
It ignores case.

- [ ] **Step 4: Run `pnpm verify`, and confirm it passes, then commit**

### Task 10: Cell editor machine and its property suite

**Files:**
- Create: `web/src/tables/cellEditor.ts` (Core), `cellEditor.test.ts`,
  `web/src/props/tables/cellEditor.prop.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CellRef { row: string; col: string }
  export type EditorState = { kind: "idle" } | { kind: "editing"; cell: CellRef; original: string; draft: string }
  export type EditorEvent =
    | { kind: "open"; cell: CellRef; value: string } | { kind: "input"; draft: string }
    | { kind: "commit" } | { kind: "cancel" } | { kind: "outside" }
    | { kind: "tab"; dir: 1 | -1; next: { cell: CellRef; value: string } | null }
  export type EditorEffect = { kind: "write"; cell: CellRef; value: string }
  export function stepEditor(s: EditorState, e: EditorEvent): { state: EditorState; effects: EditorEffect[] }
  export function neighbourCell(order: readonly CellRef[], cur: CellRef, dir: 1 | -1): CellRef | null
  ```
  `commit`, `outside` and `tab` emit `write` only when `draft.trim() !==
  original.trim()`. `cancel` never writes. `open` while editing commits the
  old cell first. `tab` with `next` opens it, and with `null` ends at idle.

- [ ] **Step 1: Write the unit tests, then the property suite**

Unit tests cover each event in each state. The property suite generates
event sequences over a small grid, and checks four things:
- At most one write per opened cell.
- No write equals its cell's `original`.
- `cancel` is never followed by a write for that cell.
- The state is idle exactly when no cell is open.

Add a teeth mutant: `cancel` writes.

- [ ] **Step 2: Implement, run `pnpm verify` and the props check, confirm both pass, and commit**

---

## Phase E: Shells

### Task 11: Shared table UI

**Files:**
- Create: `web/src/tables/DataTable.tsx`, `CellEditor.tsx`,
  `TableToolbar.tsx`, `WriteNotice.tsx` (Shell), with `*.test.tsx` beside
  them
- Modify: `web/src/styles.css`, `docs/architecture/styling.md`

**Interfaces:**
- Produces:
  ```ts
  interface Column { key: string; label: string; editable: boolean; numeric?: boolean }
  interface DataTableProps<R> {
    columns: Column[]; rows: R[]; rowId: (r: R) => string;
    renderCell: (r: R, c: Column) => ReactNode; rawValue: (r: R, c: Column) => string;
    sort: ViewFields["sort"]; onSortClick: (col: string) => void;
    staleIds?: ReadonlySet<string>; canEdit: boolean;
    onWrite: (r: R, c: Column, value: string) => void;
    cellHint?: (r: R, c: Column) => ReactNode;            // suggestions, warnings
    suggest?: (r: R, c: Column, typed: string) => { value: string; count: number }[] }
  function DataTable<R>(p: DataTableProps<R>): JSX.Element
  function TableToolbar(p: { filter: string; onFilter(t: string): void; count: string;
    dirty: boolean; saved: boolean; canSave: boolean; refusal: string | null;
    onReset(): void; onSave(): void; onEditAsText?(): void }): JSX.Element
  function WriteNotice(p: { message: ReactNode; onUndo?: () => void; onDismiss(): void }): JSX.Element
  ```
  The `.editor-notice` markup comes from `DismissibleNotice`, with an Undo
  button styled `.btn-secondary.btn-compact`. It shows in the table's own
  notice slot, under the toolbar.

- [ ] **Step 1: Write the failing component tests**

- Clicking an editable cell mounts a `textarea.cell-editor` (assert the tag
  is `TEXTAREA`).
- Enter calls `onWrite` with the trimmed draft; Shift-Enter inserts `\n`
  instead (Review Focus 5).
- Esc does not call `onWrite`.
- Tab writes, then focuses the next editable cell's editor; it wraps to the
  next row, and Shift-Tab goes back.
- A mousedown outside commits.
- Clicking an `<a>` inside a cell does not open the editor.
- With `canEdit` false, no editor opens.
- Header clicks call `onSortClick`, and the arrow shows `sort.dir`.
- `staleIds` rows get `.stale` and the "no longer matches" label.
- Arrow keys and Enter pick a suggestion.
- Clicks and keys inside the table call `stopPropagation`, so the host block
  never takes focus.

- [ ] **Step 2: Run them, and confirm they fail**

- [ ] **Step 3: Implement**

`DataTable` drives `stepEditor` and runs `write` effects through `onWrite`.
Cell order for Tab is the rendered `editable` cells, row-major. Add
`.data-table`, `.cell-editor`, `.table-toolbar` and `.query-crumb`, using
the existing tokens (`--radius-field` for the editor, `.input-control` or
`.search-field` for the filter box, `--z-*` for the suggestion popup).
Document the new classes in styling.md § Controls.

- [ ] **Step 4: `[[` and `#` autocomplete in the cell editor, if cheap**

Wire `useAutocomplete` (it needs only a textarea), `useTitleOptions`,
`buildRows`, `AutocompletePopup` and `applyCompletion`, ignoring the
`"command"` kind. Picking a row keeps the editor open. If the key routing
`BlockInput` does (`acRowsLength`/`acSelected`) cannot be shared without
restructuring `BlockInput`, skip this step and file a follow-up bean under
pkm-l79g that says why.

- [ ] **Step 5: Run `pnpm verify`, and confirm it passes, then commit**

### Task 12: QueryBlock views, writes and Save

**Files:**
- Modify: `web/src/components/QueryBlock.tsx`, `web/src/contexts.ts`
  (extend `BlockEditApi`), `web/src/components/EditableBlockTree.tsx`
  (provide it), `web/src/components/InlineSegments.tsx` (pass `options` and
  `span`), `web/src/outline/handlers.ts` and the `useOutline` /
  `outline/command.ts` implementation (add `onSetText(uid, text)`)
- Create: `web/src/tables/QueryTable.tsx`, `QueryCards.tsx` (Shell)
- Test: `web/src/components/QueryBlock.test.tsx`,
  `web/e2e/query-table.spec.ts`

**Interfaces:**
- Consumes: Tasks 4, 6, 7, 8, 9 and 11.
- Produces: `OutlineHandlers.onSetText(uid: BlockUid, text: string): void`,
  run through `useOutline.run` so it records history the way
  `onToggleTodo` does. Task 13 reuses it.
- Produces: `BlockEditApi` gains `text: string` and
  `setText(next: string): void`, which `EditableBlockTree` implements with
  `onSetText`.

- [ ] **Step 1: Write the failing tests**

`QueryBlock.test.tsx`, with `/api/query/records` and `/api/query` stubbed:
- The table view is the default when any record has cells; blocks is the
  default when none do.
- The count is `"2 of 2 results"`, then `"1 of 2 results"` after typing
  `author:x`.
- Save calls `setText` with `rewriteMacroOptions(...)` output, and Reset
  restores the saved options.
- A filter containing `[[` shows the refusal and calls no `setText`
  (Review Focus 3).
- A cell commit enqueues `planCellWrite`'s ops with scope
  `["page", page_title]` (spy on `useSyncActions`). It shows a
  `WriteNotice` naming the key, value and page, and Undo enqueues the
  inverse (`update_text` back to `cell.text`, or `delete` of the created
  uid).
- Without `BlockEditContext`, or with `canEdit` false: no editor and no Save
  (Review Focus 4).
- A line record's title links to `/page/<page>#<uid>`, and "line on page" to
  `/page/<page>`.
- A sort click on a column orders rows, and the outline is not touched.
- The column menu (in each header) hides a column, adds one for any key in
  `keys`, and moves a column left or right. Save writes `columns:`.
- A cell with `extra_uids` shows a "2 lines" badge; one with `child_count >
  0` shows "+N lines".
- Opening a missing cell whose record has a similar key shows the warning
  (`similarKey`) before the write.
- Switching to Cards shows the same rows and filter, read-only.

`e2e/query-table.spec.ts` (using `ownPage`): seed two `Book/` pages through
the API, add a `{{query: {and: [[Book]]}}}` block on the scratch page, edit a
Reading Status cell, Tab to the next cell, press Enter, and assert with
`waitForServerText` that the book page holds `Reading Status:: Read`. Then
press Save after typing a filter, reload, and assert the filter persists.
Delete the seeded books in `afterEach`.

- [ ] **Step 2: Run them, and confirm they fail**

- [ ] **Step 3: Implement**

After a write's `settled`, patch the local record (`cells` value and text, or
a new cell) so the edited cell shows the new value at once. The next resync
refetches as today. Call `peekOutlineSession(page_title)?.applyLocal(ticket,
ops)` so an open copy of that page updates. Add "Edit as text" in the
toolbar, which calls `handlers.onFocusBlock` for the host block.

- [ ] **Step 4: Run `pnpm verify` (which includes e2e), and confirm it passes, then commit**

Cmd-Z: try `recordHistory` with a hand-built `HistoryEntry` (the inverse
from Step 1). If `historyAnchors` needs a page tree that is not loaded,
leave Cmd-Z out, keep the notice's Undo, and file a follow-up bean naming
why.

### Task 13: Plain tables: sort, filter, edit, + New row and Save

**Files:**
- Modify: `web/src/outline/handlers.ts` (add `onInsertTableRow(tableUid)`;
  `onSetText` comes from Task 12), the `useOutline` implementation and the
  command builders in `web/src/outline/command.ts`,
  `web/src/components/roamTable.tsx`,
  `web/src/components/EditableBlockTree.tsx`
- Create: `web/src/tables/tableWrites.ts` (Core), `tableWrites.test.ts`
- Test: `web/src/components/roamTable.test.tsx`,
  `web/e2e/table-edit.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export function planTableCellWrite(table: BlockNode, rows: RoamTableRows, r: number, c: number,
    value: string, mint: () => BlockUid): { kind: "text"; uid: BlockUid; text: string }
                                        | { kind: "create"; ops: CreateOp[] } | null
  export function planNewRow(table: BlockNode, width: number, mint: () => BlockUid, pageTitle: RawTitle): CreateOp[]
  ```
  A padding cell (null) creates the missing chain from the row's last real
  cell down to column `c`, with `freshChildOrderIdx(0)` for each new child.
  `planNewRow` appends a child of `table` after its last child, carrying a
  chain of `width` empty blocks.
- `onInsertTableRow` runs through `useOutline.run`, so it records history
  the way `onToggleTodo` does.

- [ ] **Step 1: Write the failing tests**

- `tableWrites.test.ts`: a write to an existing cell gives a `text` result;
  a padding-cell write in a short row creates exactly the missing blocks;
  `planNewRow` with width 3 gives three nested creates.
- `roamTable.test.tsx`: body rows sort while the header stays first; the
  filter counts `"N of M rows"`; a cell commit calls `onSetText`; "+ New row"
  calls `onInsertTableRow` and opens the first new cell; "Edit as text"
  focuses the table block; Save rewrites `{{table}}` to `{{table | sort: …}}`
  through `onSetText`.
- `e2e/table-edit.spec.ts` (`ownPage`): build a 2×2 `{{table}}`; edit a cell,
  then Tab and Enter; add a row; press Cmd-Z and assert the row is gone;
  sort, reload, and assert the block order is unchanged.

- [ ] **Step 2: Run them, and confirm they fail**

- [ ] **Step 3: Implement**

`EditableBlockTree` passes the handlers and `roamTable(node).options` to
`RoamTable`. Clicks inside the table no longer focus the table block.

- [ ] **Step 4: Run `pnpm verify`, and confirm it passes, then commit**

---

## Phase F: Docs and gates

### Task 14: Architecture docs, keyboard docs and merge gates

**Files:**
- Modify: `docs/architecture/frontend-rendering.md` (query views, the table
  macro's options and the query segment's new fields),
  `docs/architecture/frontend-editor.md` (the cell editor, and why it is a
  textarea; table edits through `onSetText`/`onInsertTableRow`),
  `docs/architecture/backend.md` (check the rows from Tasks 1, 3 and 6),
  `docs/keyboard.md` (table keys: Enter, Esc, Tab, Shift-Tab, Shift-Enter)

- [ ] **Step 1: Make the doc edits through the `architecture-docs` skill**

Verify each claim against the shipped code.

- [ ] **Step 2: Run the full gates in the foreground, serially**

```bash
cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check
cd ../web && set -o pipefail && pnpm verify
cd .. && proptest/check.sh server && proptest/check.sh web
perf/check.sh
```

Expected: all pass. Follow perf's `next:` lines, and take any regression to
Arthur with the table.

- [ ] **Step 3: Check on the iPad**

Ask Arthur to try Tab, Shift-Tab, Esc and Shift-Enter in both table kinds on
his iPad, through the deployed build or a scratch server on 8975 shared over
`tailscale serve` (the prod host recipe). Neither the simulator nor
Playwright WebKit reproduces iPad Tab.

- [ ] **Step 4: Commit the docs, update the beans, and request the final review**
