# Approval Card Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant's write-approval card shows every write's target in
full and first, previews exactly what the tool will receive, and refuses
input that is not schema-shaped.

**Architecture:** A pure server builder turns a write tool's input into a
structured `WritePreview` (or a `Refusal`), validating it with the tool's own
FastMCP argument model and, for `batch`, `pkm.batch`'s command adapter. It
rides on `confirm_request` beside the existing string. The SPA queues
confirms and renders the structured preview as separate, quoted elements.

**Tech Stack:** Python 3.12, FastAPI, mcp FastMCP, pydantic; React + TS,
vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-approval-card-targets-design.md`

## Global Constraints

- Target values are never clipped or collapsed; they render before content.
- Content values clip at 2000 characters server-side (`total_len` = full
  length); the card clips further visually with a "(N chars)" toggle.
- A key the target table does not name is a target.
- Non-schema-shaped input is denied (`PermissionResultDeny`), never
  previewed; no `confirm_request` is sent for it.
- Strings render quoted with `quoteValue` (Task 3): `"` and `\` escaped,
  newlines kept, every other non-printable as `\uXXXX`.
- `docs/SECURITY.md` is not edited (waits for pkm-e95y).
- AGENTS.md comment rules: no bean ids or line numbers in code comments,
  comments at most 80 columns, `# pattern:` / `// pattern:` header on new
  files with runtime behaviour.

## Review Focus

- A first op's multi-line content that draws a fake "2 delete block ..."
  line: the content box must read as one quoted value (Task 4 test).
- `rename_page` with `allow_merge` sent as `"true"`, `"yes"`, `1`: previews
  as true with the warning (Task 1 test).
- Two confirms arriving back to back, then the turn ending: the queue
  clears and no card lingers (Task 3 test).
- A batch `create` whose `parent` is `{{alias}}` or `((uid))`: shown as a
  target verbatim (Task 1 test).
- A tool input that FastMCP's pre-parse turns into a different type
  (`page: "null"`, `page: "[1]"`): previewed as received, or refused
  (Task 1 test).

---

### Task 1: Server preview builder

**Files:**
- Modify: `server/src/pkm/assistant/policy.py` (add the target table and
  action labels beside `WRITE_TOOLS`; remove `ops_preview`, `_batch_lines`,
  `_clip_preview`, `_MAX_PREVIEW_VALUE_CHARS` once Task 2 no longer calls
  them — in Task 2)
- Create: `server/src/pkm/assistant/write_preview.py` (`# pattern:
  Functional Core`)
- Test: `server/tests/test_write_preview.py`

**Interfaces:**
- Produces, in `policy.py`:
  ```python
  # action key -> (label, target keys in display order, content keys)
  WRITE_PREVIEW_FIELDS: dict[str, tuple[str, tuple[str, ...], tuple[str, ...]]]
  ```
  Keys and values exactly (spec table):
  `save_note` ("save note", (page, parent, todo), (text));
  `update_block` ("update block", (uid, mark), (text));
  `upload_asset` ("upload file", (path, page, parent), ());
  `rename_page` ("rename page", (title, new_title, allow_merge), ());
  `batch:create` ("create block", (page, parent, index, as), (text));
  `batch:todo` ("create TODO", (page, parent, index, as), (text));
  `batch:update` ("update block", (uid,), (text));
  `batch:move` ("move block", (uid, page, parent, index), ());
  `batch:delete` ("delete block", (uid,), ());
  `batch:outline` ("add outline", (page, parent), (items)).
  Batch keys use the wire names (aliases: `uid`, `as`), not field names.
- Produces, in `write_preview.py`:
  ```python
  CONTENT_CLIP_CHARS = 2000

  @dataclass(frozen=True)
  class PreviewOp:
      action: str                              # the label above
      targets: list[tuple[str, object]]        # JSON values, unclipped
      content: list[tuple[str, str, int]]      # (key, clipped text, total_len)
      warnings: list[str]

  @dataclass(frozen=True)
  class WritePreview:
      ops: list[PreviewOp]
      summary: str      # one line for logs, e.g. 'batch: 3 ops (move, ...)'

  @dataclass(frozen=True)
  class Refusal:
      message: str

  def build_write_preview(short: str, tool_input: Mapping[str, object]
                          ) -> WritePreview | Refusal: ...
  ```

Rules the body must follow:
- Validate with the registered tool's argument model:
  `func_metadata(<pkm.mcp.server function>)`, then `pre_parse_json`, then
  `arg_model.model_validate`; a `ValidationError` → `Refusal` naming the
  first error's field and message. Read values from the validated model
  (`model_dump`), so defaults appear (`todo: False`, `allow_merge: False`,
  `parent: None`).
- `batch`: each item of the validated `commands` through
  `pkm.batch._BATCH_COMMAND_ADAPTER` (make it public as
  `BATCH_COMMAND_ADAPTER` and update its users); empty list or any item
  error → `Refusal(f"batch item {i}: {problem}")`, reusing
  `_format_command_error` if it fits. Values come from
  `params.model_dump(by_alias=True)`.
- Targets: every table target key in table order with its validated value,
  then every key present in the raw input (or a batch item's raw params)
  that the table does not name, with its raw value.
- Content: strings as-is; `outline` `items` rendered as an indented outline,
  one line per item, two spaces per nesting level. Clip each to
  `CONTENT_CLIP_CHARS`; `total_len` is the unclipped length.
- Warnings: `rename_page` with validated `allow_merge` true adds
  `f'allow_merge is on: if "{new_title}" exists, "{title}" is merged into
  it (irreversible)'`.
- An unknown short name (not in `WRITE_TOOLS`) → `Refusal`.

- [ ] **Step 1: Write the failing tests** in `test_write_preview.py`:
  - `test_targets_come_first_and_unclipped`: `update_block` with
    `text="x"*10_000, uid="VICTIMUID01"` → `ops[0].targets[0] ==
    ("uid", "VICTIMUID01")`; `content[0] == ("text", "x"*2000, 10_000)`.
  - `test_batch_params_never_clip_a_uid`: batch update with 5,000-char text
    then `uid` key last in the dict → target `("uid", <uid>)` intact.
  - `test_string_encoded_commands_preview_like_the_list`: `commands` as
    `json.dumps(list)` → same `WritePreview` as the list form (3 ops: move,
    delete, create).
  - `test_non_list_or_malformed_batch_is_refused`: `commands="nope"`,
    `commands=[]`, `commands=[{"command":"drop","params":{}}]`,
    `commands=[{"command":"delete"}]` → each a `Refusal` whose message names
    the problem.
  - `test_fake_argument_list_stays_one_value`: `save_note` text
    `'x), uid=SAFE, page=Inbox'` → one content entry with that exact text;
    targets are exactly page/parent/todo.
  - `test_allow_merge_coerced_values_warn`: for `"true"`, `"yes"`, `1`,
    `True` → target `("allow_merge", True)` and one warning naming both
    titles; `"maybe"` → `Refusal`.
  - `test_page_null_string_previews_as_received`: `save_note` with
    `page="null"` → target `("page", None)`; with `page="[1]"` → `Refusal`.
  - `test_alias_and_uid_parents_shown_verbatim`: batch create with
    `parent="{{a}}"` and with `parent="((abc))"` → those strings as targets.
  - `test_unknown_key_is_a_target`: `save_note` with `extra="z"` → last
    target `("extra", "z")`.
  - `test_outline_items_render_as_indented_text`: items
    `["a", ["b", ["c"]]]` (check `pkm.batch` `NestedItem` for the real
    shape and use it) → content text with two-space nesting.
  - `test_every_tool_field_is_classified`: for each name in `WRITE_TOOLS`
    except `batch`, the `pkm.mcp.server` function's parameters equal that
    entry's targets ∪ content; for each batch command model in `pkm.batch`,
    its params model's wire names (alias or name) equal the entry's
    targets ∪ content. Fails when a field is added without classifying it.
  - `test_preview_matches_what_the_tool_receives`: for each write tool, call
    the registered tool via `await pkm.mcp.server.mcp.call_tool(short,
    raw)` with the workflow functions it calls (`save_blocks`,
    `edit_block`, `apply_batch`, `upload_and_link`, `PkmClient.rename_page`
    via `_client`) monkeypatched to record their arguments, for hostile raw
    inputs (`allow_merge: "yes"`, `page: "null"`, string-encoded
    `commands`); assert the recorded values equal the preview's targets and
    content.

- [ ] **Step 2: Run them to verify they fail**
  Run: `cd server && uv run pytest tests/test_write_preview.py -q`
  Expected: FAIL (ImportError: `write_preview`).

- [ ] **Step 3: Implement** `WRITE_PREVIEW_FIELDS` and
  `build_write_preview` per the rules above.

- [ ] **Step 4: Run them to verify they pass**
  Run: `cd server && uv run pytest tests/test_write_preview.py -q`
  Expected: PASS. Then mutation check: drop the `pre_parse_json` call, then
  swap target/content for `uid` in `batch:update`, then move unknown keys
  to content; each must turn a test red. Restore.

- [ ] **Step 5: Commit**
  `git add server/src/pkm/assistant/policy.py server/src/pkm/assistant/write_preview.py server/src/pkm/batch.py server/tests/test_write_preview.py <adapter users>`
  `git commit -m "assistant: structured write preview from the tool's own argument model"`

### Task 2: Server wiring: confirm_request carries the preview; refusals deny

**Files:**
- Modify: `server/src/pkm/assistant/events.py` (`ConfirmRequest`)
- Modify: `server/src/pkm/assistant/claude_engine.py` (`can_use_tool`)
- Modify: `server/src/pkm/assistant/policy.py` (delete `ops_preview` and its
  helpers; keep `_clip`/`tool_summary`)
- Modify: `server/tests/fake_engine.py`, `server/tests/test_claude_engine.py`,
  `server/tests/test_assistant_events.py`,
  `server/tests/test_assistant_policy.py` (remove `ops_preview` tests whose
  property Task 1 now owns), `server/tests/test_fake_engine.py`

**Interfaces:**
- Consumes: `build_write_preview`, `WritePreview`, `Refusal` (Task 1).
- Produces: `ConfirmRequest(confirm_id: ConfirmId, ops_preview: str,
  preview: WritePreview)`. SSE JSON:
  `{"confirm_id", "ops_preview": <summary>, "preview": {"ops": [{"action",
  "targets": [[k, v]], "content": [[k, text, n]], "warnings": [..]}],
  "summary"}}`.
- The fake engine's "please write" trigger sends the real
  `build_write_preview("save_note", {"text": "Demo", "page": "Demo"})`;
  add a "please write twice" trigger that yields two `ConfirmRequest`s
  (ids `fake-confirm-N`, `N+1`) before awaiting either, then "Saved 2." /
  per-decision text, for the queue e2e in Task 4.

- [ ] **Step 1: Failing tests**
  - `test_claude_engine.py::test_refused_write_is_denied_without_a_confirm`:
    `can_use_tool("mcp__pkm__batch", {"commands": "nope"}, None)` returns
    `PermissionResultDeny` whose message contains `batch`, and the engine
    queue holds no `ConfirmRequest`.
  - `test_claude_engine.py::test_confirm_request_carries_structured_preview`:
    a valid `update_block` input → the queued `ConfirmRequest.preview.ops[0]
    .targets[0] == ("uid", ...)` and `ops_preview == preview.summary`.
  - `test_assistant_events.py::test_confirm_request_sse_shape`: `encode_sse`
    of a `ConfirmRequest` decodes to the JSON shape above (tuples as lists).
- [ ] **Step 2:** `cd server && uv run pytest tests/test_claude_engine.py tests/test_assistant_events.py -q` → FAIL.
- [ ] **Step 3:** Implement; refusals logged at WARNING with the tool name
  (message only, the logging filter escapes it).
- [ ] **Step 4:** `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check` → all pass.
- [ ] **Step 5: Commit** `assistant: confirm_request carries the structured preview; malformed writes are denied`

### Task 3: Web: event shape, quoting, confirm queue

**Files:**
- Modify: `web/src/assistant/sse.ts` (+ `sse.test.ts`)
- Create: `web/src/assistant/writePreview.ts` (`// pattern: Functional Core`)
  + `writePreview.test.ts`
- Modify: `web/src/assistant/useAssistant.ts` (+ `useAssistant.test.tsx`)

**Interfaces:**
- Produces, in `writePreview.ts`:
  ```ts
  export type PreviewOp = { action: string; targets: [string, unknown][];
    content: [string, string, number][]; warnings: string[] };
  export type WritePreview = { ops: PreviewOp[]; summary: string };
  export function parseWritePreview(raw: unknown): WritePreview | null;
  export function quoteValue(s: string): string;
  export function formatTarget(key: string, value: unknown): string;
  ```
  `parseWritePreview` checks every field's type and returns null on any
  mismatch. `quoteValue` wraps in `"`, escapes `"` and `\`, keeps `\n`,
  writes every other non-printable (C0, DEL, C1, U+2028/2029, bidi and
  other format characters) as `\uXXXX`. `formatTarget`: `null` with key
  `page` → `today's daily note`; `null` otherwise → `none`; a string →
  `quoteValue`; anything else → `JSON.stringify`.
- `sse.ts` `confirm_request` event: `{ type; confirm_id: ConfirmId;
  ops_preview: string; preview: WritePreview | null }` (null when
  `parseWritePreview` rejects it).
- `useAssistant` returns `pendingConfirm: PendingConfirm | null` (the queue
  head) and `pendingConfirmCount: number`, with `PendingConfirm =
  { confirmId: ConfirmId; opsPreview: string; preview: WritePreview | null }`.
  A `confirm_request` appends; `respondConfirm` posts the head's id and
  removes it; status stays `"confirm"` while the queue is non-empty, else
  `"busy"`; the turn's `finally` empties the queue.

- [ ] **Step 1: Failing tests**
  - `writePreview.test.ts`: `quoteValue('a"b\\c')` → `"a\"b\\c"` (as a JS
    string literal: `'"a\\"b\\\\c"'`); `quoteValue("x\ny")` keeps the
    newline; `quoteValue(" ‮\u0007")` → `" ‮\u0007"`
    escaped as text; `formatTarget("page", null)` → `today's daily note`;
    `parseWritePreview` returns null for a missing `ops`, a target that is
    not a pair, a content entry whose length is not a number.
  - `sse.test.ts`: a `confirm_request` frame with a valid preview parses it;
    with `preview: 42` yields `preview: null`.
  - `useAssistant.test.tsx::queues a second confirm behind the first`: two
    `confirm_request`s → `pendingConfirm.confirmId === "c1"`,
    `pendingConfirmCount === 2`; `respondConfirm(true)` posts `c1`, then
    head is `c2` and status is still `"confirm"`; ending the turn clears it.
- [ ] **Step 2:** `cd web && pnpm test:unit -- src/assistant` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `cd web && pnpm test:unit -- src/assistant && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `web: parse the structured write preview and queue confirms`

### Task 4: Web: ConfirmCard renders the preview

**Files:**
- Modify: `web/src/assistant/AssistantPanel.tsx` (`ConfirmCard`; delete
  `PREVIEW_COLLAPSE_THRESHOLD` and its comment)
- Modify: `web/src/assistant/AssistantPanel.test.tsx`
- Modify: the stylesheet that styles `.assistant-confirm-card` (grep), using
  existing tokens per `docs/architecture/styling.md`
- Modify: `web/e2e/assistant.spec.ts`

**Interfaces:**
- Consumes: `PendingConfirm`, `pendingConfirmCount` (Task 3),
  `formatTarget`, `quoteValue`.
- Card structure (class names are the test hooks):
  `.assistant-confirm-title` "The assistant wants to make N write(s):"
  (+ " — 1 of M" when `pendingConfirmCount > 1`); per op an
  `ol > li.assistant-confirm-op` with `.assistant-confirm-action`, then one
  `.assistant-confirm-target` per target (`<span class=key>` +
  `<span class=value>` with `formatTarget`), then `.assistant-confirm-warning`
  per warning (prefixed ⚠), then one `.assistant-confirm-content` per
  content entry: key, `quoteValue` of the first 280 chars (+ `…` when
  longer), and when `total_len > 280` a "(N chars) [show]" toggle that
  swaps in the full sent text (and notes "clipped by the server at 2000"
  when `total_len > text.length`). Content values render in a bordered,
  pre-wrap block. `preview === null` → an error line "The write preview
  could not be read." and only the Deny button. The ops list scrolls inside
  a max-height region; Allow/Deny sit outside it.

- [ ] **Step 1: Failing tests** in `AssistantPanel.test.tsx` (render
  `ConfirmCard` through `AssistantPanel` with a stubbed `useAssistant`, as
  the file does now):
  - `targets render before content and are never clipped`: an op with a
    5,000-char text and `uid` → the `.assistant-confirm-target` containing
    `"VICTIMUID01"` precedes the content in document order and its full
    value is in the DOM before any toggle is clicked.
  - `a quoted value cannot read as another argument`: content
    `'x"\n2 delete block uid "Y"'` renders inside one
    `.assistant-confirm-content` whose text starts and ends with `"` and
    shows the inner quote as `\"`.
  - `show reveals the full content`: click "[show]" → full text present.
  - `malformed preview offers only Deny`: `preview: null` → no Allow button.
  - `shows the queue position`: `pendingConfirmCount: 2` → "1 of 2".
- [ ] **Step 2:** `cd web && pnpm test:unit -- src/assistant/AssistantPanel` → FAIL.
- [ ] **Step 3:** Implement the card and styles.
- [ ] **Step 4:** Update `assistant.spec.ts`: the card shows action "save
  note" and target `page` `"Demo"` instead of the old string; add a test
  using the "please write twice" trigger: "1 of 2" shows, Allow advances to
  the second card, Deny ends with both replies. Then
  `cd web && E2E_PORT=<assigned> pnpm verify` → PASS.
- [ ] **Step 5: Commit** `web: approval card renders targets first, values quoted, confirms queued`

### Task 5: Docs and beans

**Files:**
- Modify: `docs/architecture/assistant.md` (the `policy.py` row and the
  confirm-flow section: the rule, why unknown keys count as targets, why the
  preview validates with the tool's own argument model; replace any
  `ops_preview` description; use the `architecture-docs` skill)
- Modify: `docs/troubleshooting.md` (one row per bean: pkm-1zdg, pkm-i9pg)
- Modify: `.beans/pkm-1zdg--*.md`, `.beans/pkm-i9pg--*.md`

- [ ] **Step 1:** Update the docs; verify each claim against the code.
- [ ] **Step 2:** Run `PYTHONPATH=server/tooling python3 -m commentlint.run --all` → clean.
- [ ] **Step 3:** Tick both beans' items (the "check ops_preview against
  live payloads" item is satisfied by Task 1's parity test: say so), add
  `## Summary of Changes`, set completed.
- [ ] **Step 4: Commit** `docs: approval card rule and preview source; complete pkm-1zdg, pkm-i9pg`
