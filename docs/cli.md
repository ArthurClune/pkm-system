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

This stores a year-long session token in `~/.config/pkm-cli/config.json`.
Two environment variables override the defaults:

- `PKM_CLI_CONFIG`: use a different config file
- `PKM_URL`: talk to a different server for this call

`pkm login --password-stdin` reads the password from stdin, for scripts.

## Command reference

`uv run pkm <cmd> --help` lists each verb's argument forms and examples.

    pkm get "Page Title" | today | <uid>     # markdown; --uids / --json
    pkm get "Page" --resolve-refs            # inline ((uid)) refs, cycle-safe
    pkm get "Page" --section "## H" [--depth N]   # subtree only (pages only)
    pkm get "Page" --section "H"             # ...at any heading level
    pkm todos [-p "Page"]
    pkm save [-p "Page"] [--parent "## H"|"((uid))"] [--todo] "text" | -
    pkm update <uid> "new text" | -D | -T
    pkm search "term" [--limit N] [--exact] [--compact]
    pkm refs "Page" / pkm query "{and: [[A]] [[B]]}" [--expand]
    pkm upload file.png [-p "Page"] [--parent "## H"|"((uid))"] [--no-block]
    pkm assets search "term" [--limit N]     # asset descriptions and filenames
    pkm assets scan [--force]                # queue undescribed images
    pkm batch < commands.json                # atomic multi-op transaction
    pkm rename "Old Title" "New Title" [--allow-merge] [--json]
    pkm migrate-titles [--json]              # side-effect-free audit
    pkm migrate-titles --apply DIGEST        # explicit audited apply
    pkm local check [--json]                 # /api/local/ links missing/evicted on the host
    pkm goodlinks check [--json]             # /api/goodlinks/ links GoodLinks no longer has

### Writing

`pkm save` with no `-p` writes to today's daily note. Missing pages are
created.

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

Multi-line text is treated as an outline: two spaces of indent is one level of
nesting. A line starting `# `, `## ` or `### ` becomes a heading block at that
level. This applies to `save`, `batch` and `update`. `#Tag` (no space) and
`#### ` or deeper stay literal.

### Reading

The read verbs take `--json`, which prints minified JSON on one line.

`search --exact` matches whole words only, with no prefix wildcard.
`--compact` prints titles and uids without snippets. The default `--limit` is
10.

`query --expand` adds one hop: `[[X]]` also matches blocks referencing a page
that itself references X. When a query returns nothing, the output includes a
block count per operand, so you can tell a mistyped `[[Page]]` from operands
that don't intersect.

`pkm refs` pages through the server's results and returns every backlink
group, retrying if concurrent writes shift the pages.

`pkm assets search` matches uploaded files by LLM description and filename.
The default `--limit` is 50.

`pkm local check` reports every `/api/local/` link in block text whose file is
`missing`, `evicted` (an iCloud placeholder not yet downloaded), or `invalid`
(the href doesn't resolve to a safe path), checked against the server's
`local_docs_root`. Exit status: `0` clean, `1` problems found, `2`
`local_docs_root` not set.

`pkm goodlinks check` reports every `/api/goodlinks/` link in block text whose
saved page is `missing` from the GoodLinks library or whose href is `invalid`
(not a GoodLinks id). It asks the GoodLinks app on the host, so it exits 1
with a "not running" error when the app is closed, or a "rejected the API
token" error when GoodLinks refuses the token. Exit status: `0` clean,
`1` problems found, `2` GoodLinks not configured (no API token file).

## Batch transactions

`pkm batch` applies a JSON array of `{command, params}` objects in one
transaction:

| Command | Params |
|---|---|
| `create` | page, text, parent?, index?, as? |
| `todo` | as `create`, but `{{TODO}}`-prefixed |
| `update` | uid, text |
| `move` | uid, page, parent?, index? |
| `delete` | uid |
| `outline` | page, parent?, items (nested string arrays) |

`index` inserts a `create`, `todo` or `move` at that position. Without it, the
block is appended.

`as` names a created block so later commands can refer to it as
`"parent": "{{alias}}"`, or as `"uid": "{{alias}}"` for `update`, `move` and
`delete`.

A `"## Heading"` parent is matched on the page, or created once per batch.
Later commands with the same heading spec reuse it:

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

The tools cover the CLI's read and write verbs and are listed in
[architecture/cli-and-mcp.md](architecture/cli-and-mcp.md#the-mcp-tool-surface).
`batch` takes the same command format as `pkm batch`. Reads return markdown
annotated with `^uid` markers that the write tools accept.

## One-time title canonicalization

Page titles with a leading or trailing space need a data migration before the
server will strip that space. The migration is audit-first and manual: server
startup never audits or applies it, and a deploy or restart does not activate
it.

Set both the config and the URL explicitly so the command cannot fall back to
the CLI defaults:

```bash
PKM_CLI_CONFIG=/explicit/target-config.json PKM_URL=https://explicit-target \
  uv run --project server pkm migrate-titles
PKM_CLI_CONFIG=/explicit/target-config.json PKM_URL=https://explicit-target \
  uv run --project server pkm migrate-titles --apply <audit-digest>
```

The audit has no side effects. It prints a 64-hex digest, each canonical
group, the survivor/source merge plan, counts, and every blocker with an
`all_space` or `forbidden_syntax` reason. Review it before applying.

`--apply` requires that exact digest. It is refused if database changes since
the audit have altered the plan, if there are blockers, or if the migration
is already active. Only boundary U+0020 spaces are removed.

A successful apply runs in one transaction: it retitles and merges pages,
rewrites inbound references and sidebar entries, activates the new title
rule, and rotates the sync generation. Take the normal backup first. Run it
against production only when production was explicitly requested and both
variables point there.

### What the title rules are

Control whitespace in titles is always normalized. After normalization,
writes reject titles containing `#`, `[[` or `]]`, online and offline. Once
the migration is active, leading and trailing ordinary spaces are also
removed. Internal spaces and non-breaking spaces are kept as typed.

See [architecture/backend.md](architecture/backend.md#title-integrity-and-one-time-activation)
for the mechanism.
