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
- **One-shot importer** from a Roam EDN export, preserving uids, ordering and
  timestamps
- **Nightly backups**: rotated SQLite snapshots plus a git-committed
  markdown export

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

```bash
cd server
uv sync            # creates .venv and installs deps (incl. dev group)
uv run pytest      # run the backend test suite
```

Create a data directory with a `config.json` (prompts for the app password;
`--insecure-cookie` lets the session cookie work over plain http in dev):

```bash
uv run python -m pkm.server.setup --data-dir ../data --insecure-cookie
```

Then run the server (defaults: `--data-dir data`, port 8974, binds the
`bind_hosts` from config — `127.0.0.1` by default):

```bash
uv run python -m pkm.server.run --data-dir ../data
```

### 2. Importing your Roam graph (optional)

Export your graph from Roam as **EDN** (not markdown — that loses uids and
structure) and download the linked files, then:

```bash
cd server
uv run python -m pkm.importer.run /path/to/export.edn \
  --files /path/to/linked-files --out ../data
```

Each run builds a fresh database and atomically swaps it in, ending with a
report of everything imported (and anything unrecognised — nothing is
silently dropped). It's safe to re-run.

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
