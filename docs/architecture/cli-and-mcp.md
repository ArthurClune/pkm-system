# CLI and MCP server (`pkm/cli/`, `pkm/mcp/`, `pkm/client/` + the shared planners)

`pkm` (CLI) and `pkm-mcp` (FastMCP stdio server) are thin shells over the same
HTTP client. They talk to the running server's API, never to SQLite directly,
so they get the same validation, conflict handling, journalling and broadcasts
as the web client. The user-facing reference is [docs/cli.md](../cli.md); the
API they call is the reference table in
[backend.md](backend.md#http-api-reference).

## The MCP tool surface

`pkm-mcp`'s tools are built from the same planners as the CLI. Reads return
markdown annotated with `^uid` markers that the write tools accept. The
embedded assistant's `policy.py` splits the tools along exactly this
read/write line — reads auto-allowed, writes confirm-gated (see
[assistant-and-files.md](assistant-and-files.md#embedded-assistant-pkmassistant))
— so adding a tool means deciding which side it joins.

| Tool | Kind | Does |
|---|---|---|
| `get_page` | read | fetch a page as a `^uid`-annotated markdown outline |
| `get_block` | read | fetch one block's subtree with page + breadcrumb context |
| `search` | read | full-text search over page titles and block text |
| `query` | read | structured block query (`{and: [[A]] [[B]]}`, Roam syntax) |
| `backlinks` | read | everything referencing `[[title]]`, grouped by source page |
| `todos` | read | open `{{TODO}}` blocks, grouped by page |
| `search_assets` | read | find uploads by image description or filename |
| `save_note` | write | create block(s); multi-line text becomes an outline, default page is today's daily note |
| `update_block` | write | replace a block's text or set its task marker |
| `batch` | write | apply several commands in one atomic transaction |
| `upload_asset` | write | upload a local file and link it from a page |

## The shared client

`client/api.py::PkmClient` owns all I/O: config at
`~/.config/pkm-cli/config.json` (session token from `pkm login`, sent as the
`pkm_session` cookie), HTTP via httpx2. Tests inject an in-process FastAPI
`TestClient`.

Every method returns a validated `pkm/contracts/responses.py` model, never a
bare dict, so the planners and renderers downstream read typed attributes and
a field that drifts is a pyrefly error rather than a `KeyError` in front of
the user. A 2xx body that doesn't satisfy its model raises
`ResponseSchemaError` — an `ApiError`, so the CLI still exits 1 with one line
on stderr — naming the endpoint and the offending field path. *Unknown extra*
fields are ignored on purpose, so a newer server stays usable from an older
CLI. These are full models rather than TypedDicts precisely because the
runtime validation is the point: a TypedDict would type the read without ever
detecting the drift.

## Shared write workflows

`client/workflows.py` (Shell) holds the write workflows the CLI and MCP server
both perform: `save_blocks`, `edit_block`, `apply_batch`, `upload_and_link`,
and the `default_page_title` rule (today's daily note). They were duplicated
line-for-line in both shells, which is how a fix could land in one and not the
other. The ordering invariants below — validate before any I/O, resolve the
parent before uploading, page creation inside the same batch — now live in one
place. Presentation stays split: these return values (the created ops, an
applied count) and each shell phrases them, the CLI by printing and the MCP
tools by returning strings.

`upload_and_link` resolves and validates the destination page and parent
*before* calling `POST /api/assets`. The upload response's `existing` bool
records whether the `assets` row was already there before this call (a dedup
hit) or is brand new. If the follow-up `/api/ops` write that links the asset
then fails, the CLI's `pkm upload` and the MCP `upload_asset` tool compensate
with `DELETE /api/assets/{sha256}` only when `existing` was `false`. Deleting
on a dedup hit would be wrong: the sha may already be referenced by other
blocks that have nothing to do with this call's failed write. The asset store
itself is covered in
[assistant-and-files.md](assistant-and-files.md#assets-and-the-file-browser).

## Pure planners

Three top-level Core modules, under no shell because the CLI, the MCP server
and `client/workflows.py` all use all three: `planning.py` plans a write,
`batch.py` plans a multi-command batch on top of it, `render.py` renders API
payloads to terminal markdown.

`planning.py`:

- `plan_save` — indented outline text → create ops
- `plan_update` — a text replacement → `update_text` + `set_heading`
- `plan_mark` — a task-marker change → `update_text` with the marker applied,
  plus a `base_text_hash` guard, and never `set_heading`
- `split_heading` — strips `#`/`##`/`###` off a line into a heading level 1-3
- `asset_block_text` — MIME → image embed / `{{[[pdf]]}}` macro / link
- `Planner` — the append counter per (page, parent) and the heading memo that
  consecutive commands share

Every `Planner` method takes a parent *uid*, already resolved. Turning a
parent *spec* into one stays with the caller: aliases and in-batch uids are
batch bookkeeping, and `batch.py` is what knows them.

`batch.py` owns the `pkm batch` command language: `create`, `todo`, `update`,
`move`, `delete`, `outline`, `as`-aliases, matched-or-created `## Heading`
parents. `plan_batch` walks the commands threading a `_BatchCtx` — the shared
`Planner`, the fetched pages, the alias map, and the uids created so far in
this batch. Those uids are on none of the fetched pages. `_in_batch_uid`
recognises a `((uid))` spec naming one, before `resolve_parent` — which walks
fetched blocks only — would reject it. The first child of such a parent starts
at `order_idx` 0, because no fetched page can supply its child count.

A `## Heading` parent spec matches on level and text together, taking the
first block in document order if more than one matches. The in-batch memo for
headings created earlier in the same batch follows the same rule, so a heading
resolves to the same parent whether it came from the fetched page or from
earlier in the batch.

`Planner.create_at` is the one create that skips the append counter: it takes
the batch `index` param as `order_idx` verbatim, for the server to splice
siblings after. Leaving the counter alone is why an indexed create and plain
appends under the same parent in one batch can interleave — the appends keep
counting from the page's original child count. `pkm batch --help` says so.

Batch bodies are validated before anything else happens. `validate_batch`
parses the whole envelope against a discriminated-union command schema, with
strict (`extra="forbid"`) params models per command, and reports the first bad
item as one `BuildError` naming that item's index and the specific problem.
Both `cli/main.py`'s `cmd_batch` and `mcp/server.py`'s `batch()` call it
immediately after decoding the JSON body, so a malformed batch never triggers
a page fetch or any page/asset creation. Checks that a schema cannot express —
an unknown `{{alias}}`, a page that was not fetched, a move target heading
that does not exist — stay in the planner.

## Section selection

`pkm get --section SPEC` (`render.py::select_section`) has two modes, and the
spec's own syntax decides which applies, rather than a flag.

A *marked* spec (`## Notes`, one space after one to three `#`) selects the
first block in document order whose heading level **and** text both match. That
is the same level-and-text rule `--parent` uses, so the two specs cannot
disagree about which `Notes` they mean.

A *bare* spec (`Notes`) selects the first block with that exact text at any
level, including a plain non-heading block. This is the lenient form, kept for
callers that don't know or care how a section is marked up.

Blank-vs-heading is the only leniency: text still matches exactly. A miss
raises `RenderError` listing the page's headings *with* their level markers, so
the error text tells you which spelling to ask for next. The `{1,3}` bound on
the marker matches the app's whole heading domain (`HEADING_COMMANDS` in
`web/src/outline/slashCommands.ts` offers h1–h3 only), so a `####` spec is read
as bare text, which still finds the block by exact text whatever its level.

## Headings are text

Text is the source of truth for a block's heading level on every CLI/MCP
write. `split_heading` runs in `Planner._one` — reached by every block a
caller explicitly asks to create (`creates`, `create_at`) — and in
`plan_update`. A `## Heading` parent spec that doesn't exist yet is instead
created by `Planner.heading()` from the spec `resolve_parent` reports
missing, which matches the same marker itself rather than calling
`split_heading`. Either way, `## X` is never stored as literal text, and
`render_page`/`render_block`'s `## text` output reads back as a heading.

Deliberate exclusions: `#Tag` (no space), `#### ` and deeper (blocks carry
levels 1-3), and multi-line text, which stays verbatim in one block. The
`-D`/`-T`/`mark=` task-marker paths use `plan_mark`, not `plan_update`, and
never emit `set_heading`: the text they read back is already bare, so splitting
it would demote a real heading.

The heading round trip is `pkm get`/`get_page`/`get_block` only. The
renderers behind `pkm todos`, `query`, `refs` and `search`
(`render_groups`, `render_backlinks`, `render_search`) print `item.text`
bare, because their response models (`GroupItem`, `BacklinkItem`,
`SearchBlockHit`) carry no `heading` field. Copying a heading's text out of
one of those verbs into `pkm update`/`update_block` therefore demotes it
silently — a documented gap (symptom table), judged out of proportion to fix:
three new response fields, new query columns in
`grouping.py`/`routes_search.py`, and an openapi/gen-types regen for a
CLI-only papercut.

## Writes, uids and missing pages

Writes go through `POST /api/ops` with a fresh `batch_id`. `pkm update` fetches
the current text first and rides the `base_text_hash` conflict path.

Every uid minter in this project resamples until the first character is
alphanumeric: `client/api.py::new_uid` (Python CLI/MCP client),
`server/ops_apply.py::_new_uid` (the conflict-sibling uid) and
`web/src/uid.ts::newUid` (the SPA, via `uidCore.ts::isAlphanumericByte`). `UID_RE` (`contracts/ops.py`) itself
still *accepts* a leading `-` or `_`, so existing blocks can have one — a
Roam import, or an older web build — and a bare leading-`-` uid argument
needs argparse's `--` end-of-options marker (symptom table). Any future
tightening of `UID_RE` must apply to newly-minted uids only: existing blocks
must stay addressable for updates and moves, so that change needs its own
migration-aware work item.

A page a write targets that doesn't exist yet is never created by a separate
request. `PkmClient.get_page_blocks` returns `([], True)` — an empty block
list plus a "missing" flag; blocks are all a planner needs, and the only part
of a page payload a missing page can honestly stand in for. The shared
workflows (`save_blocks`, `apply_batch`, `upload_and_link`) prepend a
`create_page` op (`planning.create_page_ops`) to the same `OpBatch` the planned
blocks ride in. That keeps the one-atomic-transaction contract real: a batch
that fails validation later leaves neither the page nor its blocks behind.
The lookup uses `refs.normalize_title(title)`, not the verbatim title. A
control-whitespace title is only ever stored under its normalized spelling,
so a caller still holding the original string would get a false "missing"
and plan its next write against an empty page. The ops built from that call
still carry the caller's spelling, which the server normalizes at the same
`get_or_create_page` choke point onto the identical row.

`PkmClient.get_backlinks` (the CLI's `refs` command and the MCP `backlinks`
tool) loops `GET /api/page`'s `bl_offset`/`bl_limit` pagination until every
group is fetched — no user-visible output in this project truncates
silently. The route sorts sources by `(updated_at DESC, title)`, so a
concurrent write can shift ranks across a page boundary mid-fetch, producing
a duplicate page_id or a total short of what the server reported.
`_fetch_backlinks_once` detects either symptom and `get_backlinks` restarts
from offset 0, bounded by `_BACKLINK_MAX_ATTEMPTS`, raising rather than ever
returning a possibly skipped or duplicated set.

## When something looks wrong

Each row is something a caller has actually hit, and the rule that answers
it.

| Symptom | Cause | Ref |
|---|---|---|
| `--section "## Notes"` returns an H3 or a plain block | the marker was once stripped so every spec behaved as bare; a marked spec now matches heading level and text together | — |
| A heading copied from `pkm todos`/`search`/`refs` output and written back with `pkm update` silently becomes plain text | those verbs' response models carry no `heading` field, so the text they print is bare; the round trip is `pkm get`/`get_page`/`get_block` only | — |
| `pkm get -abc123` fails with an unknown-option error | argparse reads a leading-`-` uid as a flag; use `pkm get -- -abc123`, with any `-D`/`-T` flags before the `--` | — |
