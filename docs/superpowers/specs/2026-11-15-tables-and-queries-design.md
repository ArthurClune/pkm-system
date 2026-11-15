# Tables and queries: sort, filter, edit and saved views

Bean: pkm-l79g

## Intent

Pages of one kind already carry front matter: the `Key:: value` blocks at the
top of a `Book/` or `Paper/` page (Author, Reading Status, URL, Local copy…),
and the `::` children under a line on a list page. A `{{query}}` today shows
each matching block grouped by page, which for `{and: [[Paper]] [[AI
Agents]]}` is a column of near-identical `Tags::` lines. Arthur wants the
query to show the *records* those lines belong to as a table, one column per
`::` key, that he can filter, sort and edit in place, the way Obsidian Bases
does. Plain `{{table}}` blocks get the same filter, sort and editing. The two
features share one table component and one cell editor.

Editing is the point as much as viewing: the existing values are
inconsistent (`Read` / `read` / blank, `Publication::` beside `Published::`),
and a table that writes back is the quickest way to tidy them.

## Goals

- A query shows its results as a table, cards or blocks (today's view).
- Typing in one box filters a query table or a plain table.
- Clicking a column header sorts; the outline never reorders.
- Cells are editable and write back to the block the value lives in.
- Filter, sort, view and columns reset when the page is left, unless saved
  with "Save this view", which stores them in the block's own text.
- A plain table gains "+ New row".
- Blocks view shows a nested result's parent line, not a bare `Tags::` line.

## Non-goals

- "+ New" rows on query tables (what a new row would be, a page or a line, and
  where it goes, is unresolved). The page templates spec
  (`2026-11-15-page-templates-design.md`, pkm-msan) covers new Book/Paper
  pages.
- Offline queries. Queries stay online-only, as today
  ([sync-and-offline.md § Online-only features](../../architecture/sync-and-offline.md#online-only-features)).
- Formulas, grouping, summaries, kanban or map views from Bases.
- Back-filling or renaming keys across existing pages.
- Changes to the query expression language.

## Anti-goals

- Viewing never writes. Filtering, sorting, switching view and opening a page
  leave the graph untouched; only a cell commit, "+ New row" and "Save this
  view" write.
- Sorting never reorders blocks.
- No silent truncation: every result the query returns is a row, and the
  count says "N of M results".
- A saved view adds no pages and no refs to the graph.
- A row never jumps out from under the cursor after an edit.

## Approaches

### Where a saved view is stored (Arthur's call: B)

| | Approach | Verdict |
|---|---|---|
| A | Child `::` lines under the block (`view::`, `filter::`) | Rejected: every child of a `{{table}}` is a row, so it cannot work for tables; each line would also create pages named `view`, `filter`, `sort` and add attribute refs to them |
| B | Options inside the macro text | **Chosen.** One mechanism for both macros, visible when the block is focused, kept by markdown export, nothing added to the graph. Roam would not read the options; nothing is sent back to Roam |
| C | A hidden block column set by a new op, like `view_type` | Rejected: schema, op, replica and parity work, and markdown export would drop it |

### Where records come from (Claude's call)

| | Approach | Verdict |
|---|---|---|
| 1 | Server: `/api/query` also returns each result's record and its `::` lines with uids | **Chosen.** The query engine and the attribute parser (`refs.py`) already live there |
| 2 | Client, from the replica | Rejected for now: the query planner would have to be ported to the browser, which is the offline-queries project |

Cell edits go through the normal op queue, the same path outline edits use,
so sync, conflicts and the replica behave as for any other edit. Sort and
filter run in the browser over the loaded rows.

## Decided

### Saved-view syntax

```
{{query: {and: [[Book]]} | view: table | filter: -status:read | sort: Published desc | columns: Author, Published, Format, Reading Status}}
{{table | filter: apache | sort: Cache hit asc}}
```

- Options follow the expression (or the bare `table`), each introduced by
  ` | name: value`. Names: `view` (`table` | `cards` | `blocks`), `filter`
  (the filter box's text, verbatim), `sort` (a column name, then `asc` or
  `desc`), `columns` (comma-separated column names, in order). `view` and
  `columns` apply to queries only.
- Every surface that reads a query or table macro strips the options before
  parsing the expression or matching the table macro: the web tokenizer
  (`grammar/tokenize.ts`), `roamTableRows`, the server's query parse (live
  route and markdown export), and refs extraction. Option text is never
  scanned for refs.
- "Save this view" rewrites the macro's options from the current state;
  removing an option by hand removes it from the view. "Reset" returns to the
  saved options (or none).
- Filter text that cannot round-trip through the macro (it contains `|`, or
  braces that would close the macro) is refused at Save with a message, not
  written mangled.

### Records and rows (queries)

One row per record. A result block maps to its record:

| Result block | Record | Row title | Columns from |
|---|---|---|---|
| a top-level `Key::` line on a page | the page | page title, links to the page | the page's top-level `::` blocks |
| a nested `Key::` line | its parent block | the parent's text, with "line on *page*" beneath | the parent's `::` children |
| any other block | the block itself | its text, with "line on *page*" beneath | its `::` children |

- Results that map to the same record give one row. The count counts rows.
- Clicking a page title opens the page. Clicking a line's text opens its page
  scrolled to that line and flashes it; clicking "line on *page*" opens the
  page at the top.
- A column is an attribute page: two `::` blocks belong to the same column
  when their keys resolve to the same page, by the title rules attribute refs
  already use ([titles-and-refs.md](../../architecture/titles-and-refs.md)).
  The server and the client must apply that one rule. The live graph has no
  keys that differ only by case or spacing.
- A key that appears twice on a record shows the first value with a "2 lines"
  badge.
- A `::` block's own text is the cell value. A value with line breaks shows
  them, and in the editor Shift-Enter inserts one, as in the outline. Child
  blocks under a `::` block are never shown in the cell or written by a
  commit (an `update_text` leaves children alone). The cell carries a
  "+N lines" badge, and filter and sort ignore the children. The live graph
  has a handful of each.
- Default columns: the keys most records share, in the order they first
  appear on the pages; "Columns" (a header menu) hides, adds and reorders
  them. The first column is always the row title ("Result").
- Default view when nothing is saved: table if any record has `::` lines,
  otherwise blocks.

### Blocks view

As today, grouped by page, with one change: a nested result shows its parent
line above it as a breadcrumb that opens the page at that line. This needs
the result's ancestors in the response (backlinks already fetch them,
`routes_pages._fetch_ancestors`), and it can ship on its own ahead of the
rest.

### Filter

One text box, the same on queries and tables.

- A plain word matches the start of any word in any column, title and source
  included, ignoring case and `#`/`[[ ]]` markup: `kind` matches Kindle.
- `col:value` looks in the columns whose names have a word starting with
  `col` (`status:read`, `author:slobodian`); `source:` matches the page a line
  result sits on, or `page` for page results.
- `-` before a term excludes: `-status:read` keeps blank and Unread.
- `col:` with no value matches an empty cell. Double quotes group a phrase.
- All terms must hold. The count reads "N of M results" (queries) or
  "N of M rows" (tables).

### Sort

- Clicking a header cycles ascending, descending, off.
- Empty cells sort last in both directions.
- Values compare as dates when both read as dates ("Mar 2026", "2017"), as
  numbers when both start with a number, otherwise as text, ignoring case and
  ref markup.
- A plain table's header row stays first; only body rows sort and filter.

### Editing

The cell editor is a one-line `<textarea>`, never an `<input>`. iPad Safari
with a hardware keyboard keeps Tab inside an `<input>` for its own
field-to-field navigation and never sends the page a keydown; a textarea gets
Tab, which is how the outline's indent works. Confirmed on Arthur's iPad;
neither the simulator nor Playwright WebKit reproduces it.

- Click (or tap) a cell to edit; clicking a link inside a cell follows the
  link instead, as in the outline. The row title is not editable here.
- Enter commits, Esc cancels, a click elsewhere commits. Tab and Shift-Tab
  commit and move to the next or previous editable cell, wrapping to the next
  row.
- The editor shows raw text, like a focused block (`[[Gregor Hohpe]]`, not a
  link).
- A commit writes `Key:: value` to the record's first block for that key,
  keeping the key as spelled on the page. With no such block, it creates one
  after the record's last `::` block, spelled as the column header.
- When the key is missing but the record has a similar key (`Publication::`
  for a `Published` column), the editor says so before the write.
- When values in a column repeat, the editor suggests the existing values
  with their counts, with case variants merged under the capitalised spelling.
  Arrow keys and Enter pick one.
- Every write shows a toast naming the key, value and page, with Undo.
- After an edit, rows keep their order and visibility until the filter, sort
  or view changes or the page is left. A row that no longer matches the
  filter is dimmed and marked "no longer matches".
- Plain table cells are blocks: a commit is an `update_text` of that cell's
  block. Editing a padding cell (a short row) creates the missing blocks in
  that row's chain.

### "+ New row" (plain tables)

A button under the table adds a row: a new child of the `{{table}}` block
whose cell chain is as wide as the header row, empty, with the editor open on
its first cell. One undo removes it.

### Unsaved state

Filter, sort, view and column changes live in the mounted block. They survive
refetches (a resync, another device's edit) and reset when the block unmounts.
"Reset" and "Save this view" appear only when the state differs from what is
saved; otherwise a saved view shows "✓ saved view".

## Calls made (correct any of these)

- **Cards view ships**, read-only (mocked and not objected to); it shows the
  same columns and filter.
- **The table becomes the default** for existing queries whose results have
  `::` lines, so the many existing `{and: [[X]] [[Paper]]}` queries turn into
  tables with no edit. Blocks stays one click away.
- **All `::` columns are editable**, including link-valued ones such as
  `Local copy::`, as raw text.
- **`[[` and `#` autocomplete** in the cell editor, reusing the outline's
  popup if it can be reused without restructuring it; if not, it is a
  follow-up bean rather than a reason to grow this one.
- **"+ New row" creates the full cell chain**, not just the first cell, so
  the row is rectangular from the start.
- **The filter syntax is the mockup's**: word-prefix matching, `col:`, `-`,
  quotes. No regex, no comparisons (`>`), no dates.
- **Columns follow the attribute page**, so key spelling follows the title
  rules refs already use. Multi-line values edit with Shift-Enter, and child
  blocks under a value are left alone (both rare in the live graph).
- **The similar-key warning is information only**: saving still adds the new
  line.

## Left to the builder

- The response shape for records (a flag on `/api/query` or a sibling route),
  how the server finds each result's record and `::` lines in bounded
  queries, and how the option-stripping parsers are kept in step between the
  Python and TS sides (the existing parity-dump pattern,
  [backend.md § Generated artifacts and parity fixtures](../../architecture/backend.md#generated-artifacts-and-parity-fixtures),
  is the expected route).
- How a cell commit reaches the op queue from outside an editable outline
  (query results are rendered read-only today; `TodoCheckbox` is disabled
  there), and whether Cmd-Z can undo it through the outline's undo history or
  only through the toast.
- How a focused `{{table}}` block is still reachable as raw text once clicks
  on cells edit cells (the bullet, a click on the table's frame, or similar).
- How the similar-key warning decides "similar".
- Live refresh after an edit: the edited cell shows the new value at once;
  whether the query refetches on the next resync or patches its rows.
- Module split. Pure and Functional Core: filter parse and match, sort
  comparison, option parse and serialise, record extraction, default columns,
  and planning a cell write (record, column, value to ops). Shell: the
  components and the fetch.

Constraints the builder must meet:

- The cell editor and the unsaved/saved view state are new state machines,
  so they get property tests per the project rule, as does option
  parse/serialise round-tripping.
- New route fields regenerate `web/src/api/openapi.json` and get a row in the
  API table in `backend.md`.
- `docs/keyboard.md` gains the table keys; the iPad textarea rule goes in the
  architecture doc that owns the cell editor; new control classes go in
  `styling.md`.
- `perf/check.sh` and `proptest/check.sh` run before merge (large queries
  return hundreds of records).
- The mockups (local only, gitignored, with real data):
  `.superpowers/brainstorm/35795-1794752458/content/tables-and-queries-v7.html`
  is the final one.
