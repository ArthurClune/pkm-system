# PKM

A self-hosted personal knowledge management app — a replacement for
[Roam Research](https://roamresearch.com/) that runs on your own Mac and is
reached from your other devices over [Tailscale](https://tailscale.com/).

## What

An outliner-style notes app in the Roam mould:

- **Daily notes** as the home view, with an infinite scroll of days
- **Nested blocks** with outliner editing, block references preserved from Roam
- **`[[page links]]`, `#tags`, `Attr::` attributes** and namespace pages
  (`[[AWS/SCP]]`), with **backlinks** and **unlinked references** per page
- **Fast full-text search** (SQLite FTS5)
- **`{{[[query]]}}` blocks** (`and`/`or`/`not` over page refs)
- **Images and PDFs** stored and served locally, content-addressed
- **Live sync** between open clients over a WebSocket (desktop + iPad)
- **Offline editing**: an installable PWA with a local replica — read, edit
  and search your whole graph with no connection; changes sync back on
  reconnect (see [Offline](#offline))
- **One-shot importer** from a Roam EDN export, preserving uids, ordering and
  timestamps
- **Nightly backups**: rotated SQLite snapshots plus a git-committed
  markdown export

## Offline

After one online visit, each browser keeps a full local replica of the graph
(SQLite compiled to WebAssembly, persisted by the browser) and a service
worker caches the app itself — so a cold start with no network still boots
straight into your notes.

**What works offline:**

- Reading everything: daily notes, pages, backlinks, unlinked references,
  block references
- Editing blocks — changes queue durably on the device and the header shows
  *"Offline — N changes pending"* until they reach the server
- Creating pages (from search) and daily notes
- Full-text search and `[[link]]` autocomplete, served from the local replica
- Images you've viewed before (a bounded cache of recently seen assets);
  ones you haven't show a labelled placeholder

**Online-only** (the UI says so rather than failing): uploading images/files,
editing the sidebar, deleting pages, and `{{[[query]]}}` blocks.

**When edits collide** (same block changed on two devices while one was
offline), the server keeps per-block last-write-wins and preserves the losing
text as a `[[conflict]]` block next to the winner — nothing is silently
discarded. An offline edit to a block that was meanwhile deleted is appended
to today's daily note instead of vanishing.

**Limits to know about:** the first visit (and login) needs a connection; the
replica is per-browser, so a new device or a cleared browser profile starts
online; and if the device runs out of local storage while offline, editing
pauses (with a visible reason) rather than risking a silently lost change.

## Why

Notes are a decades-long asset; the app that holds them shouldn't be a
subscription service that can disappear, slow down, or hold the data hostage.
This project trades Roam's collaborative/multi-user machinery (which a
single-user graph never uses) for:

- **Ownership** — everything lives in one SQLite file plus an assets directory
  on a machine you control; the nightly export doubles as a plain-markdown
  escape hatch.
- **Simplicity** — server-authoritative block ops, no CRDTs, no sync protocol
  to debug. Per-block last-write-wins is plenty for one person.
- **Longevity** — boring, inspectable parts: FastAPI, SQLite, React. Block
  text is stored as unmodified Roam-flavoured markdown, so nothing is locked
  into this app either.

The **[design document](docs/design.md)** gives the high-level architecture
and the load-bearing decisions, linking through to the detailed specs and
implementation plans.

## Repository layout

```
server/   Python backend: FastAPI app, SQLite storage, Roam EDN importer,
          markdown export, nightly backup job
web/      TypeScript frontend: React + Vite SPA, Vitest unit tests,
          Playwright e2e tests
shared/   Fixtures shared between the Python and TS ref-grammar parsers,
          pinning both to identical behaviour
deploy/   launchd + Tailscale Serve deployment for a Mac (see deploy/README.md)
docs/     Design docs and implementation plans
```

The codebase follows the **functional-core / imperative-shell** pattern: pure
logic and I/O live in separate files, each declaring its role in a `# pattern:`
header comment (see `CLAUDE.md`).

## Setup (development)

### Prerequisites

- Python ≥ 3.12 and [uv](https://docs.astral.sh/uv/)
- Node.js and [pnpm](https://pnpm.io/)

### 1. Server

From the repository root:

```bash
uv sync --project server
uv run --project server pytest
uv run --project server python -m pkm.test_data.generate --out data
cd server
uv run python -m pkm.server.setup --data-dir ../data --insecure-cookie
uv run python -m pkm.server.run --data-dir ../data
```

`pkm.server.setup` creates `data/config.json` and remains responsible for the
password and cookie settings.

### 2. Importing your Roam graph (optional)

If you want to replace the synthetic fixture with a Roam export, export your
graph as **EDN** (not markdown — that loses uids and structure) and download
the linked files, then:

```bash
cd server
uv run python -m pkm.importer.run /path/to/export.edn \
  --files /path/to/linked-files --out ../data
```

Each run builds a fresh database and atomically swaps it in, ending with a
report of everything imported (and anything unrecognised — nothing is
silently dropped). It's safe to re-run.

### Regenerating the local data

```bash
# Stop the server first.
rm -f data/pkm.sqlite3 data/pkm.sqlite3-wal data/pkm.sqlite3-shm
rm -rf data/assets
uv run --project server python -m pkm.test_data.generate --out data
```

This preserves your `data/config.json` and authentication.

### 3. Web app

```bash
cd web
pnpm install
pnpm dev           # Vite dev server on http://localhost:5173
```

The dev server proxies `/api`, `/assets` and `/login` to the backend on
`127.0.0.1:8974` (see `web/vite.config.ts`), so run the server alongside it.

Other web scripts:

```bash
pnpm test          # Vitest unit tests
pnpm test:coverage # unit tests with enforced coverage thresholds
pnpm typecheck     # tsc
pnpm e2e           # build, then Playwright end-to-end tests
pnpm verify        # typecheck + coverage + Playwright (standard verification)
pnpm build         # production build to web/dist
pnpm gen-types     # regenerate TS API types from the server's OpenAPI schema
```

To serve the built SPA from the backend itself (no Vite), build it and set
`web_dist` in `config.json` (the setup script's `--web-dist` flag does this).

## CLI and MCP access

LLM agents (and humans) can drive the PKM from the command line or over MCP.
Both talk to the running server's HTTP API and share one login:

    cd server && uv run pkm login --url http://127.0.0.1:8974

This stores a year-long session token in `~/.config/pkm-cli/config.json`
(override the path with `PKM_CLI_CONFIG`; point at another server per-call
with `PKM_URL`).

CLI quick reference (`uv run pkm <cmd> --help` for details):

    pkm get "Page Title" | today | <uid>     # markdown; --uids / --json
    pkm todos [-p "Page"]
    pkm save [-p "Page"] [--parent "## H"|"((uid))"] [--todo] "text" | -
    pkm update <uid> "new text" | -D | -T
    pkm search "term" / pkm refs "Page" / pkm query "{and: [[A]] [[B]]}"
    pkm upload file.png [-p "Page"] [--no-block]
    pkm batch < commands.json                # atomic multi-op transaction

MCP (stdio) server for Claude Code — from the repo root:

    claude mcp add pkm -- uv run --project server pkm-mcp

or in `.mcp.json`:

    {"mcpServers": {"pkm": {"command": "uv",
                            "args": ["run", "--project", "server", "pkm-mcp"]}}}

For Claude Desktop, use the same command/args in
`claude_desktop_config.json` under `mcpServers`. Run `pkm login` once
first — the MCP server reads the same config file.

## Deployment

Production runs as launchd services on a Mac, fronted by Tailscale Serve for
HTTPS across the tailnet, with a nightly backup job (rotated SQLite snapshots
plus a git-committed markdown/assets export). `deploy/install.sh` sets all of
this up; **[deploy/README.md](deploy/README.md)** has the full install, update,
backup and restore procedures.

## Documentation

- **[Design document](docs/design.md)** — high-level architecture and key
  decisions, linking to the detailed specs and plans in `docs/superpowers/`
- **[Deployment guide](deploy/README.md)** — install, update, backups, restore,
  troubleshooting
- `docs/superpowers/plans/` — the implementation plans each phase was built
  from
