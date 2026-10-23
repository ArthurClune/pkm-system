# Approval card shows every write's target

Beans: pkm-1zdg (card), pkm-i9pg (string-encoded batch). Approved by Arthur
2026-10-23 from the draft
`docs/superpowers/handoffs/2026-10-23-approval-card-design-draft.md`.

## Problem

The approval card is the only thing between an injected model and a write.
Today `policy.ops_preview` turns the tool input into one string: arguments
in the model's order, string values pasted unquoted, batch params dumped
as one JSON blob clipped at 4000 chars. `ConfirmCard` then collapses that
string at 300 chars while Allow stays live. So a model can:

- push the target (`uid`, `page`, `path`, `allow_merge`) past the collapse
  or the clip;
- write a value such as `x), uid=SAFE` that draws a fake argument list;
- send `batch.commands` as a JSON string, which falls through to the
  generic dump with no op count. The bundled CLI 2.1.301 repairs it into a
  list before `can_use_tool` (read from the binary, see pkm-i9pg), but a
  future CLI may not, and FastMCP's own pre-parse would still run every
  command;
- trigger a second confirm while one is showing: `setPendingConfirm`
  replaces the first card, whose future then waits until the turn ends.

## Rule (the security property)

1. Every argument that says *where* a write lands or *how destructive* it
   is renders in full, first, and is never collapsed or clipped.
2. Only arguments named as content may be clipped, each value on its own,
   with its full length shown and a toggle to show all of it.
3. A key the tool's argument model does not declare is refused: the tool
   drops it, so showing it would only offer a decoy beside the real
   target. A field the model declares and the table does not name is a
   target (fail safe).
4. Input that is not schema-shaped is denied with a message to the model,
   never previewed.
5. Each value renders as data in its own element; strings render
   JSON-quoted, so no value can imitate argument syntax.
6. `rename_page` with `allow_merge: true` shows a warning line naming the
   page it merges into.
7. A second confirm waits behind the one showing; the card never changes
   under the cursor.

## Target / content table

| Tool / batch op | Targets (full, first, in this order) | Content (clipped per value) |
|---|---|---|
| save_note | page (absent: "today's daily note"), parent, todo | text |
| update_block | uid, mark | text |
| upload_asset | path, page (absent: "today's daily note"), parent | — |
| rename_page | title, new_title, allow_merge | — |
| batch create / todo | page, parent, index, as | text |
| batch update | uid | text |
| batch move | uid, page, parent, index | — |
| batch delete | uid | — |
| batch outline | page, parent | items |
| a declared field the table does not name | that field | — |
| a key the argument model does not declare (for batch, anything beside `commands`) | refused: the tool drops it, so a row for it would be a decoy | — |

The table lives in `policy.py` as data beside `WRITE_TOOLS`. A test fails
when a write tool's signature (`pkm.mcp.server`) or a batch params model
(`pkm.batch`) gains a field the table does not name, so a new field is
classified on purpose rather than by the fail-safe default.

## Shape

### Server (`policy.py`, `events.py`, `claude_engine.py`)

`ops_preview` is replaced by a pure builder returning either a preview or
a refusal:

```
WritePreview = {
  ops: [ { action: str,                     # "save_note", "batch: move", ...
           targets: [[key, value]],         # value: JSON value, unclipped
           content: [[key, value, total_len]],  # value clipped, len of full
           warnings: [str] } ],             # e.g. allow_merge
  summary: str,                             # one-line text for logs
}
| Refusal(message: str)
```

- **Preview what the tool receives, not what the model sent.** FastMCP
  runs `pre_parse_json` on every argument whose annotation is not plain
  `str`, then validates with a lax pydantic model. So `page: "null"`
  arrives as `None` (today's daily note), `allow_merge: "yes"` or `"1"`
  as `True`, and `commands: "[...]"` as a list. Checked on the installed
  FastMCP, 2026-10-23. The preview therefore takes each write tool's own
  argument model, `func_metadata(<the pkm.mcp.server function>)`, runs
  its `pre_parse_json` and `arg_model.model_validate`, and previews the
  validated values. A validation error is a refusal naming the first
  error. A key the model does not declare is refused before validation
  (rule 3).
- `batch`: after that, every item of `commands` must validate against
  `pkm.batch`'s `BatchCommand` adapter, and the list must be non-empty;
  otherwise `Refusal("batch item <i>: <problem>")`. The preview is built
  from the validated models, so it lists exactly the ops `apply_batch`
  would run.
- Where the code that builds the arg models sits is an FCIS call:
  `pkm.mcp.server` constructs a `FastMCP` at import (no I/O). The plan
  names the module.
- `can_use_tool` returns `PermissionResultDeny(message=refusal.message)`
  for a refusal without sending a `confirm_request`, and logs it.
- `ConfirmRequest` carries `preview: WritePreview` beside the existing
  `ops_preview: str` (now the one-line `summary`, kept for logs and
  transcripts). `encode_sse` already serialises dataclasses via `asdict`.
- Content is sent whole, so the card's `[show]` reveals all of it;
  `total_len` is its length. A write with a content value over
  `CONTENT_LIMIT_CHARS` (50,000) is refused, telling the model to split
  it: a value cut on the server would be approved partly unseen.
- A target string over `TARGET_LIMIT_CHARS` (1,000; the server sets no
  page-title limit to borrow) is refused, and so is any input the builder
  raises on (an outline nested past pydantic's depth limit): the
  exception's type is logged, never its message.

### Web (`sse.ts`, `useAssistant.ts`, `AssistantPanel.tsx`)

- `sse.ts`: the `confirm_request` event type gains `preview`, parsed and
  shape-checked; a malformed preview yields a card that shows the error and
  offers only Deny.
- `useAssistant`: `pendingConfirm` becomes a FIFO queue. A new
  `confirm_request` appends; `respondConfirm` answers the head and shows
  the next; the turn's end clears the queue. Status stays `confirm` while
  the queue is non-empty.
- `ConfirmCard` renders `preview`:
  - heading "The assistant wants to make N write(s):" (N = ops count);
  - per op, numbered: the action, then each target as `key` + value on its
    own line, then warnings, then each content value clipped in the card at
    a short visual length with "(N chars) [show]" when longer;
  - every value is a separate element; a string value renders quoted,
    with `"` and `\` escaped and every non-printable except newline shown
    as `\uXXXX` (in content, newlines stay, so a multi-line note stays
    readable, but no line inside it can close the quote; in a target they
    are escaped too, since a target is one line and a raw break would start
    a line under the key column); other values as JSON;
  - no collapse of the card as a whole, so Allow never sits above a hidden
    target. The card scrolls inside the panel when long; Allow and Deny
    stay visible at the bottom.
  - when the queue holds more than one, the card says "1 of N".

### Mock

```
The assistant wants to make 2 writes:
 1  update block   uid "VICTIMUID01"
      text "Tidied wording. Tidied wording. Tidied…"   (480 chars) [show]
 2  rename page    title "Inbox"  new_title "Projects / xxxxxxxx…"
      ⚠ merges into the existing page "Projects / …"
                                         [Allow] [Deny]
```

## Tests

- Server, from `sec-assistant/probe_preview.py` and the review doc's batch
  case: a long first text value cannot hide a later `uid`; batch params
  never clip a `uid`; `commands` as a JSON string previews the same ops as
  the list form; a non-list or a non-schema item is refused;
  `allow_merge: "yes"` previews as `true` with the merge warning;
  `page: "null"` previews as today's daily note; a parity test that, for
  each write tool, the preview's validated values equal what the
  registered FastMCP tool would call the function with; `x), uid=Y`
  in a text value stays one value; every write tool and batch op lists its
  targets in table order; an unknown key appears as a target; the
  field-coverage test above.
- Web: vitest on `ConfirmCard` itself (not a copied slice): targets render
  before content and outside any clipped region, a quoted value cannot
  read as another argument, `[show]` reveals the full content, a malformed
  preview offers only Deny; `useAssistant`: two `confirm_request`s queue,
  answering the first shows the second and posts the right `confirm_id`.
- E2E: the existing assistant confirm spec(s) updated for the new card.

## Docs

- `docs/SECURITY.md` waits for pkm-e95y (Arthur's rule).
- `docs/architecture/` section that owns the assistant confirm flow: the
  rule above and why the table fails safe, replacing the `ops_preview`
  description. `docs/troubleshooting.md`: one row per bean.

## Out of scope

- Showing the resolved host path for `upload_asset` (pkm-d8vp, awaiting
  Arthur's containment decision); the table already lists `path` as a
  target, so that bean only adds a value.
