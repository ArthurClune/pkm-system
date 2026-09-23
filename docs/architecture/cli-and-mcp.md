# CLI and MCP server (`pkm/cli/`, `pkm/mcp/`, `pkm/client/` + the shared planners)

`pkm` (CLI) and `pkm-mcp` (FastMCP stdio server) are thin shells over the same
HTTP client. They talk to the running server's API, never to SQLite, so they get
the same validation, conflict handling, journalling and broadcasts as the web
client. [docs/cli.md](../cli.md) owns the user-facing syntax,
[backend.md](backend.md#http-api-reference) the API they call. Failures are
indexed by symptom in [troubleshooting.md](../troubleshooting.md).

## The MCP tool surface

Tools are built from the same planners as the CLI, and reads return markdown
annotated with `^uid` markers that the write tools accept. The embedded
assistant's `policy.py` keys on this read/write split — reads auto-allowed,
writes confirm-gated
([assistant.md](assistant.md#embedded-assistant-pkmassistant)) — so adding a tool
means deciding which side it joins.

| Tool | Kind | Does |
|---|---|---|
| `get_page` | read | a page as a `^uid`-annotated markdown outline |
| `get_block` | read | one block's subtree with page + breadcrumb context |
| `search` | read | full-text over page titles and block text |
| `query` | read | structured block query (`{and: [[A]] [[B]]}`, Roam syntax) |
| `backlinks` | read | everything referencing `[[title]]`, grouped by source page |
| `todos` | read | open `{{TODO}}` blocks, grouped by page |
| `search_assets` | read | uploads by image description or filename |
| `save_note` | write | create block(s); multi-line text becomes an outline, default page is today's daily note |
| `update_block` | write | replace a block's text or set its task marker |
| `batch` | write | several commands in one atomic transaction |
| `upload_asset` | write | upload a local file and link it from a page |
| `rename_page` | write | retitle a page, rewriting every `[[link]]`/`#tag`/`attr::` reference to it; 409 unless `allow_merge` |

`pkm local check` has no MCP counterpart: an operator diagnostic that audits
every `/api/local/` link in block text against the host's filesystem
(`GET /api/local/check`, see [backend.md](backend.md#local-documents)). Its exit
codes are in [docs/cli.md](../cli.md#reading). `pkm goodlinks check` is the
same shape against the GoodLinks library (`GET /api/goodlinks/check`); it
needs the GoodLinks app running on the host.

## The shared client

`client/api.py::PkmClient` owns all I/O: config at
`~/.config/pkm-cli/config.json` (session token from `pkm login`, sent as the
`pkm_session` cookie), HTTP via httpx2. Tests inject an in-process FastAPI
`TestClient`.

Every method returns a validated `pkm/contracts/responses.py` model, so a field
that drifts is a pyrefly error. A 2xx body that fails its model raises
`ResponseSchemaError`, naming the endpoint and field path; it is an `ApiError`,
so the CLI exits 1 with one line on stderr. Unknown extra fields are ignored, so
a newer server stays usable from an older CLI.

## Shared write workflows

`client/workflows.py` (Shell) holds the write workflows both shells perform:
`save_blocks`, `edit_block`, `apply_batch`, `upload_and_link`, and the
`default_page_title` rule (today's daily note). The ordering invariants below
live there, so an ordering fix lands once.

`upload_and_link` (`pkm upload`, the `upload_asset` tool) resolves and validates
the destination page and parent before `POST /api/assets`. If the linking
`/api/ops` write then fails it compensates with `DELETE /api/assets/{sha256}`,
but only when the response's `existing` bool was `false`, since a dedup hit's sha
may already be referenced by unrelated blocks. Asset store:
[files-and-assets.md](files-and-assets.md#assets-and-the-file-browser).

## Writes, uids and missing pages

Writes go through `POST /api/ops` with a fresh `batch_id`. `pkm update` fetches
the current text first and rides the `base_text_hash` conflict path.

Every uid minter resamples until the first character is alphanumeric:
`client/api.py::new_uid`, `server/ops_apply.py::_new_uid` and
`web/src/uid.ts::newUid` (via `uidCore.ts::isAlphanumericByte`). `UID_RE`
(`contracts/ops.py`) still accepts a leading `-` or `_`, so a block minted before
that rule stays addressable; any tightening must apply to newly-minted uids only.

A page a write targets is never created by a separate request.
`PkmClient.get_page_blocks` reports a missing one as `([], True)`, and the shared
workflows prepend a `create_page` op (`planning.create_page_ops`) to the same
`OpBatch` the planned blocks ride in, so a batch that fails validation leaves
neither behind. The lookup goes through `refs.normalize_title`, because pages are
only ever stored under the normalized spelling; the ops carry the caller's
spelling, which `get_or_create_page` normalizes onto the identical row.

`PkmClient.get_backlinks` (the `refs` command and the `backlinks` tool) loops
`GET /api/page`'s `bl_offset`/`bl_limit` pagination until every group is fetched,
because no user-visible output in this project truncates silently. Sources sort
by `(updated_at DESC, title)`, so a concurrent write can shift one between
requests; `_fetch_backlinks_once` detects that skew and `get_backlinks` restarts
from offset 0, bounded by `_BACKLINK_MAX_ATTEMPTS` and raising rather than
returning a partial set.

## Pure planners

Three top-level Core modules sit under no shell, used by the CLI, the MCP server
and `client/workflows.py` alike: `planning.py` plans a write, `batch.py` a
multi-command batch on top of it, `render.py` renders API payloads to terminal
markdown.

`planning.py`:

- `plan_save` — indented outline text → create ops
- `plan_update` — a text replacement → `update_text` + `set_heading`
- `plan_mark` — a task-marker change → `update_text` with the marker applied,
  plus a `base_text_hash` guard, and never `set_heading`
- `split_heading` — strips `#`/`##`/`###` off a line into a heading level 1-3
- `asset_block_text` — MIME → image embed / `{{[[pdf]]: <url>}}` macro / link
- `Planner` — the append counter per (page, parent) and the heading memo that
  consecutive commands share

Every `Planner` method takes a parent *uid*, already resolved; turning a *spec*
into one is `batch.py`'s job, since aliases and in-batch uids are batch
bookkeeping.

`batch.py` owns the `pkm batch` command language: `create`, `todo`, `update`,
`move`, `delete`, `outline`, `as`-aliases, matched-or-created `## Heading`
parents. `plan_batch` threads a `_BatchCtx` through the commands — the shared
`Planner`, the fetched pages, the alias map, the uids created so far — resolving
each parent spec by its form:

| Parent spec | Resolved by | First child's `order_idx` |
|---|---|---|
| `((uid))` on the fetched page | `resolve_parent`, which walks fetched blocks | `next_child_idx`, the parent's child count |
| `((uid))` created earlier in this batch | `_in_batch_uid`, ahead of `resolve_parent`, which cannot see it | 0 |
| `{{alias}}` | `_resolve_alias`, to the `((uid))` an earlier `as` recorded | 0 |
| `## Heading` on the fetched page | `resolve_parent`, on level and text together, first in document order | `next_child_idx`, the parent's child count |
| `## Heading` not there yet | `Planner.heading`, memoized per (page, level, text) | 0 |

`Planner.create_at` is the one create
that skips the append counter, taking the batch `index` param as `order_idx`
verbatim. Appends keep counting from the page's original child count, so an
indexed create and plain appends under one parent can interleave.

`validate_batch` parses the envelope against a discriminated-union command schema
with strict (`extra="forbid"`) params models, reporting the first bad item as one
`BuildError` naming its index and problem. `cli/main.py`'s `cmd_batch` and
`mcp/server.py`'s `batch()` both call it immediately after decoding the JSON
body, so a malformed batch never triggers a page fetch or any page/asset
creation. Checks a schema cannot express (an unknown `{{alias}}`, an unfetched
page, a missing move-target heading) stay in the planner.

## Section selection

`pkm get --section SPEC` (`render.py::select_section`) has two modes, chosen by
the spec's own syntax.

| Spec | Selects |
|---|---|
| *marked* (`## Notes`, one space after one to three `#`) | the first block in document order whose heading level **and** text both match |
| *bare* (`Notes`) | the first block with that exact text at any level, including a plain non-heading block |

A marked spec uses the same level-and-text rule as `--parent`, so the two cannot
disagree about which `Notes` they mean. A miss raises `RenderError` listing the
page's headings with their level markers. `_SECTION_MARKER`'s `{1,3}` bound
matches the app's whole heading domain (`HEADING_COMMANDS` in
`web/src/outline/slashCommands.ts` offers h1-h3), so a `####` spec is read as
bare text.

## Heading round trip

Text is the source of truth for a block's heading level on every CLI/MCP write.
`split_heading` runs in `Planner._one`, reached by `creates` and `create_at`, and
in `plan_update`; a `## Heading` parent spec that doesn't exist yet comes from
`Planner.heading()`, which matches the marker itself. So `## X` is never stored
as literal text, and `render_page`/`render_block`'s `## text` output reads back
as a heading. The exclusions (`#Tag`, `#### ` and deeper, multi-line text) are in
[docs/cli.md](../cli.md#writing).

The `-D`/`-T`/`mark=` task-marker paths use `plan_mark` and never emit
`set_heading`: the text they read back is already bare, so splitting it would
demote a real heading. The round trip is `pkm get`/`get_page`/`get_block` only:
the renderers behind `pkm todos`, `query`, `refs` and `search` (`render_groups`,
`render_backlinks`, `render_search`) print bare text — `item.text` for the
grouped verbs, `snippet` for search — because `GroupItem`, `BacklinkItem` and
`SearchBlockHit` carry no `heading` field.
