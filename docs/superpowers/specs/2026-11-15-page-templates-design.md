# Page templates for Paper/ and Book/ pages

Bean: pkm-msan

## Intent

Paper and Book pages open with `Key::` attribute blocks, but the fields and
their order have drifted between pages (`Publication::` vs `Published::`,
`Tags::` first on some, last on others). A new page in either namespace
should start with one consistent set of blank attributes, so the layout
stays the same without retyping it.

## Goals

- Opening a new `Paper/…` or `Book/…` page and clicking "Click to start
  writing…" adds the template's attribute blocks instead of one empty block.
- The templates are markdown files in `web/src/templates/`, so the layout can
  be read and changed without reading code.

## Non-goals

- Templates for other namespaces (adding one later is a new file, but no
  others ship now).
- Templates editable from inside the PKM.
- Seeding from the CLI or MCP (`pkm save -p "Paper/…"`): agents write their
  own content.
- Back-filling or reordering existing Paper/Book pages.

## Anti-goals

- Writing to a page because someone opened it: the template goes in only on
  the explicit click, so viewing a page never writes, and two devices
  opening the same new page cannot both add it.

## Approaches

| Approach | Verdict |
|---|---|
| Seed in the web app when "Click to start writing…" is clicked on an empty page | **Chosen.** Every in-app way of making a page (search's "Create page", following a `[[link]]` to a new title, picking a new title in autocomplete) lands on that empty page, and the click is one undoable action. |
| Seed on the server when the page is created | Rejected: a `[[Paper/X]]` typed in a block creates the page implicitly without that path, and the CLI and agents would get it too. |
| Seed automatically when an empty page is opened | Rejected: writes on view, and two devices could both seed the same page. |

Within the chosen approach, the template text lives in markdown files rather
than a table in code, at Arthur's request, so the layout is visible at a
glance.

## Decided

The templates:

`web/src/templates/Paper.md`

```markdown
- Tags:: #Paper
- URL::
- Date::
- Local copy::
```

`web/src/templates/Book.md`

```markdown
- Tags:: #Book
- Author::
- Reading Status::
- Published::
- Format::
- Summary::
```

- The file name is the namespace: `Paper.md` applies to titles that start
  `Paper/`, `Book.md` to titles that start `Book/`. Matching is exact and
  case-sensitive, so `Books/` and `paper/` get the ordinary empty block.
- Each `- ` line becomes one top-level block, in file order.
- `#Paper` / `#Book` come pre-filled in `Tags::`.
- After seeding, the caret sits at the end of the `Tags::` block (the first
  block).
- One undo removes the whole template.
- Any other title behaves as today: one empty block, caret in it.

## Calls made (correct any of these)

- **Location:** `web/src/templates/`. Only the SPA reads the files; they are
  bundled at build time like `docs/keyboard.md` is for `/help`, so they work
  offline and change with a deploy.
- **Trailing space:** markdown editors strip trailing whitespace, so a block
  whose text ends in `::` gets one space appended, putting the caret where
  the value goes when you click into it.
- **Flat only:** templates are a flat list. A file with any other line shape
  (indented, missing `- `) fails a unit test rather than seeding something
  surprising.

## Left to the builder

- How the files are loaded (a Vite `import.meta.glob` of `?raw` files is the
  expected route) and where the pure "title → template blocks" function
  lives; it is Functional Core.
- Test shape: unit tests for parsing and title matching, one for the seeded
  ops in `createFirstBlock`, and one Playwright spec that creates a `Paper/`
  page and checks the blocks appear.
