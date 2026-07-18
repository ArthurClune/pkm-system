# Test data

This directory contains a small synthetic graph and valid SVG/PDF assets for
selective automated tests and local development. It covers journals, links and
backlinks, block references and embeds, nested/numbered/collapsed blocks,
tables, code, Mermaid, math fallback, TODOs, Unicode titles, and local assets.

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
