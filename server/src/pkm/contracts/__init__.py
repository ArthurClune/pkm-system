"""The wire contract between the PKM server and everything that talks to
it -- the web app (via the generated OpenAPI types), the CLI, and the MCP
server.

This package is deliberately dependency-free domain code: it imports
nothing from `pkm.server` and nothing from `pkm.client`, so both sides can
depend on it and neither depends on the other. Before it existed, the CLI
and MCP server reached into `pkm.server.ops_core` / `pkm.server.daily` for
shapes they needed, which pointed the dependency arrow backwards --
client-side code compiled against server internals (pkm-0wr8).

* `ops` -- the write contract: the op models POST /api/ops accepts.
* `responses` -- the read contract: the JSON shapes the API returns.
* `daily` -- the daily-note title convention both sides address pages by.
"""
