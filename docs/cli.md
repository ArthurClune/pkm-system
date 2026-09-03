# pkm CLI and MCP access

The `pkm` CLI and the `pkm-mcp` server let humans, scripts and LLM agents
drive the PKM from outside the browser. Both talk to the running server's
HTTP API, so they get the same validation, conflict handling and live sync as
the web app. Neither touches SQLite directly.

## Login

Both share one login:

```bash
cd server && uv run pkm login --url http://127.0.0.1:8974
```

This stores a year-long session token in `~/.config/pkm-cli/config.json`.
Two environment variables override the defaults:

- `PKM_CLI_CONFIG` — use a different config file
- `PKM_URL` — talk to a different server for this call

`pkm login --password-stdin` reads the password from stdin, which suits
scripts.

## Command reference

`uv run pkm <cmd> --help` is self-sufficient for every verb: it lists the
argument forms and gives examples.

    pkm get "Page Title" | today | <uid>     # markdown; --uids / --json
    pkm get "Page" --resolve-refs            # inline ((uid)) refs, cycle-safe
    pkm get "Page" --section "## H" [--depth N]   # subtree only (pages only)
    pkm get "Page" --section "H"             # ...at any heading level
    pkm todos [-p "Page"]
    pkm save [-p "Page"] [--parent "## H"|"((uid))"] [--todo] "text" | -
    pkm update <uid> "new text" | -D | -T
    pkm search "term" [--limit N] [--exact] [--compact]
    pkm refs "Page" / pkm query "{and: [[A]] [[B]]}" [--expand]
    pkm upload file.png [-p "Page"] [--no-block]
    pkm batch < commands.json                # atomic multi-op transaction
    pkm rename "Old Title" "New Title" [--allow-merge] [--json]
    pkm migrate-titles [--json]              # side-effect-free audit
    pkm migrate-titles --apply DIGEST        # explicit audited apply

### Writing

`pkm save` with no `-p` targets today's daily note. Pages are created if they
don't exist yet.

`pkm rename` retitles a page and rewrites every `[[link]]`, `#tag`,
`#[[tag]]` and `attr::` reference to it in block text, case-sensitively. If
`New Title` already exists, the command exits 1 with a 409 and a hint to
retry with `--allow-merge`; that flag instead concatenates the source page's
top-level blocks after the target's and drops the source page. Daily-note
(date) pages cannot be renamed. The title printed back is the server's
normalised form, which need not match what you typed byte-for-byte.

Multi-line text is treated as an outline: two spaces of indent means one
level of nesting. A line starting `# `, `## ` or `### ` is stored as a
heading block at that level rather than as literal text. This applies to
`save`, `batch` and `update` alike. `#Tag` (no space) and `#### ` or deeper
stay literal.

### Reading

`--json` is available on the read verbs. It prints minified, on one line,
which is cheaper for machine consumers.

`search --exact` matches whole words only, with no prefix wildcard.
`--compact` prints titles and uids without snippets. The default `--limit`
is 10.

`query --expand` also matches one hop of transitivity: `[[X]]` matches
blocks referencing a page that itself references X. When a query's total is
0, the response reports a per-operand block count as well, so you can tell a
mistyped `[[Page]]` from operands that simply don't intersect.

`pkm refs` follows every page the server has rather than stopping at the
route's 100-group cap. It retries if concurrent writes shift pagination, and
its JSON reports the first response's actual `limit` rather than a limit
synthesized from the aggregate group count.

## Batch transactions

`pkm batch` applies a JSON array of `{command, params}` objects in one
transaction. The commands are:

| Command | Params |
|---|---|
| `create` | page, text, parent?, index?, as? |
| `todo` | as `create`, but `{{TODO}}`-prefixed |
| `update` | uid, text |
| `move` | uid, page, parent?, index? |
| `delete` | uid |
| `outline` | page, parent?, items (nested string arrays) |

`index` inserts a `create`, `todo` or `move` at that exact position instead
of appending.

`as` names a created block so later commands can refer to it as
`"parent": "{{alias}}"`, or as `"uid": "{{alias}}"` for `update`, `move` and
`delete`.

A `"## Heading"` parent is matched on the page, or created once per batch.
Repeating the same heading spec across commands reuses the heading already
created:

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
`claude_desktop_config.json` under `mcpServers`, but give `--project` an
absolute path to the repository's `server/` directory:

    "args": ["run", "--project", "/absolute/path/to/pkm/server", "pkm-mcp"]

Run `pkm login` once first. The MCP server reads the same config file.

It exposes twelve tools mirroring the CLI: `get_page`, `get_block`,
`search`, `query`, `backlinks`, `todos`, `search_assets`, `save_note`,
`update_block`, `batch` (same command format as `pkm batch`), `upload_asset`
and `rename_page`. Reads return markdown annotated with `^uid` markers that
the write tools accept.

## One-time title canonicalization

Page titles with a leading or trailing ordinary space need a data migration
before the server will canonicalize them. It is audit-first and deliberately
manual: normal server startup only replays schema setup, and never audits or
applies this migration. Activating production is a separate operator action
and must not be inferred from a deploy or a restart.

Set both the config and the URL explicitly rather than inheriting the CLI
defaults:

```bash
PKM_CLI_CONFIG=/explicit/target-config.json PKM_URL=https://explicit-target \
  uv run --project server pkm migrate-titles
PKM_CLI_CONFIG=/explicit/target-config.json PKM_URL=https://explicit-target \
  uv run --project server pkm migrate-titles --apply <audit-digest>
```

The audit has no side effects. It prints a stable 64-hex digest, each
canonical group, the survivor/source merge plan, counts, and every blocker
with an `all_space` or `forbidden_syntax` reason. Review it before applying.

Apply requires that exact digest. Database changes that affect the plan make
the digest stale, and stale, blocked or already-active applies are refused.
Mappings remove boundary U+0020 only, and each replacement value is inserted
once and never rescanned as another source.

A successful apply does all of this in one transaction: retitle and merge
pages, rewrite inbound references and sidebar identities, activate
boundary-space canonicalization, and rotate the sync generation. Take the
normal operational backup first, and only run against production if
production was explicitly requested and both variables were deliberately
set.

### What the title rules are

Control whitespace in titles is always normalized — on creation, and on the
page, unlinked-references, export, CLI and MCP read paths. After that
normalization, normal writes reject titles containing `#`, `[[` or `]]`.
Explicit and ref-derived titles are checked across the whole op batch before
anything is written, and offline queueing applies the same rule before any
optimistic or durable mutation.

Activation adds one thing: leading and trailing ordinary spaces are removed,
online and offline. Internal ordinary spaces and non-breaking spaces stay
byte-exact.

The mechanism is described in
[docs/architecture/backend.md](architecture/backend.md#title-integrity-and-one-time-activation).
