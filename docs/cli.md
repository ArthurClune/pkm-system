# pkm CLI and MCP access

The `pkm` CLI and the `pkm-mcp` server let people, scripts and LLM agents use
the PKM from outside the browser. Both call the running server's HTTP API, so
writes get the same validation, conflict handling and live sync as the web
app.

## Login

Both share one login:

```bash
cd server && uv run pkm login --url http://127.0.0.1:8974
```

`--url` defaults to `http://127.0.0.1:8974`. Login stores a year-long session
token in `~/.config/pkm-cli/config.json`. Two environment variables override
the defaults:

- `PKM_CLI_CONFIG`: use a different config file
- `PKM_URL`: talk to a different server for this call, with the config
  file's token

`pkm login --password-stdin` reads the password from stdin, for scripts.

## Command reference

`uv run pkm <cmd> --help` lists each verb's argument forms and examples.

    pkm get "Page Title" | today | yesterday | tomorrow | <uid>
                                             # markdown; --uids / --json
    pkm get "Page" --resolve-refs            # inline ((uid)) refs, cycle-safe
    pkm get "Page" --section "## H" [--depth N]   # subtree only (pages only)
    pkm get "Page" --section "H"             # ...first block with that text
    pkm todos [-p "Page"]
    pkm changed [today|yesterday|YYYY-MM-DD] [--since X] [--until Y] [-p "Page"] [--limit N]
    pkm save [-p "Page"] [--parent "## H"|"((uid))"] [--todo] "text" | -
    pkm update <uid> "new text" | - | -D | -T
    pkm search "term" [--limit N] [--exact] [--compact]
    pkm refs "Page" / pkm query "{and: [[A]] [[B]]}" [--expand]
    pkm upload file.png [-p "Page"] [--parent "## H"|"((uid))"] [--no-block]
    pkm assets search "term" [--limit N]     # asset descriptions and filenames
    pkm assets scan [--force]                # queue undescribed images
    pkm batch < commands.json                # atomic multi-op transaction
    pkm rename "Old Title" "New Title" [--allow-merge] [--json]
    pkm migrate-titles [--json]              # side-effect-free audit
    pkm migrate-titles --apply DIGEST        # explicit audited apply
    pkm local check [--json]                 # /api/local/ links missing, evicted or unreadable on the host
    pkm goodlinks check [--json]             # /api/goodlinks/ links GoodLinks no longer has

An older uid can start with `-`, which argparse reads as a flag. Put `--`
before it (`pkm get -- -abc123`), with `pkm update`'s `-D`/`-T` before the
`--`.

### Writing

`pkm save` with no `-p` writes to today's daily note. Missing pages are
created.

`pkm update` sends the hash of the text it read. If another writer changed
the block in the meantime, the new text still lands. The text it replaced is
kept under a `[[conflict]]` header on today's daily note.

`pkm upload` stores the file and adds a block linking it, on `-p` or today's
daily note, nested under `--parent` if given. Images embed, PDFs open in the
PDF viewer, and other files are plain links. `--no-block` uploads and prints
the URL only.

`pkm assets scan` queues images without an LLM description; `--force` also
retries ones that failed. It exits 1 if image descriptions are disabled on the
server.

`pkm rename` retitles a page and rewrites every `[[link]]`, `#tag`,
`#[[tag]]` and `attr::` reference to it in block text, case-sensitively. If
`New Title` already exists, the command exits 1 with the server's "already
exists" message and a hint to retry with `--allow-merge`. With that flag, the
source page's top-level blocks are appended after the target's and the source
page is dropped. Daily-note (date) pages cannot be renamed. The printed title
is the server's normalised form, which may differ from what you typed.

No write stores a block longer than 1,000,000 characters, or with `[[`
nested more than 32 levels deep. A `save`, `update` or `batch` holding one
exits 1 with the server's refusal, and nothing in it is written:
`400: op 1: block <uid>: [[ nested 33 levels deep is over the limit of 32`.
A rename that would push a linking block over either limit exits 1 with
`422: rename refused: block <uid> on '<page>': …`, and nothing changes.

`pkm save` treats multi-line text as an outline. Two spaces or one tab of
indent is one level of nesting. A line indented more than one level below the
line before it nests only one level deeper. Text given to `pkm update` or to
a batch `create`, `todo` or `update` is one block, newlines included.

A line starting `# `, `## ` or `### ` becomes a heading block at that level,
and the hashes are not stored. This applies to `save`, `update` and the batch
`create`, `todo`, `outline` and `update` commands. `#Tag` (no space), `#### `
or deeper, and text with a newline inside stay literal. Update text without
the hashes clears the block's heading; `-D` and `-T` leave it as it is.

### Reading

Every read verb except `assets search` takes `--json`, which prints minified
JSON on one line. `rename` and `migrate-titles` take it too.

`pkm get` with a uid fetches that block's subtree. If no block has that uid,
it looks the string up as a page title.

`search` prefix-matches the last word of the term. `search --exact` matches
whole words only, with no prefix wildcard. `--compact` prints titles and uids
without snippets. The default `--limit` is 10, applied separately to page hits
and block hits.

`query --expand` adds one hop: `[[X]]` also matches blocks referencing a page
that itself references X. When a query returns nothing, the output includes a
block count per operand, so you can tell a mistyped `[[Page]]` from operands
that don't intersect.

`pkm changed` lists blocks whose latest edit time falls in a window, grouped
by page. `DAY` (default `today`) selects one calendar day. `--since`, with an
optional `--until`, gives a custom window instead and cannot be combined with
`DAY`. Each takes `YYYY-MM-DD` (local midnight) or an ISO datetime. `--until`
is exclusive and defaults to now. A block edited twice shows only under its
latest edit, and deleted blocks never show. The default `--limit` is 500.

`pkm refs` returns every backlink group, never a truncated first page
([how](architecture/cli-and-mcp.md#writes-uids-and-missing-pages)).

`pkm assets search` matches uploaded files by LLM description and filename.
The default `--limit` is 50.

`pkm local check` reports every `/api/local/` link in block text whose file
fails the check against the server's `local_docs_root`:

| Status | Meaning |
|---|---|
| `missing` | no file at that path |
| `evicted` | an iCloud placeholder not yet downloaded |
| `unreadable` | the host can't open it |
| `unchecked` | too many opens already in flight to try |
| `invalid` | the href doesn't resolve to a safe path |

Exit status: `0` clean, `1` problems found, `2` `local_docs_root` not set.

`pkm goodlinks check` reports every `/api/goodlinks/` link in block text whose
saved page is `missing` from the GoodLinks library or whose href is `invalid`
(not a GoodLinks id). It asks the GoodLinks app on the host. It exits 1 with a
"not running" error when the app is closed, or a "rejected the API token"
error when GoodLinks refuses the token. Exit status: `0` clean, `1` problems
found, `2` GoodLinks not configured (no API token file).

## Batch transactions

`pkm batch` reads a JSON array of `{command, params}` objects from stdin and
applies it in one transaction:

| Command | Params |
|---|---|
| `create` | page, text, parent?, index?, as? |
| `todo` | as `create`, but `{{TODO}}`-prefixed |
| `update` | uid, text |
| `move` | uid, page, parent?, index? |
| `delete` | uid |
| `outline` | page, parent?, items (nested string arrays) |

A batch `update` sends no hash, unlike `pkm update`. It overwrites a
concurrent edit without keeping it.

`index` inserts a `create`, `todo` or `move` at that position, counting from 0.
A position past the end appends, and so does omitting it. It counts against
the page as earlier commands in the batch left it. A `move` counts the
destination's children without the moving block.

Some bad ops are skipped and some fail the whole batch:

| Op | Result |
|---|---|
| `update`, `move` or `delete` whose uid no longer exists | skipped |
| `create` or `move` whose parent no longer exists | skipped |
| `move` under the block itself or one of its descendants | skipped |
| `((uid))` parent that is not on the named page | batch fails |
| `delete` uid that is not a valid uid | batch fails |
| an `as` name given twice, or used before the command that makes it | batch fails |
| `move` to a `"## Heading"` the page does not have | batch fails |
| unknown command, param or `{{alias}}` | batch fails |

A skipped op leaves the other commands applied and committed. The output then
starts with `warning:` and lists each skipped op with where its note landed,
and `pkm batch` exits 1. Fix the skipped ops on their own, because re-running
the batch repeats everything that applied. A batch that fails is checked
before anything is sent, so nothing is written, and `pkm batch` exits 1. The
MCP `batch` tool returns the same text.

A `delete` still removes a block another device changed after the batch read
it. The server's texts for the block and everything under it land on today's
daily page first.

`as` names a created block so later commands can refer to it as
`"parent": "{{alias}}"`, or as `"uid": "{{alias}}"` for `update`, `move` and
`delete`. Each `as` name can be given once per batch, and referred to only
after the command that makes it: a reused name, or one used earlier (or by
its own command), fails the batch before anything is sent.

A `"## Heading"` parent matches a heading at that level with that text, the
first in document order. `create`, `todo` and `outline` create a missing one
once per batch, and later commands with the same heading spec reuse it:

    [{"command": "create",
      "params": {"page": "AI", "parent": "## Meetings", "text": "notes"}},
     {"command": "create",
      "params": {"page": "AI", "parent": "## Meetings", "text": "more notes"}}]

## MCP server

The MCP server speaks stdio. For Claude Code, from the repository root:

    claude mcp add pkm -- uv run --project server pkm-mcp

Or in `.mcp.json`:

    {"mcpServers": {"pkm": {"command": "uv",
                            "args": ["run", "--project", "server", "pkm-mcp"]}}}

For Claude Desktop, use the same command and args in
`claude_desktop_config.json` under `mcpServers`, with an absolute path to the
repository's `server/` directory:

    "args": ["run", "--project", "/absolute/path/to/pkm/server", "pkm-mcp"]

Run `pkm login` once first. The MCP server reads the same config file.

The tools are listed in
[architecture/cli-and-mcp.md](architecture/cli-and-mcp.md#the-mcp-tool-surface).
They cover the CLI's page, block, search, asset and rename verbs. `assets
scan`, `local check`, `goodlinks check` and `migrate-titles` have no tool.
`batch` takes the same command format as `pkm batch`. Reads return markdown
annotated with `^uid` markers that the write tools accept.

## One-time title canonicalization

The title migration merges pages whose titles now name one page, retitles
sidebar entries the title rules no longer produce, and activates the rule
that strips a title's leading and trailing spaces. It is audit-first and
manual. Server startup never audits or applies it, and a deploy or restart
does not activate it.

Startup does check. It logs one ERROR on `pkm.titles` naming each stored page
title or sidebar entry the live rules would change, then serves on. Such rows
appear when the rules change on a database already migrated. Run the audit
when that line appears.

Set both the config and the URL explicitly so the command cannot fall back to
the CLI defaults:

```bash
PKM_CLI_CONFIG=/explicit/target-config.json PKM_URL=https://explicit-target \
  uv run --project server pkm migrate-titles
PKM_CLI_CONFIG=/explicit/target-config.json PKM_URL=https://explicit-target \
  uv run --project server pkm migrate-titles --apply <audit-digest>
```

The audit has no side effects. It prints the migration state, a 64-hex
digest, each canonical group with its survivor, sources, counts and merge
order, each sidebar entry it would retitle, and every blocker with an
`all_space` or `forbidden_syntax` reason. Review it before applying.

`--apply` requires that exact digest. It is refused if database changes since
the audit have altered the plan, if there are blockers, or if the migration is
already active and the audit lists no group and no sidebar entry. On a
database where the migration is not yet active, a successful apply also
activates it, even one run only to merge the pages the startup check named.

A successful apply runs in one transaction. It retitles and merges pages,
rewrites inbound references and sidebar entries, activates the new title
rule, and rotates the sync generation. Its output counts each kind of change,
`sidebar entries retitled` (`sidebars_retitled` in `--json`) among them. Take
the normal backup first. Run it against production only when production was
explicitly requested and both variables point there.

### Rows the migration cannot fix

Two kinds of row are reported at startup, but the migration cannot fix them.

A page whose title the fold turns into a blank or refused one, such as
`Notes/` followed by a non-breaking space, is a blocker. It refuses the whole
apply, and no route reaches it, because every lookup key folds. Retitle it by
hand:

1. Back up the database ([deploy/README.md § Backups](../deploy/README.md#backups)).
2. From Python's `sqlite3`, list the blocks that link the page, so you can
   find them after the rename:
   `SELECT b.uid, b.text FROM refs r JOIN blocks b ON b.uid = r.src_block_uid
   WHERE r.target_page_id = ?` with the blocker's id.
3. Still in `sqlite3`, run
   `UPDATE pages SET title = ?, updated_at = ? WHERE id = ? AND title = ?`
   in one `BEGIN IMMEDIATE`. Pass a canonical title no page holds, the time
   in ms, and the blocker's id and exact title from the audit's `--json`.
   Roll back unless one row changed. The `pages_chg_au` trigger records the
   change for replicas.
4. Rename the page as usual, then audit again. The rename re-indexes the
   linking blocks, and their old spelling folds to a refused title, so those
   links stop being backlinks, and the web refuses to edit a block that still
   holds one. Edit each block from step 2 to link the new title.
5. The page's own pin keeps the old spelling. Call
   `DELETE /api/sidebar/{entry_id}` with its id from `GET /api/sidebar` (or
   remove it in the sidebar's edit mode), then pin the new title.

A sidebar entry whose canonical form is blank or refused is skipped, because
no pin can hold that title. With nothing else to do, apply answers "already
active". Remove the entry in the sidebar's edit mode, or call
`DELETE /api/sidebar/{entry_id}` with the id from `GET /api/sidebar`.

### What the title rules are

Every run of whitespace in a title folds to one ordinary space, at creation
and at lookup, online and offline. Whitespace means the characters in
`TITLE_WHITESPACE` (`server/src/pkm/contracts/titles.py`): tab, newline and
the other control whitespace, the ordinary and non-breaking spaces, and the
other Unicode space characters. When the fold changes a title, its leading
and trailing spaces go too. Look-alikes outside that list, such as the
zero-width space, stay as typed. So `A  B`, `A`+NBSP+`B` and `A B` followed by
a newline all name the page `A B`.

Writes, online and offline, then reject a title that:

- contains `#`, `[[`, `]]` or a backtick
- ends with `]`
- has a `.`, `..` or empty `/`-separated segment, so it has no URL

Once the migration is active, leading and trailing ordinary spaces are removed
from every title, so a title is its words joined by single spaces.

See [architecture/backend.md](architecture/backend.md#title-integrity-and-one-time-activation)
for the mechanism.
