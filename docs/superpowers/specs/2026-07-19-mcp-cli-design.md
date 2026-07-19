# MCP Server + CLI for LLM Access (pkm-w05j)

**Date:** 2026-07-19
**Bean:** pkm-w05j
**Status:** Approved design

## Goal

Give LLM agents first-class access to the PKM: a `pkm` CLI (for Claude Code and
other shell-capable agents, modeled on the roam CLI in
`~/code/llm/henderson/.claude/skills/roam`) and a `pkm-mcp` MCP server (for
Claude Desktop, claude.ai, and other MCP clients). Both ship in v1.

## Decisions

- **Access mode: HTTP API only.** All reads and writes go through the running
  server. Live clients stay in sync (ops broadcast over WebSocket), there is
  one write path (`POST /api/ops`), and the tools work against prod remotely.
  No direct SQLite access.
- **Auth: login once, cache the session cookie.** No server-side auth changes.
- **Stack: Python, inside the existing `server/` package.** Reuses the
  `ops_core` Pydantic models and the existing test infrastructure.
- **Structure: shared client library, two thin frontends.** `pkm.client` owns
  all API logic; the CLI and MCP server are adapters over it.
- **Scope: roam-CLI parity plus file/image upload.**

## Architecture

```
server/src/pkm/
  client/
    api.py     # pattern: Imperative Shell — httpx calls, cookie cache file
    core.py    # pattern: Functional Core — request/response shaping, uid generation
  cli/
    main.py    # pattern: Imperative Shell — argparse dispatch, stdin/stdout, exit codes
    render.py  # pattern: Functional Core — block tree -> markdown / JSON output
    build.py   # pattern: Functional Core — CLI args / batch JSON -> OpBatch
  mcp/
    server.py  # pattern: Imperative Shell — MCP stdio server, thin tool wrappers
```

- Console scripts in `server/pyproject.toml`: `pkm` (CLI) and `pkm-mcp` (MCP,
  stdio transport via the official `mcp` Python SDK).
- New runtime deps: `httpx`, `mcp`.
- Batches are built with the existing `ops_core` models so the client cannot
  construct op shapes the server rejects. Block uids are generated client-side,
  matching `UID_RE`.

## Auth and configuration

- `pkm login [--url URL]` prompts for the app password (or `--password-stdin`),
  calls `POST /api/login`, and writes `~/.config/pkm-cli/config.json`
  (mode 0600) containing `{url, session_token}`.
- Every request sends `Cookie: pkm_session=<token>`. Tokens are valid for one
  year. Any 401 exits with "session expired — run `pkm login`".
- `PKM_URL` env var overrides the configured URL (dev servers on other ports;
  prod owns 8974).

## Server additions (the only server changes)

1. `GET /api/block/{uid}` — a block's subtree plus page/breadcrumb context.
   Needed for `pkm get <uid>`; today only whole pages are fetchable.
2. `GET /api/todos?page=` — list blocks whose text starts with a
   `{{TODO}}`/`{{[[TODO]]}}` marker (after an optional `> ` quote prefix).
   A refs query cannot find these: the web app emits the bracket-less
   `{{TODO}}` variant, which creates no ref.

Both are read-only. `openapi.json` and the generated web types are regenerated
and committed with the route changes.

## CLI surface

| Task | Command |
|------|---------|
| Login / set server | `pkm login [--url URL]` |
| Fetch page | `pkm get "Page Title"` |
| Daily notes | `pkm get today` / `yesterday` / `tomorrow` |
| Fetch block subtree | `pkm get <uid>` |
| All TODOs | `pkm todos` |
| Page TODOs | `pkm todos -p "Page"` |
| Quick note (to today) | `pkm save "text"` |
| Note to page | `pkm save -p "Page" "text"` |
| Under heading/block | `pkm save --parent "## Heading"` / `--parent "((uid))"` |
| Add TODO | `pkm save --todo "Task text"` |
| Update block text | `pkm update <uid> "new content"` |
| Mark done / todo | `pkm update <uid> -D` / `-T` |
| Full-text search | `pkm search "term"` |
| Backlinks | `pkm refs "Page Title"` |
| Structured query | `pkm query "{and: [[A]] [[B]]}"` |
| Upload file/image | `pkm upload photo.jpg [-p "Page"] [--parent ...]` |
| Batch ops | `pkm batch < ops.json` |

Behaviour:

- **Output:** markdown by default (indented bullets, headings rendered);
  `--json` on the read verbs (`get`, `search`, `refs`, `query`, `todos`) for
  structured data with uids.
- **stdin:** `pkm save -` reads text from stdin (avoids leading-`-`
  flag-parsing). Multi-line input becomes sibling blocks; indentation
  (2 spaces or tab) becomes nesting, so a whole outline lands in one call.
- **`--parent "## Heading"`** finds or creates that heading block on the target
  page; `--parent "((uid))"` targets a block directly.
- **`save --todo`** prepends `{{TODO}} ` (the bracket-less variant the web app
  emits).
- **`upload`** POSTs to `/api/assets`, then appends a block to the target page:
  `![name](/assets/<sha>/<name>)` for images, the `{{[[pdf]]: ...}}` macro for
  PDFs, a plain link otherwise. `--no-block` uploads only and prints the URL.
- **`batch`** takes a JSON array of `{command, params}` items — `create`,
  `update`, `move`, `delete`, `todo`, `outline` — translated client-side into a
  single `OpBatch`, applied in one server transaction with a `batch_id` for
  idempotent retry. `outline` takes a nested string array and expands to
  create-ops.
- **Errors:** non-zero exit, one-line stderr message (401 → "run pkm login";
  connection refused → "is the server running at <url>?"). `update` sends
  `base_text_hash` when it has the current text, so concurrent edits 409
  rather than clobber.

Dropped from roam parity deliberately: `remember`, `table`, and `codeblock`
batch commands (`outline` plus fenced-code block text cover them), and
`get --todo` (promoted to the `todos` verb).

## MCP tools

Ten tools, each a thin wrapper over the same client calls, returning the CLI's
markdown (or compact JSON where uids matter):

| Tool | Maps to |
|------|---------|
| `get_page(title)` | `GET /api/page` — markdown tree, uids annotated |
| `get_block(uid)` | `GET /api/block/{uid}` |
| `search(q)` | `GET /api/search` |
| `query(expr)` | `GET /api/query` |
| `backlinks(title)` | page payload's backlinks |
| `todos(page?)` | `GET /api/todos` |
| `save_note(text, page?, parent?, todo?)` | ops batch; same indentation→outline rule as the CLI |
| `update_block(uid, text?, mark?)` | ops batch |
| `batch(commands)` | atomic OpBatch; same `{command, params}` schema as `pkm batch` |
| `upload_asset(path, page?, parent?)` | `POST /api/assets` + block append (server runs locally, reads the path itself) |

Registration snippets for Claude Code (`.mcp.json`) and Claude Desktop are
included in the implementation.

## Testing

- Functional cores (`render.py`, `build.py`, `client/core.py`, the two new
  endpoint cores) get plain unit tests: markdown rendering,
  indentation→tree parsing, batch translation, uid generation, todo matching.
- The client shell is tested against the real FastAPI app in-process via
  `httpx.ASGITransport` — full round-trips (login → save → get → update →
  search → upload) with no network or subprocess, on the existing conftest
  fixtures.
- CLI: invoke `main()` with argv, capture stdout/exit codes against the same
  in-process app. MCP: call tool functions directly.
- `pyrefly`, `ruff`, and the enforced coverage gate as usual.

## Rollout

- One bean (pkm-w05j), one worktree/branch.
- Follow-up (separate bean, not v1): a `.claude/skills/pkm` skill doc modeled
  on the roam skill, so agents in other repos know the command vocabulary.
