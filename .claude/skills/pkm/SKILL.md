---
name: pkm
description: Use when reading or writing PKM content from a session — pages, blocks, daily notes/journal, TODOs, backlinks, search, uploads — or when tempted to query pkm.sqlite3, curl /api endpoints, or mint session cookies by hand
---

# Driving the PKM with the pkm CLI

All PKM reads and writes go through the `pkm` CLI (or the `pkm` MCP tools
when connected — same verbs, same login). Never copy or open `pkm.sqlite3`,
never hand-curl `/api/...`, never sign a `pkm_session` cookie yourself. If
the CLI can't do something, surface that to your partner instead.

## Invocation and auth

`pkm` is not on PATH. From the repo root:

    uv run --project server pkm <verb> ...     # or: cd server && uv run pkm ...

Auth comes from `~/.config/pkm-cli/config.json` (override the path with
`PKM_CLI_CONFIG`; point one call at another server with `PKM_URL`). A login
normally already exists — just run your verb; only think about auth on a 401.

On a 401: `uv run pkm login --url http://127.0.0.1:8974` — but it prompts
for a password only your partner knows (`--password-stdin` exists for
scripts *they* drive). **Stop and ask them to run login.** Do not mint
tokens, sign cookies, or read the DB as a workaround.

## Read verbs (all take `--json`, minified single-line)

    pkm get "Page Title" | today | yesterday | tomorrow | <uid>
    pkm get today --uids          # ^uid markers — fetch these before updating
    pkm get "Page" --resolve-refs # inline ((uid)) refs as "text" ((uid)), cycle-safe
    pkm get "Page" --section "## H" [--depth N]   # subtree only (pages only); --depth also clips uid targets
    pkm get "Page" --section "H"   # bare = that text at ANY level; "## H" = H2 only
    pkm search "term" [--limit N]  # default limit 10
    pkm search "term" --exact      # whole-word match, no prefix wildcard
    pkm search "term" --compact    # titles + "[page] ^uid" only, no snippets
    pkm refs "Page Title"                    # backlinks
    pkm query "{and: [[A]] [[B]]}"           # structured {and:/or:/not:}
    pkm query "{and: [[A]] [[B]]}" --expand  # one-hop: [[X]] also matches via a page X's own blocks reference
    pkm todos [-p "Page"]                    # open {{TODO}} blocks

A `query` with `total: 0` also returns `ref_counts` per operand; the
rendered output prints "per-ref block counts: ..." so you can tell a typo'd
operand from operands that just don't intersect.

`pkm get`/`pkm update` take a uid as a plain positional. Uids minted by any
of this project's uid generators (CLI client, server, or web app) as of
pkm-y5yv always start with a letter or digit, but a leading "-" is still
possible — from an import, or a block created by a web app version
pre-dating pkm-y5yv — and argparse will otherwise read it as an unknown
option. Use `--` to end option parsing, flags before it: `pkm get --
-abc123wxyz9`, `pkm update -D -- -abc123wxyz9`.

## Write verbs

    pkm save [-p "Page"] [--parent "## H"|"((uid))"] [--todo] "text" | -
    pkm update <uid> "new text" | -D | -T    # -D done, -T back to todo
    pkm upload file.png [-p "Page"] [--no-block]
    pkm batch < commands.json                # atomic multi-op transaction

- `save` defaults to today's daily note; pages and `"## Heading"` parents
  are created if missing. Multi-line text (or `-` stdin) is an outline:
  2-space indent = nesting.
- A line beginning `# `, `## `, or `### ` becomes a real heading block at
  that level (1-3) — on `save`, on `batch` create/todo/outline, and on
  `update`. The hashes are not stored as text. `#Tag` (no space) stays a
  tag, and `#### ` or deeper stays literal, since blocks only carry levels
  1-3. On `update`, text *without* leading hashes clears an existing
  heading; `-D`/`-T` never touch the level. `pkm get` prints a heading as
  `## text`, so a fetch (`pkm get`) → edit → `update` round trip is
  lossless for any heading with a body. Two exceptions: an *empty* heading
  block (level set, text `""`) prints as a bare `- ##` line, and
  re-`update`ing that line stores literal `"## "` with no level — there is
  no way to write a heading with empty text, so leave those alone rather
  than "fixing" them by hand. And `pkm todos`/`pkm search`/`pkm refs`
  output never prints heading markers at all (only `pkm get` does) — text
  copied from those verbs into `update` loses a heading silently.
- `update` is guarded by a hash of the text the CLI fetched, but the write
  always wins — it is never rejected. If the block changed underneath you,
  your new text still applies and the text you overwrote is preserved as a
  new `[[conflict]]`-tagged sibling block right after the target; find it
  via `pkm search`/`pkm refs conflict` and merge by hand if needed. One
  exception: if the block was deleted underneath you *and* your text
  changes its heading level, the write fails loudly with `block not
  found` rather than landing.
- `batch` reads a JSON array of `{command, params}` — `create`, `todo`,
  `update`, `move`, `delete`, `outline`. `create`/`todo`/`move` accept an
  `"index"` param to insert at a specific position. `"as": "name"` labels a
  created block so later commands can target it as `"parent": "{{name}}"`
  or, for `update`/`move`/`delete`, as `"uid": "{{name}}"`; repeated
  `"## Heading"` parents on the same page resolve to one heading.

## Title syntax

After control-whitespace normalization, normal API, CLI, MCP, and offline
writes reject page titles containing `#`, `[[`, or `]]`. This includes explicit
page targets and titles extracted from block refs: an op batch or offline queue
request is preflighted as a whole and refused before optimistic, durable, or
server mutation.

Roam import is the only sanitizing path. Before creating rows, it recursively
removes balanced `[[`/`]]` and `#` title markers, rewrites ref-derived titles,
and reports deterministic collision merges. Malformed marker syntax or a title
made blank by sanitization refuses the import before output creation; normal
writes never sanitize forbidden syntax into a different title.

## Title migration (operator-only)

Existing leading/trailing plain-space titles are migrated only by an explicit,
audit-first operator command. Server startup never audits or applies this data
migration.

Never run either command against production unless your partner explicitly asks
for that production action. Deliberately set **both** `PKM_CLI_CONFIG` and
`PKM_URL` for the intended server; do not inherit the normal CLI config or URL.
For an approved target:

    PKM_CLI_CONFIG=/explicit/config.json PKM_URL=https://explicit-host \
      uv run --project server pkm migrate-titles
    PKM_CLI_CONFIG=/explicit/config.json PKM_URL=https://explicit-host \
      uv run --project server pkm migrate-titles --apply <audit-digest>

The first command is side-effect-free: review its groups, survivor/source merge
plan, and reasoned blockers (`all_space` or `forbidden_syntax`), then retain its
64-hex digest. Apply has no implicit/default mode and requires that exact
digest. A database change that alters the audited plan makes the digest stale
and refuses the apply; re-audit instead of bypassing it. Blockers also refuse
the whole apply. Migration mappings remove boundary plain spaces only, and
their replacement values are opaque rather than recursively rescanned. A
successful apply is one transaction: it retitles/merges pages, rewrites inbound
refs, activates boundary-plain-space canonicalization, and rotates the sync
generation.

## Gotchas

- A verb returning `404: not found` means the running server is older than
  the CLI (deploy pending). Report the gap; don't fall back to the DB.
- Port 8974 is the production server on this machine — reads are cheap and
  safe, writes are real. Point tests elsewhere with `PKM_URL`.
- `--help` on every verb is self-sufficient (argument forms, examples,
  and for `batch` the full op reference) — prefer it over guessing.
- Details: README "CLI and MCP access" section; `uv run pkm <verb> --help`.
