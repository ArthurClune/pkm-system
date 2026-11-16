# Test data

This directory contains a small synthetic graph and valid SVG/PDF assets for
selective automated tests, local development and the `verify` skill's scratch
server. It covers journals, links and backlinks, block references and embeds,
nested/numbered/collapsed blocks, markdown and `{{table}}` tables, code,
Mermaid, math fallback, TODO and DONE items, Unicode titles, local assets,
`Paper/` and `Book/` pages laid out like their templates in
`web/src/templates/`, queries in each view (`Reading List`), and a page long
enough to scroll (`Garden Journal Archive`).

`server/tests/test_test_data_fixture.py` checks that the graph keeps covering
these, and `test_test_data_generator.py` that each query view has records to
show. A new feature worth seeing on first run gets a page or block here.

Generate the ignored local runtime data from the repository root:

```bash
uv sync --project server
uv run --project server python -m pkm.test_data.generate --out data
cd server
uv run python -m pkm.server.setup --data-dir ../data --insecure-cookie
uv run python -m pkm.server.run --data-dir ../data
```

The generator refuses to replace an existing database or asset directory. Stop
the server and remove the generated database/assets before regenerating; a lone
`data/config.json` is retained.
