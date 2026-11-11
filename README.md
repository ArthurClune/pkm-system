# PKM

A self-hosted personal knowledge management app modelled on
[Roam Research](https://roamresearch.com/). It runs on your own Mac, and your
other devices reach it over [Tailscale](https://tailscale.com/).

## Features

An outliner-style notes app:

- **Daily notes** as the home view, with an infinite scroll of days
- **Nested blocks** with outliner editing, block references preserved from Roam
- **`[[page links]]`, `#tags`, `Attr::` attributes** and namespace pages
  (`[[AWS/SCP]]`), with **backlinks** and **unlinked references** per page
- **Full-text search** (SQLite FTS5)
- **`{{[[query]]}}` blocks** (`and`/`or`/`not` over page refs)
- **Images and PDFs** stored and served locally, content-addressed
- **Live sync** between open clients over a WebSocket (desktop + iPad)
- **An in-app LLM assistant** that can read your notes and, with your
  confirmation, write them (see [Assistant](#assistant))
- **Offline editing**: an installable PWA with a local replica of the whole
  graph; changes sync back on reconnect (see [Offline](#offline))
- **One-shot importer** from a Roam EDN export, preserving uids, ordering and
  timestamps
- **Nightly backups**: rotated SQLite snapshots plus a git-committed
  markdown export

## Offline

After one online visit, each browser keeps a full local replica of the graph
(SQLite compiled to WebAssembly, persisted by the browser), and a service
worker caches the app. A cold start with no network boots into your notes.

**Works offline:**

- Reading everything: daily notes, pages, backlinks, unlinked references,
  block references
- Editing blocks. Changes queue on the device and the header shows
  *"Offline — N changes pending"* until they reach the server
- Creating pages (from search) and daily notes
- Full-text search and `[[link]]` autocomplete
- Images you've viewed before (a bounded cache); others show a labelled
  placeholder

**Online-only**, and labelled as such in the UI: uploading images/files,
editing the sidebar, deleting pages, and `{{[[query]]}}` blocks.

**When edits collide** (the same block changed on two devices while one was
offline), the server keeps the last write per block and saves the losing text
as a `[[conflict]]` block on today's daily page, under a header for that block.
An offline edit to a block that was deleted in the meantime lands there too.

**Limits:** the first visit and login need a connection. The replica is
per-browser, so a new device or a cleared browser profile starts online. If
the device runs out of local storage while offline, editing pauses and says
why.

## Assistant

`Cmd/Ctrl+J` opens a chat panel backed by a Claude agent. Pick a model
(`MODELS` in `server/src/pkm/assistant/policy.py`) and ask it to find,
summarise or write notes.

The agent runs on the server. Its only tools are the `pkm` verbs, which reach
your graph through the same HTTP API as every other client. Reads run without
asking. Every write pauses for an Allow/Deny card in the chat showing the
operations it wants to apply. Conversations are held in memory, so a reload
starts a new one.

The assistant needs a logged-in Claude subscription on the machine running
the server. Without one, the assistant reports an error in the chat and the
rest of the app works as normal. Setup is in
[deploy/README.md](deploy/README.md#assistant-prerequisites).

## Why self-hosted

Notes last decades, so the app holding them should not be a subscription
service that can disappear, slow down, or lock the data in. This project
drops Roam's multi-user machinery, which a single-user graph never uses, in
exchange for:

- **Ownership**: everything lives in one SQLite file plus an assets directory
  on a machine you control. The nightly export is a plain-markdown copy you
  can leave with.
- **Simplicity**: the server is authoritative and applies block ops, with
  no CRDTs. Per-block last-write-wins is enough for one person.
- **Longevity**: block text is stored as unmodified Roam-flavoured markdown,
  and the stack (FastAPI, SQLite, React) is mainstream enough to stay
  maintained.

## Repository layout

```
server/     Python backend: FastAPI app, SQLite storage, Roam EDN importer,
            markdown export, nightly backup job
web/        TypeScript frontend: React + Vite SPA, Vitest unit tests,
            Playwright e2e tests
shared/     Fixtures that pin the Python and TypeScript implementations
            (ref grammar, title syntax, replica parity) to identical behaviour
test-data/  Synthetic graph and assets for tests and local development
deploy/     launchd + Tailscale Serve deployment for a Mac (see deploy/README.md)
perf/       Performance gate: counts and timings checked against baselines
proptest/   Property-check gate for sync, ops and outline editing
docs/       Architecture docs, user docs (CLI, keyboard,
            security) and the specs and plans under superpowers/
.claude/    Agent skills for this repo (verify, docs checks, and others)
```

The codebase follows the **functional-core / imperative-shell** pattern: pure
logic and I/O live in separate files, each declaring its role in a `# pattern:`
header comment (see `AGENTS.md`).

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

`pkm.server.setup` writes `data/config.json`, which holds the password and
cookie settings.

### 2. Importing your Roam graph (optional)

To replace the synthetic data with your Roam graph, export it as **EDN** (a
markdown export loses uids and structure) and download the linked files. Then:

```bash
cd server
uv run python -m pkm.importer.run /path/to/export.edn \
  --files /path/to/linked-files --out ../data
```

Stop the server first. Each run builds a fresh database and swaps it in, so
re-running is safe. The importer refuses while another connection holds the
database open, but an idle server holds none, so it cannot tell that one is
running. The run ends with a report of everything imported, every title it
cleaned up or merged, and anything unrecognised
([importer](docs/architecture/import-export-and-backup.md#importer-roam-edn--fresh-database)).

### Regenerating the local data

```bash
# Stop the server first.
rm -f data/pkm.sqlite3 data/pkm.sqlite3-wal data/pkm.sqlite3-shm
rm -rf data/assets
uv run --project server python -m pkm.test_data.generate --out data
```

This keeps your `data/config.json` and password.

### 3. Web app

```bash
cd web
pnpm install
pnpm dev           # Vite dev server on http://localhost:5173
```

The dev server proxies `/api`, `/assets` and `/login` to the backend on
`127.0.0.1:8974` unless `PKM_API_PORT` names another port (see
`web/vite.config.ts`). On a machine whose port 8974 is production, start a
scratch server and set `PKM_API_PORT` to its port first; unset, `pnpm dev`
writes to production.

Other web scripts:

```bash
pnpm test          # Vitest unit tests
pnpm test:coverage # unit tests with enforced coverage thresholds
pnpm typecheck     # tsc over the app, tooling, perf and e2e code
pnpm e2e           # build, then Playwright end-to-end tests
pnpm verify        # the whole web gate that merge requires (AGENTS.md § Testing)
pnpm build         # production build to web/dist
pnpm gen-types     # regenerate TS API types from the server's OpenAPI schema
```

`gen-types` is one step of several. After a server contract change, run
`uv run python -m pkm.regen` from `server/`; see
[backend.md](docs/architecture/backend.md#generated-artifacts-and-parity-fixtures).

To serve the built SPA from the backend without Vite, build it and set
`web_dist` in `config.json` (the setup script's `--web-dist` flag does this).

## Agent access (CLI and MCP)

The `pkm` CLI and an MCP server let scripts and LLM agents read and write the
graph from outside the browser. Both talk to the running server's HTTP API and
share one login:

    cd server && uv run pkm login --url http://127.0.0.1:8974

For Claude Code, add the MCP server from the repository root:

    claude mcp add pkm -- uv run --project server pkm-mcp

**[docs/cli.md](docs/cli.md)** has the command reference, the `pkm batch`
command language, MCP setup for other clients, and the title-canonicalization
procedure. Each verb's `--help` lists its arguments and examples.

## Deployment

Production runs as launchd services on a Mac behind Tailscale Serve for HTTPS
across the tailnet, with a nightly backup job. `deploy/install.sh` sets this
up; **[deploy/README.md](deploy/README.md)** covers install, update, backup
and restore.

## Documentation

- **[Architecture docs](docs/architecture/overview.md)**: how the codebase is
  organised, one file per area
- **Past failures** live in the beans under `.beans/`: search by symptom
  with `beans list -S '<error text>'`
- **[Security](docs/SECURITY.md)**: the threat model, what a logged-in session
  can reach, and the known limits; read it before exposing the app beyond
  your own devices
- **[Keyboard shortcuts](docs/keyboard.md)**: shortcuts and slash commands,
  also shown in the app at `/help`
- **Specs and plans** in `docs/superpowers/`: per-feature designs, their
  rejected alternatives, and how each was built
- **[CLI and MCP reference](docs/cli.md)**: every `pkm` verb, the batch
  command language, MCP setup, title canonicalization
- **[Deployment guide](deploy/README.md)**: install, update, backups, restore,
  troubleshooting
