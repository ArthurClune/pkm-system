# Synthetic test and development data — design (pkm-2xh2)

Bean: `pkm-2xh2` — create a small, committed dataset that is useful both as
selective automated-test input and as the starter graph for local development.

## Decision summary

Commit a human-readable synthetic graph and two small valid media fixtures under
`test-data/`. A deterministic Python generator builds the normal ignored
`data/` runtime directory from those sources. Existing focused unit fixtures and
temporary test databases remain isolated; tests use the shared dataset only
where it is the appropriate subject of the test.

Rejected alternatives:

- **Committed SQLite database**: immediately runnable, but opaque in review,
  vulnerable to binary churn, and difficult to update safely as the schema
  changes.
- **Import-export fixture as the canonical graph**: would exercise the importer,
  but would couple local development data to an external application's export
  format and make routine fixture editing harder.
- **Migrating all tests to one shared database**: would create order dependence
  and broad coupling between otherwise focused tests.

## Repository layout

`test-data/` contains only committed source fixtures and usage instructions:

- `graph.json`: pages, nested blocks, presentation attributes, and sidebar
  entries. Stable synthetic UIDs and timestamps make assertions predictable.
- `assets/sample.svg`: a small valid image fixture.
- `assets/sample.pdf`: a small valid PDF fixture.
- `README.md`: commands to generate a local graph and a brief description of
  fixture coverage.

The generator lives in the server package so it can reuse the current schema,
reference parser, and database initialization rather than duplicating them. It
accepts explicit source and output paths; its documented default source is the
repository's `test-data/graph.json`, and the documented development output is
`data/`.

Generated state remains uncommitted:

- `data/pkm.sqlite3`
- `data/assets/<first-two-sha256-characters>/<sha256>`; graph URLs use
  `/assets/<sha256>/<filename>`
- `data/config.json`, created separately by the existing server setup command

## Dataset content

The graph is intentionally small and readable. Its pages and blocks jointly
exercise:

- a daily/journal page;
- page links, tags, attributes, backlinks, block references, and embeds;
- nested, numbered, and collapsed outlines;
- Markdown tables, inline code, fenced code, and Mermaid fences;
- inline math, display math, and malformed math fallback text;
- TODO syntax;
- a Unicode/emoji page title;
- a content-addressed image reference; and
- a `{{pdf: ...}}` macro targeting the PDF fixture.

The text uses neutral fictional examples. Media fixtures are valid renderable
files rather than placeholder byte strings.

## Generation flow

1. Read and validate `graph.json` before touching the destination. Validation
   rejects duplicate page titles or UIDs, missing parents, invalid presentation
   values, unknown asset names, and malformed nesting.
2. Hash the committed media fixtures, derive their `/assets/<sha>/<filename>`
   URLs, and substitute named asset placeholders in block text.
3. Build a fresh SQLite database with `pkm.server.db.init_db` and insert pages,
   blocks, sidebar entries, asset rows, and parser-derived page references.
   Referenced titles without explicit pages are created consistently with normal
   application behavior.
4. Copy media into the content-addressed asset store.
5. Publish the database and asset directory only after successful generation.
   Existing graph data is never overwritten implicitly. A clear error tells the
   developer to choose an empty output directory or explicitly remove the old
   generated graph. An existing `config.json` may be retained so regenerating a
   sample graph does not reset local authentication.

Failures leave the previous destination usable and return a non-zero exit code
with the invalid field or filesystem operation identified.

## Development workflow

The README setup path becomes:

1. Generate `data/` from `test-data/`.
2. Run the existing password/configuration setup command.
3. Start the server against `data/` and start the Vite development server.

The import instructions remain available as the optional path for developers
who want to replace the sample graph with their own export.

## Testing

- Add server unit tests for source validation and asset-placeholder expansion.
- Add a server integration test that generates into `tmp_path`, then checks key
  page/block/ref/sidebar rows, content-addressed assets, and valid FTS results.
- Reuse `test-data/assets/sample.pdf` in the Playwright PDF rendering test rather
  than maintaining a separate in-process PDF fixture.
- Keep the main pytest `seeded_config`, specialized importer fixtures, in-memory
  web databases, and Playwright's fresh temporary server database unchanged.
- Add a repository guard test that fails if the committed graph source does not
  include the agreed feature examples or refers to missing media.

Before completion, run the full server tests with coverage, server type check,
server lint, and `pnpm verify` for the web application.
