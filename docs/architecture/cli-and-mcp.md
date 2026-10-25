# CLI and MCP server (`pkm/cli/`, `pkm/mcp/`, `pkm/client/` + the shared planners)

`pkm` (CLI) and `pkm-mcp` (FastMCP stdio server) are thin shells over the same
HTTP client. They talk to the running server's API, never to SQLite, so they get
the same validation, conflict handling, journalling and broadcasts as the web
client. [docs/cli.md](../cli.md) owns the user-facing syntax and output,
[backend.md](backend.md#http-api-reference) the API they call. Failures are
indexed by symptom in [troubleshooting.md](../troubleshooting.md).

| File | Pattern | Role |
|---|---|---|
| `cli/main.py` | Shell | argparse verbs (`cmd_*`), exit codes |
| `mcp/tools.py` | Shell | The MCP tool functions and their LLM-facing docstrings |
| `mcp/server.py` | Shell | `build_server()` registers `TOOLS` on a `FastMCP`, or the subset `--tools` names. Only `pkm-mcp` imports it: constructing a `FastMCP` configures the root logger, and the web server imports the tool signatures for the assistant's write preview |
| `client/api.py` | Shell | `PkmClient`: config, session cookie, every HTTP call |
| `client/core.py` | Core | Config format, cookie header, error-message shaping |
| `client/workflows.py` | Shell | The write workflows both shells call, so an ordering fix lands once |
| `planning.py` | Core | Plans one write (`plan_save`, `plan_update`, `plan_mark`); `Planner` models live siblings |
| `batch.py` | Core | The `pkm batch` command language on top of `planning.py` |
| `render.py` | Core | API payloads → terminal markdown with `^uid` markers |

## The MCP tool surface

Tools are built from the same planners as the CLI, and reads return markdown
annotated with `^uid` markers that the write tools accept. The assistant's
`policy.py` auto-allows reads and confirm-gates writes
([assistant.md](assistant.md)), so a new tool must join `READ_TOOLS`,
`WRITE_TOOLS` or `MCP_ONLY_TOOLS` (`test_every_mcp_tool_is_classified` fails
otherwise).

| Tool | Kind | Does |
|---|---|---|
| `get_page` | read | a page as a `^uid`-annotated markdown outline |
| `get_block` | read | one block's subtree with page + breadcrumb context |
| `search` | read | full-text over page titles and block text |
| `query` | read | structured block query (`{and: [[A]] [[B]]}`, Roam syntax) |
| `backlinks` | read | everything referencing `[[title]]`, grouped by source page |
| `todos` | read | open `{{TODO}}` blocks, grouped by page |
| `changed_blocks` | read | blocks edited/created in a `since`/`until` window, grouped by page, tagged new/edited |
| `search_assets` | read | uploads by image description or filename |
| `save_note` | write | create block(s); multi-line text becomes an outline, default page is today's daily note |
| `update_block` | write | replace a block's text or set its task marker |
| `batch` | write | several commands in one atomic transaction; skipped ops are flagged with `warning:` |
| `upload_asset` | write, `pkm-mcp` only | upload a local file and link it from a page |
| `rename_page` | write | retitle a page, rewriting every reference to it; 409 unless `allow_merge`; 422 when a rewritten block would be past a [text limit](backend.md#page-mutations-and-the-sidebar) |

The operator checks `pkm local check` and `pkm goodlinks check` have no MCP
counterpart ([docs/cli.md](../cli.md#reading)).

## The shared client

`PkmClient` sends the token from `~/.config/pkm-cli/config.json` as the
`pkm_session` cookie. Every method returns a validated `pkm/contracts/responses.py` model. A 2xx body that fails
its model raises `ResponseSchemaError`, naming the endpoint and field path.
Unknown extra fields are ignored, so an older CLI works against a newer
server.

A title or uid placed in a URL path goes through `_segment`, which
percent-encodes every `/` and `.` (query params and JSON bodies are encoded by
httpx). The read tools are auto-approved, so a title such as
`../sync/snapshot` must not become a dot segment that httpx normalises onto
another route. The server decodes the path before routing, so namespaced
titles still match `{title:wholepath}`.

## Shared write workflows

`upload_and_link` validates the destination page and parent before
`POST /api/assets`. If the linking `/api/ops` write then fails, it deletes the
asset only when the upload's `existing` was `false`, since a dedup hit may
already be referenced elsewhere ([the asset store](files-and-assets.md#assets-and-the-file-browser)).

## Writes, uids and missing pages

Writes go through `POST /api/ops` with a fresh `batch_id`. The server skips an
op on a missing block, or a move that would make a cycle, rather than refusing
the batch. The ack's `skipped` list is then the only sign of a mistyped uid,
so `render.render_ops_ack` leads with `warning:` and `cmd_batch` exits 1. The
MCP `batch` tool shares `workflows.apply_batch`, so it fetches and guards the
same way.

| Write | Fetched first | Guard sent | Uid not found |
|---|---|---|---|
| `pkm update`, `update_block` | the block | `base_text_hash` | 404 before any op is sent |
| batch `update`, `move` | nothing | none | skipped by the server |
| batch `delete` | the subtree (`_delete_subtrees`) | `base_subtree_hash` | sent unhashed, then skipped |
| batch `delete` of an `{{alias}}` | nothing | none | — (the batch created it) |
| batch `delete` of a malformed uid | the fetch 422s | — | the whole batch is refused, nothing sent |

`_delete_subtrees` scales with pages, not deletes. A uid on a page the batch
already fetched costs nothing; otherwise `GET /api/block/{uid}` names its page,
which is fetched once for every later delete on it.

`contracts/ops.py::new_uid` and `web/src/uid.ts::newUid` mint uids starting
with an alphanumeric. `UID_RE` still accepts a leading `-` or `_`, so older
blocks stay addressable; tighten only the minters, never `UID_RE`.

A page a write targets is never created by a separate request.
`PkmClient.get_page_blocks` reports a missing one as `([], True)`, and the
workflow prepends a `create_page` op (`planning.create_page_ops`) to the same
`OpBatch`, so a batch that fails validation leaves neither behind. The lookup
uses `refs.normalize_title`, because pages are stored only under the
normalized spelling.

`PkmClient.get_backlinks` follows `bl_offset`/`bl_limit` to the end, because
no output in this project truncates silently. When a concurrent write shifts a
source between pages (`_fetch_backlinks_once`), it restarts, up to
`_BACKLINK_MAX_ATTEMPTS`, then raises rather than return a partial set.

## Pure planners

`planning.py` plans one write; `batch.py` plans a batch on top of it. Every
`Planner` method takes a resolved parent uid. Turning a spec into one is
`batch.py`'s job, since aliases and in-batch uids are batch bookkeeping.

`validate_batch` checks the envelope against strict (`extra="forbid"`) params
models before anything else, so a malformed batch fetches and creates nothing.
It also runs `batch_aliases`, which refuses an `{{alias}}` used before (or by)
the command that makes it and an `as` name given twice; `plan_batch` runs it
too, so a caller that skips `validate_batch` gets the same error. Checks that
need the fetched pages, such as a missing move-target heading, stay in the
planner.

Two spellings of one page share one fetch and one sibling model (`page_keys`),
or each would append from the same blocks and collide. Only the server's
plain-space flag says whether ` Foo` and `Foo` are one page, so `apply_batch`
reads it (`PkmClient.plain_space_title_canonicalization`) when boundary spaces
alone tell two spellings apart (`title_flag_needed`).

`plan_batch` threads a `_BatchCtx` through the commands and resolves each
parent spec by its form:

| Parent spec | Resolved by | First child's `order_idx` |
|---|---|---|
| `((uid))` on the fetched page | `resolve_parent`, which walks fetched blocks | `order_idx_at_position` |
| `((uid))` created earlier in this batch | `_in_batch_uid`, since `resolve_parent` cannot see it | 0 |
| `{{alias}}` | `_resolve_alias`, to the `((uid))` an earlier `as` recorded | 0 |
| `## Heading` on the fetched page | `resolve_parent`, on level and text, first in document order | `order_idx_at_position` |
| `## Heading` not there yet | `Planner.heading`, memoized per (page, level, text) | 0 |

A `_SubtreeModel` follows each fetched delete target through the batch's ops,
so a later `delete` hashes the tree the server will hold when it applies. A
block moved in from outside makes the delete hashless, since no fetch
describes its subtree.

`order_idx` is sparse: a delete leaves a gap and nothing renumbers. So
`order_idx_at_position` never counts siblings, and an append lands one past
the last sibling's key. `Planner` keeps a live sibling list per (page, parent).
The batch `index` param is a position, not a key, counted against the page as
fetched and then as earlier commands left it. A move's position counts the
destination's children without the moving block, and a position past the end
appends. `order_idx_at_position` is the
only place a position becomes an `OrderIdx`. The model does not simulate an op
the server will skip, so a later position in that op's groups can be off (see
the `Planner` docstring).

## Section selection

`pkm get --section SPEC` (`render.py::select_section`) picks its mode from
the spec's syntax.

| Spec | Selects |
|---|---|
| marked (`## Notes`) | the first block whose heading level and text both match |
| bare (`Notes`) | the first block with that exact text at any level, plain blocks included |

A marked spec uses the same rule as `--parent`, so the two agree on which
`Notes` they mean. `_SECTION_MARKER` allows one to three `#`, the app's whole
heading domain (`HEADING_COMMANDS`), so `####` is bare text.

## Heading round trip

Text is the source of truth for a block's heading level on every CLI and MCP
write. `split_heading` runs in `Planner._one` and `plan_update`, so `## X` is
never stored as literal text and `render_page` output reads back as a heading.
The exclusions are in [docs/cli.md](../cli.md#writing).

The task-marker paths use `plan_mark`, which never emits `set_heading`: the
text they read back is already bare, so splitting it would demote a heading.
Only `get`/`get_page`/`get_block` round-trip a heading, because `GroupItem`,
`BacklinkItem` and `SearchBlockHit` carry no `heading` field.
