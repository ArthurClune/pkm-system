# CLI/MCP heading writes (pkm-8m94)

## Problem

A block written through the `pkm` CLI or the MCP tools with `## Heading` text
is stored verbatim, `heading = NULL`. The page then displays the literal
characters `## Heading` instead of a rendered heading.

Root cause: `server/src/pkm/cli/build.py` never emits a `heading` field on
content blocks. The one exception is `_Planner.creates` (`build.py:158-160`),
which sets a level when a `parent: "## Heading"` spec names a heading that
does not yet exist on the page. Every other created block, and every
`update`, passes text straight through.

The server is not at fault. `CreateOp.heading` (`ops_core.py:26`) and
`SetHeadingOp` (`ops_core.py:61`) both exist and validate levels 1-3. The bug
is only that the planner never uses them.

Two things compound it:

- `render.py:39` renders a real heading *as* `## text`. So `pkm get --uids` →
  edit → `pkm save`/`pkm update` is a lossy round trip: real headings come
  back as literal markdown.
- No CLI epilog, MCP docstring, or skill doc mentions that a heading level can
  be set at all, so an LLM writing structured notes reaches for `## Section`
  and gets literal text with no signal that anything went wrong.

Reproduction, pure, no server needed:

```python
plan_save({"blocks": []}, "P", None, "## Overview", False, uids)
# -> [{"op": "create", ..., "text": "## Overview"}]   # no heading field
```

## Approach

Text is the single source of truth for the heading level on every CLI/MCP
write. Leading `#`/`##`/`###` are stripped and stored as `heading = 1|2|3`;
their absence means `heading = None`.

This was chosen over an explicit `heading` param because it makes the
`render.py` round trip lossless for free, needs no new parameters on any verb,
and matches the `"## Heading"` syntax the `parent:` spec already uses.

## One pure helper

In `cli/build.py` (Functional Core):

```python
def split_heading(text: str) -> tuple[str, int | None]:
    """'## Overview' -> ('Overview', 2). Non-matching text comes back
    unchanged with None."""
    m = _HEADING_SPEC.match(text)
    return (m.group(2), len(m.group(1))) if m else (text, None)
```

It reuses `_HEADING_SPEC` (`build.py:12`, `r"^(#{1,3}) (.+)$"`), already used
for parent specs — one regex, identical syntax in both places.

What it deliberately leaves literal:

| input | result | why it must stay literal |
|---|---|---|
| `#Tag`, `#[[Page]]` | literal | no space after the hashes; prod has 35 such tag-blocks |
| `#### Four` | literal | PKM supports heading levels 1-3 only |
| `# ` | literal | `.+` requires a body |
| any multi-line text | literal | no `DOTALL`/`MULTILINE`, so `$` cannot match mid-string |

The multi-line case matters: a pasted markdown document living in a single
block (there is one such block in prod, on *AI Pricing*, ~8KB) is not
rewritten even if it is re-saved.

## Create path

In `_Planner.creates`'s item loop, split the text before building the op, and
split *before* `with_state` applies the TODO marker — so `## Do it` with
`--todo` yields text `{{TODO}} Do it` with `heading=2`.

`save`, `batch create`/`todo`/`outline`, and `upload`'s asset block all funnel
through `creates`, so this single call site fixes every create path. The
existing missing-heading-parent create at `build.py:158` already sets its
level and is unchanged.

## Update path

A second pure planner in `cli/build.py`, so the CLI and MCP shells stop
duplicating the op shape:

```python
def plan_update(uid: str, text: str, base_text: str) -> list[dict]:
    """update_text plus the set_heading that keeps the stored level in step
    with the leading hashes."""
```

It always emits `set_heading` rather than comparing against the block's
current level. `set_heading` is idempotent, and emitting unconditionally keeps
batch-`update` — which has no fetched page payload to compare against — on the
same code path.

`cmd_update` (`cli/main.py:363`) and `update_block` (`mcp/server.py:107`) call
it on the **text** path only. The `-D`/`-T`/`mark` path must not: the current
text it reads back from the API is already bare (the level lives in a separate
column), so splitting it would find no hashes and demote a real heading to
plain text. `plan_batch`'s `update` command emits the same two ops.

### Demotion is intended

`update <uid> "Overview"` on a block that is currently `heading=2` clears the
heading. This is symmetric with `pkm get --uids`, which always shows the
hashes, so a fetch-then-update session preserves them naturally. The accepted
risk is that an update which retypes the text *without* the hashes demotes the
block silently.

## Not in scope

- No server changes. The ops and their validation already exist.
- The existing ~8KB single-block markdown document on *AI Pricing* is left
  alone: it was pasted in from outside, not produced by this bug.
- `batch create` with newlines in `text` producing one giant block instead of
  an outline is a separate defect, not addressed here.

## Contract and documentation updates

These are part of the fix, not a follow-up — the missing contract is why the
bug went unnoticed:

- MCP docstrings: `save_note`, `update_block`, `batch` (`mcp/server.py`)
- `_SAVE_EPILOG`, `_UPDATE_EPILOG`, and the `batch` help in `cli/main.py`
- the write-verbs section of `.claude/skills/pkm/SKILL.md`
- README, "CLI and MCP access"
- `docs/architecture/backend.md` where it describes the CLI/MCP planner

## Testing

TDD; the planner tests are pure and need no server.

`tests/test_cli_build.py`:

- levels 1, 2, 3 through `save`, `outline`, and batch `create`
- every literal case in the table above (`#Tag`, `#### Four`, `# `, multi-line)
- `todo=True` combined with a heading: `{{TODO}} Do it` + `heading=2`
- a created heading's bare text matching a later `parent: "## X"` spec in the
  same batch
- `plan_update` emitting both ops, and emitting `heading: None` for plain text
- batch `update` emitting `set_heading`

`tests/test_cli_main_write.py` and `tests/test_mcp_server.py`:

- `pkm update <uid> "## X"` / `update_block` post both ops
- `-D`/`-T` and `mark=` emit **no** `set_heading`

Full gate before completion: `cd server && uv run pytest -q`,
`uv run pyrefly check`, `uv run ruff check`.

## Invariant this establishes

No CLI or MCP write can store `## X` as literal block text, and
`render.py:39`'s `## text` output reads back as a heading — the
get → edit → update round trip stops demoting headings.
