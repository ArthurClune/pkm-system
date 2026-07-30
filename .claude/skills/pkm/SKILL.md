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
  `## text`, so fetch-then-update round trips are lossless.
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

## Gotchas

- A verb returning `404: not found` means the running server is older than
  the CLI (deploy pending). Report the gap; don't fall back to the DB.
- Port 8974 is the production server on this machine — reads are cheap and
  safe, writes are real. Point tests elsewhere with `PKM_URL`.
- `--help` on every verb is self-sufficient (argument forms, examples,
  and for `batch` the full op reference) — prefer it over guessing.
- Details: README "CLI and MCP access" section; `uv run pkm <verb> --help`.
