"""The wire contract between the PKM server and everything that talks to
it -- the web app (via the generated OpenAPI types), the CLI, and the MCP
server.

It imports nothing from `pkm.server` and nothing from `pkm.client`, so
both sides can depend on it and neither depends on the other. The module
map in docs/architecture/backend.md lists its modules."""
