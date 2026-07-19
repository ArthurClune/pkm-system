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

## Read verbs (all take `--json`)

    pkm get "Page Title" | today | yesterday | tomorrow | <uid>
    pkm get today --uids          # ^uid markers — fetch these before updating
    pkm search "term" [--limit N]
    pkm refs "Page Title"                    # backlinks
    pkm query "{and: [[A]] [[B]]}"           # structured {and:/or:/not:}
    pkm todos [-p "Page"]                    # open {{TODO}} blocks

## Write verbs

    pkm save [-p "Page"] [--parent "## H"|"((uid))"] [--todo] "text" | -
    pkm update <uid> "new text" | -D | -T    # -D done, -T back to todo
    pkm upload file.png [-p "Page"] [--no-block]
    pkm batch < commands.json                # atomic multi-op transaction

- `save` defaults to today's daily note; pages and `"## Heading"` parents
  are created if missing. Multi-line text (or `-` stdin) is an outline:
  2-space indent = nesting.
- `update` is guarded by a hash of the text the CLI fetched — a conflict
  error means the block changed underneath you; re-`get` and retry.
- `batch` reads a JSON array of `{command, params}` — `create`, `todo`,
  `update`, `move`, `delete`, `outline`. `"as": "name"` labels a created
  block so later commands can target `"parent": "{{name}}"`; repeated
  `"## Heading"` parents on the same page resolve to one heading.

## Gotchas

- A verb returning `404: not found` means the running server is older than
  the CLI (deploy pending). Report the gap; don't fall back to the DB.
- Port 8974 is the production server on this machine — reads are cheap and
  safe, writes are real. Point tests elsewhere with `PKM_URL`.
- Details: README "CLI and MCP access" section; `uv run pkm <verb> --help`.
