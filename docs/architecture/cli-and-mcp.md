# CLI and MCP server (`pkm/cli/`, `pkm/mcp/`, `pkm/client/`)

`pkm` (CLI) and `pkm-mcp` (FastMCP stdio server) are thin shells over the same
HTTP client. They talk to the running server's API, never to SQLite directly,
so they get the same validation, conflict handling, journalling and broadcasts
as the web client. The user-facing reference is [docs/cli.md](../cli.md); the
API they call is the reference table in
[backend.md](backend.md#http-api-reference).

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

`cli/build.py` (Core) holds the planners:

- `plan_save` — indented outline text → create ops
- `plan_batch` — the `pkm batch` command language (`create`, `todo`,
  `update`, `move`, `delete`, `outline`, `as`-aliases, matched-or-created
  `## Heading` parents)
- `plan_update` — a text replacement → `update_text` + `set_heading`
- `plan_mark` — a task-marker change → `update_text` with the marker applied,
  plus a `base_text_hash` guard, and deliberately never `set_heading`
- `split_heading` — strips `#`/`##`/`###` off a line into a heading level 1-3
- `asset_block_text` — MIME → image embed / `{{[[pdf]]}}` macro / link

A `## Heading` parent spec matches on level and text together, taking the
first block in document order if more than one matches. The in-batch memo for
headings created earlier in the same batch follows the same rule, so a heading
resolves to the same parent whether it came from the fetched page or from
earlier in the batch.

`cli/render.py` (Core) renders API payloads to terminal markdown.

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
callers that don't know or care how a section is marked up. Before the two
modes were separated, the marker was stripped and both forms behaved as bare,
so `--section "## Notes"` could return an H3 or a plain block.

Blank-vs-heading is the only leniency: text still matches exactly. A miss
raises `RenderError` listing the page's headings *with* their level markers, so
the error text tells you which spelling to ask for next. The `{1,3}` bound on
the marker matches the app's whole heading domain (`HEADING_COMMANDS` in
`web/src/outline/slashCommands.ts` offers h1–h3 only), so a `####` spec is read
as bare text, which still finds the block by exact text whatever its level.

## Headings are text

Text is the source of truth for a block's heading level on every CLI/MCP
write. `split_heading` runs in `_Planner.creates` — the one call site every
create path funnels through — and in `plan_update`. So `## X` is never stored
as literal text, and `render_page`/`render_block`'s `## text` output reads back
as a heading.

Deliberate exclusions: `#Tag` (no space), `#### ` and deeper (blocks carry
levels 1-3), and multi-line text, which stays verbatim in one block. The
`-D`/`-T`/`mark=` task-marker paths use `plan_mark`, not `plan_update`, and
never emit `set_heading`: the text they read back is already bare, so splitting
it would demote a real heading.

The heading round trip is `pkm get`/`get_page`/`get_block` only.
`render_groups`, `render_backlinks` and `render_search` — the renderers behind
`pkm todos`, `query`, `refs` and `search` — print `item.text` bare, because
the response models behind them (`GroupItem`, `BacklinkItem`,
`SearchBlockHit`) carry no `heading` field: `backlinks.py` and
`routes_search.py` select only `uid` and `text`, plus `breadcrumbs` for
backlinks. Copying a heading's text out of one of those verbs into
`pkm update`/`update_block` therefore demotes it silently. Making that
round-trip-safe would mean a new response field on three models, new query
columns in `backlinks.py`/`routes_search.py`, and an openapi/gen-types regen,
which was judged out of proportion to the CLI-only papercut it fixes. The gap
is documented instead of fixed.

## Writes, uids and missing pages

Writes go through `POST /api/ops` with a fresh `batch_id`. `pkm update` fetches
the current text first and rides the `base_text_hash` conflict path.

Every uid minter in this project resamples until the first character is
alphanumeric: `client/api.py::new_uid` (Python CLI/MCP client),
`server/ops_apply.py::_new_uid` (the conflict-sibling uid) and
`web/src/uid.ts::newUid` (the SPA, via `uidCore.ts::isAlphanumericByte`).

`UID_RE` (`contracts/ops.py`) itself still *accepts* a leading `-` or `_`, so
existing blocks can have one: a Roam import, or a block created by an older
web build. A bare uid CLI argument starting with `-` is parsed by argparse as
an unknown option. `pkm get` and `pkm update` take a uid as a plain
positional, so addressing one of those older uids needs the standard argparse
`--` end-of-options marker, e.g. `pkm get -- -abc123`. Any `-D`/`-T` flags
must come before the `--`, since everything after it is positional. Any future
tightening of `UID_RE` to reject a leading `-`/`_` must apply to newly-minted
uids only. Existing blocks that already hold one must stay addressable by uid
for updates and moves, which a naive regex change would break, so that change
needs its own migration-aware work item.

A page a write targets that doesn't exist yet is never created by a separate
request. `PkmClient.get_page_blocks` returns `([], True)` — an empty block list
plus a "missing" flag — and the shared workflow (`save_blocks`, `apply_batch`,
`upload_and_link` in `client/workflows.py`) prepends a `create_page` op
(`build.create_page_ops`) to the same `OpBatch` the planned blocks ride in.
Blocks are all a planner needs. They are also the only part of a page payload
a missing page can honestly stand in for, since there is no id or timestamp to
invent. That is why the method hands back blocks rather than a synthesized
payload. It keeps the "one atomic transaction" contract real: a batch that
fails validation after this point leaves neither the page nor its blocks
behind, because the whole batch, page creation included, rolls back together.

`get_page_blocks` looks up `refs.normalize_title(title)`, not `title`
verbatim. A page whose title held control whitespace is only ever stored, and
addressable, under its normalized spelling. A caller still holding the
pre-normalization string — a second save to the same page, say — would
otherwise get a false "missing". It would then plan its next write against an
empty page, prepending fresh content and re-creating any `## Heading` parent
the first write already made. The `create_page`/`create` ops built from that
call still carry the caller's original, un-normalized `title` for
`page_title`, which is fine: the server normalizes it again at the same
`get_or_create_page` choke point and lands on the identical row either way.

`PkmClient.get_backlinks`, used by the CLI's `refs` command and the MCP
`backlinks` tool, loops `GET /api/page`'s `bl_offset`/`bl_limit` pagination
until every group is fetched, rather than rendering just the first page. The
route caps a single response at 100 groups, but the CLI/MCP wording promises
the complete backlink list, and no user-visible output in this project
truncates silently. The aggregate `Backlinks.limit` is the first response's
observed, server-clamped page size, or 0 only if no response established one;
it is never the final number of groups synthesized as a fake request limit.

The route sorts backlink sources by `(updated_at DESC, title)`, which is
stable across `get_backlinks`'s sequential requests only if no source page's
`updated_at` changes mid-fetch — a concurrent write from another CLI/MCP
process, for instance. A rank shift across a page boundary produces a
duplicate page_id, a total short of what the server reported, or both.
`_fetch_backlinks_once` detects either symptom, and `get_backlinks` restarts
the whole fetch from offset 0, bounded by `_BACKLINK_MAX_ATTEMPTS`. It raises
rather than ever returning a possibly skipped or duplicated set. `get_page`
itself, used for a page's own content, is unchanged and still returns one page
of backlinks alongside the blocks.

## The MCP tool surface

The MCP server exposes eleven tools: seven reads (`get_page`, `get_block`,
`search`, `query`, `backlinks`, `todos`, `search_assets`) and four writes
(`save_note`, `update_block`, `batch`, `upload_asset`), built from the same
planners. Reads return markdown annotated with `^uid` markers that the write
tools accept. The embedded assistant's `policy.py` splits them along exactly
that read/write line (see
[assistant-and-files.md](assistant-and-files.md#embedded-assistant-pkmassistant)),
so adding a tool means deciding which tuple it joins.
