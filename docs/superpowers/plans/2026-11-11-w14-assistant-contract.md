# W14 Assistant Contract, Preview and Confirm State: Task-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Implementers work under the epic's implementer brief; this plan does not restate it.

**Goal:** The SSE event union is generated from `events.py`, so the web cannot drift from the server's events; a write tool call is validated once per preview, and the reads, the card and the input Allow runs all come from that one checked value; the web's confirm answer lives on the card it answers, in place of a chat-wide flag and a separate decision field. Fields nothing reads leave the wire. The chat driver takes its client functions, so W19 can drive it.

**Source:** `docs/superpowers/plans/2026-11-09-maintainability-review-fixes.md` § W14, its Global Constraints and Review Focus, and § W3 (merged), whose acknowledged Stop and `interrupting` phase this branch keeps unchanged. Branch `refactor/assistant-contract`, read at `main` @ `9e54b7dc`, with W3, W12, W13 and W17 merged.

**Architecture:** Three lanes on disjoint files (server preview, the generated contract, the web confirm state), then one joining task that drops the unread wire fields once both sides read the generated union, then the live smoke and the docs. Behaviour pins land before each change, in their own commit.

**Tech stack:** Python 3.12, pydantic, pytest + Hypothesis (`tests/props/`), pyrefly, ruff; TypeScript, React 18, vitest + jsdom, fast-check (`web/src/props/gate.ts`).

## Global Constraints

The epic's Global Constraints apply unchanged. The ones that bite here:

- Every task: its own worktree off `refactor/assistant-contract`, merged back with `git merge --no-ff`. Run `pwd` and `git branch --show-current` before the first write.
- Server gates after every commit, from `server/`: `uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check`.
- Web gates without Playwright, for any task that touches `web/`: `cd web && pnpm typecheck && pnpm lint && pnpm lint:comments && pnpm check:fcis && pnpm test:coverage && pnpm build`, each with `--config.verify-deps-before-run=false`; never `pnpm add/install/update` (`node_modules` is a symlink). `pnpm verify`, Playwright and `proptest/check.sh` are the orchestrator's, run serially: other sessions hold port 8978 and the machine.
- A task that changes `events.py`, the dump, or anything the dump reads runs `uv run python -m pkm.regen` from `server/` (the worktree needs `web/node_modules`, since the run includes `pnpm gen-types`), commits what it rewrites, and checks `git status --short` against the expected diff the task states. Any other diff is a stop-and-report.
- Converted machine: the confirm answer state is part of a machine an existing suite covers (`web/src/props/assistant`), so its model changes in this branch (Task 6). The driver shell property stays W19's.
- Comments: no bean ids, line numbers or plan pointers; at most 80 columns in comments; AGENTS.md's banned word stays out. Each new runtime file declares its FCIS pattern.
- Docs under `docs/architecture/` go through the `architecture-docs` skill (Task 10 only).
- Ports: never 8974. The live smoke uses 8975 (Task 9).
- Public repo: the smoke and the docs describe mechanisms only, never where a credential sits.

## Review Focus

Failure modes no single task's tests are certain to exercise, most likely first. Each names what pins it.

1. **A refusal changes its words.** Input that raises inside validation (an outline nested past pydantic's depth limit) must still answer `<tool>: input could not be previewed`, never the read failure's `could not be read`; an over-long validation refusal is still cut at `REFUSAL_LIMIT_CHARS`; and input the card refuses still reads no block. Task 1's pins, committed before the change.
2. **Allow runs a different call than the card showed.** The reads, the card and `approved_input` must all come from the one deep copy `check_write` validated. `test_preview_write_is_a_snapshot` and `test_preview_write_returns_an_approval_from_the_snapshot` keep their assertions through Task 1.
3. **A retried answer differs from the failed one.** The server may already hold a failed POST's answer, so after a failure only the same answer may be sent. Task 6's `step` tests and the property's `confirm` invariant, with a mutant that lets it change.
4. **Stop disappears while a card is stuck.** While an answer posts, or after its post failed, Stop must stay offered: it is the way out of the card. Task 6's `canStop` table and the new `stoppable` invariant, with a mutant.
5. **An old bundle against the new server.** A PWA keeps its bundle across a deploy. The old parser must still yield the card and mark tool lines without the dropped fields. Task 8's pins on the old code, and Task 9's old-bundle run.
6. **The turn witness.** `TurnDone.usage` is how the server's turn property tells a turn's own result from another turn's. It stays (Question 1); if Arthur rules otherwise, Task 8 must install a replacement witness before the field goes.

---

## Where the code disagrees with W14

The code wins; the tasks are written to it.

| W14 says | The code says | What the plan does |
|---|---|---|
| `preview_keys_dump.py` becomes `wire_dump.py` and "also emits" `events.gen.ts` | `pkm.regen` writes one stdout per step to one `target`; `test_every_dump_module_is_a_step` only asks that the module be a step. `web/tooling/fcis-exemptions.json` exempts `previewKeys.gen.ts` by name | Two `Step`s on the same module, each with an `args` selector and its own target, so a failed run never empties either file. The new file gets its own exemption row (Task 4) |
| The dump emits "the `AssistantEvent` union" from the dataclasses | The web union is the *parsed* event: `confirm_request.preview` is `WritePreview \| null`, since a malformed preview still yields the card (Deny only). `ConfirmRequest.confirm_id` is the `ConfirmId` NewType, which the web holds as a brand in `api/brands.ts`. `events.py` uses `from __future__ import annotations`, so field types are strings until resolved | The dump resolves hints with `typing.get_type_hints` and maps them through a fixed table; `preview` takes a named override, with its reason in the dump; an unmapped type, or a NewType `brands.ts` does not export, raises `WireDumpError` (the `rows_dump` precedent). The dump reads `EVENT_NAMES` (made public; the dump is its second reader) and refuses a union member with no name or a name with no member |
| Drop `ConfirmRequest.ops_preview` / `PendingConfirm.opsPreview` | Unread on the web: `chatMachine.applyStreamEvent` copies it into `opsPreview`, which nothing renders or posts. On the server it is read only by `test_claude_engine.py` (four assertions, one of them `card.ops_preview == card.preview.summary`) and set by `fake_engine.py`; no log reads it. No conversation data is persisted or replayed on either side: the registry is in memory and the panel's history is lost on reload | Dropped (Task 6 stops copying it on the web; Task 8 removes it from the wire). Server tests read `preview.summary` instead; the tautology goes |
| Drop `TurnDone.usage` | Unread on the web (`turn_done` reads only its type). On the server it is read: the turn property's `assert_of` and `finish` rule compare `TurnDone(usage={"tag": prompt})`, the only check that a turn's `TurnDone` came from its own `ResultMessage` (epic Review Focus 4); the label `user stop as the harness finished: the turn's own result` depends on it; so do the exact-event assertions in `test_assistant_turn_phase.py` and `test_assistant_routes.py` | **Kept** (Question 1). Wire-safe either way; the generated union types it optional. If Arthur says drop, Task 8 first gives the property another witness, then shows it fails on a mutant that reads the previous turn's result |
| Drop `ToolFinished.name` | Unread on the web: a tool line takes its name from `tool_started` and pairs by `tool_use_id`. On the server it appears only in equality assertions (31 constructions; one pins the `"tool"` fallback for an unknown id) | Dropped (Task 8); `_finished` keeps the full name it needs for `classify_tool` |
| `preview_write` calls `write_preview._validate` once inside one `try` | `_validate` is private to `write_preview`. Inside the read's `try`, a validation that raises would answer `could not be read`, where today `build_write_preview`'s own catch answers `input could not be previewed`. A validation `Refusal` today also passes `build_write_preview`'s length cut | Public `check_write(short, tool_input) -> CheckedWrite \| Refusal`, which never raises (its catch gives `input could not be previewed`) and cuts as `build_write_preview` does, through one shared `_bounded`. `preview_write` calls it before the read's `try` (Task 1) |
| `_validate` runs once per preview | It runs five times per `preview_write` today: `ancestor_uids`, `write_target_uids` and `delete_target_uids` (each through `_accepted`), `_build`, and `shown_blocks` (through `approved_input`) | Task 1's red test counts the calls |
| `build_write_preview(checked, blocks)`, `shown_blocks(checked, blocks)` | `_build` needs `short` for its summary and `batch item N` wording; `approved_input` needs the input itself. `_Checked` holds neither | `CheckedWrite` carries `short` and `tool_input` (the validated deep copy) beside `ops` and `aliases`, so Allow's input is the object the card was built from. `approved_input(checked, blocks)` follows |
| `target_uids(checked, entries)` | Callers: `target_reader.preview_write` and `test_target_reader.py`; the "never raises" tests for the three uid functions monkeypatch `_validate` | The three "never raises" tests become one on `check_write`; `target_uids` and `ancestor_uids` only see accepted input, by type |
| `shown_blocks` raises for input the card refuses | A `CheckedWrite` exists only for accepted input | That raise and its test go; the raise for a delete target read without its subtree hash stays |
| Add `test_the_missing_uid_warning_matches_classify_skip` | A batch `update` plans two ops (`plan_update` with no `current_heading` always adds `set_heading`), and the update's text loses its heading hashes (`split_heading`). On a missing uid, `classify_skip` (`server/ops_core.py`) lands the `update_text` only when that body is non-blank, and the `set_heading` always lands a "heading change skipped" note. `_missing_uid_warning` says the text is added to today's daily note whatever the body | The test classifies every op the command plans, for a non-blank body, a blank text and a heading-only text; for a blank body the warning says a note lands, in the move's wording (Question 2) |
| Delete `policy.all_tool_names()` and its count assertion | Its only caller is `test_tool_names_namespaced`; `test_system_prompt_names_every_write_verb`'s docstring names it | Both go; the docstring states its own tripwire (Task 2) |
| `ChatState.answering` and `sentDecision` | Also: `useAssistant` returns `answering`; `AssistantPanel` reads it for the card's disabled buttons and for Stop; `teeth.prop.ts` builds two mutant states with `answering: false`. `answering` is only ever set with the head's `sentDecision`, and both clear together | `PendingConfirm.answer` replaces both; `useAssistant` returns `canStop` in place of `answering`. Today's Stop condition (`busy \|\| answering \|\| head.sentDecision !== null`) equals `canStop` because `answering` implies a decision (Task 6) |
| "The assistant property model's confirm invariant is re-pointed" | The `confirm` invariant (`run.ts`) reads only effects and the World's requests; the `View` carries confirm ids only, so the property never saw `answering` or `sentDecision`. The simulated server also reports every posted answer as `allow: true` (`settleConfirm`) | `View` gains each card's `answer` and `canStop`; the World records each card's answer from its requests and checks the view against it. `settleConfirm` echoes the posted answer (Task 6) |
| Delete the unreachable `conversation.kind === "creating"` guard in `step` `send` | Confirmed: a conversation is `creating` only while its turn is `creating` or `stopping`, and `send` returns first unless the turn is `idle` | Deleted in Task 6, which owns `chatMachine.ts` |
| `createChatDriver` takes its client functions | It is module-private in `useAssistant.ts` and imports `./client` directly; the hook tests replace that module with `vi.mock`. It also reads `setTimeout` and `Date.now()` | Moved to `chatDriver.ts`, taking a `ChatClient`; `useAssistant` passes the real functions, so the `vi.mock` tests keep working. Timers stay global (Question 4) |
| Add the "missing" test `newChat sends the DELETE only after the aborted stream settles` | The behaviour exists (`run` case `delete` awaits the turn's `settled`), so the test passes at the base | A pin, shown to fail once against a mutant that deletes without waiting (Task 7) |
| W19's list gains the driver | Both W14 rows are already in W19's table | Task 10 corrects them to what ships |
| (live smoke, not in W14's bullets) | `create_app`'s `api_port` defaults to 8974, and that port is the URL the harness's MCP server calls; `pkm.server.run` passes `--port` through. The engine runs the CLI with `strict_mcp_config` and no setting sources, so no other MCP server is reachable | The smoke runs the server through `pkm.server.run --port 8975` and proves the write landed on 8975 (Task 9) |
| `service.py` comments state the rule without the history | Confirmed: the `CREATE_TIMEOUT_S` comment ("lives here, once, and is cross-referenced from the two places that used to retell it"), the admission-lock comment ("The other await that used to run under this lock"), the close-loop comment ("the same class of leak closed one layer down") | Task 3 |
| What W3, W12, W13 and W17 changed | W3: `TurnStopped`, the stop route, `postStop`, `STOP_ACK_TIMEOUT_MS`. W12: `parent_chain` public. W13: `READ_TOOL_NAMES` in `pkm/mcp/names.py`, so nothing of W14's tool-name bullet is left but `all_tool_names`. W17: `pkm.regen`, reach floors on both assistant suites | Tasks build on all four; none of W14's items was already done |

## Wire compatibility

A deploy can leave a tab running the old bundle against the new server; the server serves the bundle, so a new bundle never meets an old server in production, but the parser is written for both directions anyway.

| Change | Old bundle, new server | New bundle, old server | Verdict |
|---|---|---|---|
| `confirm_request` loses `ops_preview` | `sse.ts` sets `ops_preview: undefined`; `opsPreview` is stored and never read; the card renders from `preview` | The new parser builds the event from `confirm_id` and `preview` and ignores the extra key | Safe in either order |
| `tool_finished` loses `name` | The event spreads its payload; `chatMachine` reads `tool_use_id`, `error`, `declined`, `warning` only | The extra key rides along unread | Safe in either order |
| `turn_done` keeps `usage` (Question 1) | No change | No change | Safe; if dropped later, equally safe on the wire |
| Event names | Unchanged; `EVENT_TYPES` is the same set | Same | No ordering rule needed |

The tolerance this relies on becomes a stated rule (Task 10, frontend.md): the parser keeps a frame's unknown keys, and the generated union marks every field with a server-side default optional, so a field a later server drops is one the web must already treat as absent. Only `preview` is checked strictly (`parseWritePreview`). Task 8 commits the old-bundle pins before it touches the parser.

## Files

| File | Change | Task |
|---|---|---|
| `server/src/pkm/assistant/write_preview.py` | `CheckedWrite`, `check_write`, `_bounded`; uid helpers, builder and guard take the checked value; `_accepted` gone | 1 |
| `server/src/pkm/assistant/target_reader.py` | one validation per preview | 1 |
| `server/src/pkm/assistant/policy.py` | `all_tool_names` gone | 2 |
| `server/src/pkm/assistant/service.py` | comments | 3 |
| `server/src/pkm/assistant/wire_dump.py` | renamed from `preview_keys_dump.py`; emits the event union too | 4 |
| `server/src/pkm/assistant/events.py` | `EVENT_NAMES` public (4); `ops_preview`, `name` dropped (8) | 4, 8 |
| `server/src/pkm/regen.py` | two steps on `wire_dump` | 4 |
| `web/src/assistant/events.gen.ts` | new, generated | 4, 8 |
| `web/src/assistant/sse.ts` | imports the union and `EVENT_TYPES` | 4, 8 |
| `web/src/assistant/chatMachine.ts` | `PendingConfirm.answer`, `canStop`, `answerFailed` | 6 |
| `web/src/assistant/AssistantPanel.tsx`, `useAssistant.ts` | render from the selectors | 6, 7 |
| `web/src/assistant/chatDriver.ts` | new, Imperative Shell: `createChatDriver(publish, client)` | 7 |
| `web/src/props/assistant/run.ts`, `teeth.prop.ts`, `assistant.prop.ts`, `run.test.ts` | the answer state in the view and the World; new invariant and mutants | 6 |
| `server/src/pkm/assistant/claude_engine.py`, `server/tests/fake_engine.py` | emit the slimmer events | 8 |
| `docs/architecture/assistant.md`, `frontend.md`, `backend.md`; the epic plan's W19 table | | 10 |

## Tasks

### Task 1: Validate a write once: `check_write` and `CheckedWrite`

**Implementer:** opus (validation order decides which refusal the model sees; Allow must run the validated copy).

**Files:** `server/src/pkm/assistant/write_preview.py`, `target_reader.py`; tests `server/tests/test_write_preview.py`, `test_target_reader.py`, `test_fake_engine.py`.

**Interfaces** (in `write_preview`, Functional Core):
- `CheckedWrite`, a frozen dataclass replacing `_Checked`: `short: str`, `tool_input: dict[str, object]` (the input as passed, which `preview_write` has already deep-copied), `ops: list[tuple[str, dict[str, Any]]]`, `aliases: dict[str, int]`. Its docstring says it exists only for input the tool accepts, and that Allow runs `tool_input`.
- `check_write(short: str, tool_input: Mapping[str, object]) -> CheckedWrite | Refusal`: `_validate` inside a `try`. An exception logs its type only and returns `Refusal(f"{short}: input could not be previewed")`; a `Refusal` passes through `_bounded`. Never raises.
- `_bounded(refusal: Refusal) -> Refusal`: today's `REFUSAL_LIMIT_CHARS` cut, moved out of `build_write_preview`, which also uses it.
- `target_uids(checked: CheckedWrite, entries: frozenset[str]) -> list[BlockUid]` replaces `write_target_uids` and `delete_target_uids` (callers pass `CURRENT_TEXT_ENTRIES` or `SUBTREE_DELETE_ENTRIES`).
- `ancestor_uids(checked: CheckedWrite) -> list[BlockUid]`.
- `build_write_preview(checked: CheckedWrite, blocks: Mapping[BlockUid, StoredBlock]) -> WritePreview | Refusal`; `_build` takes the checked value and no longer validates. Its catch and `_bounded` stay.
- `shown_blocks(checked: CheckedWrite, blocks) -> list[ExpectedBlock]`; `approved_input(checked: CheckedWrite, blocks) -> dict[str, object]`, built from `checked.tool_input`.
- `_validate` becomes `_validate(short, tool_input) -> CheckedWrite | Refusal`, called only by `check_write`. `_accepted` and `_targets` go.

`target_reader.preview_write` becomes, in order: deep-copy the input (a failure is `_unreadable`, as today); `check_write` (a `Refusal` returns at once, reading nothing); then one `try` around `ancestor_uids`, `target_uids` and the read (`_unreadable` on failure); `build_write_preview`; then `approved_input` in its own `try` (`_unreadable` on failure, as today). The module docstring keeps its "one deep copy" paragraph and says the copy is validated once.

- [ ] **Pin first, own commit** (`test_target_reader.py`), passing at the base and unchanged after:
  - `test_input_that_raises_in_validation_is_not_previewable_and_reads_nothing`: monkeypatch `write_preview._validate` to raise; `preview_write("update_block", …)` returns `Refusal("update_block: input could not be previewed")`, and the reader is never called.
  - `test_a_long_validation_refusal_through_preview_write_is_cut`: an unknown key far longer than `REFUSAL_LIMIT_CHARS`; the refusal ends with the `… (N characters)` suffix.
  - `test_a_deep_outline_through_preview_write_is_refused_not_raised`: the nesting `test_deep_outline_nest_is_refused_not_raised` uses, through `preview_write`.
- [ ] **Red:** `test_a_preview_validates_its_call_once`: wrap `write_preview._validate` with a counter; run `preview_write("batch", …)` on a batch with an update, a move under a `((uid))` and then a delete (so the uid, ancestor, builder and guard paths all run); assert one call. It counts five today. Add `test_check_write_never_raises` (monkeypatched `_validate` raising each of `RecursionError`, `ValueError`), replacing the three `*_never_raises` tests for the uid functions, and `test_approved_input_runs_the_checked_copy`: mutate the raw dict after `check_write`; `approved_input` returns the checked copy.
- [ ] **Convert the tests.** `test_write_preview.py` gets one raw-input helper, `_checked(short, raw) -> CheckedWrite` (asserts not a `Refusal`), and `_outcome(short, raw, blocks={})`, which runs `check_write` then `build_write_preview`; `_preview` and `_refusal` call `_outcome`. Every assertion keeps its expected value; only call shapes change. `test_shown_blocks_of_input_the_card_refuses_raise` goes (the type rules the case out). `test_target_reader.py`'s `reader.calls` expectations call `target_uids(_checked(...), ...)`. `test_fake_engine.py` builds its preview through `check_write`.
- [ ] **Done:** server gates green. `git grep -n "_accepted\|write_target_uids\|delete_target_uids\|_Checked\b" -- server` is empty; `git grep -n "_validate(" -- server/src/pkm/assistant` finds the definition and the one call in `check_write`. The pins and `test_preview_write_is_a_snapshot`, `test_preview_write_returns_an_approval_from_the_snapshot`, `test_preview_matches_what_the_tool_receives` and `test_every_refusal_is_bounded` pass with their assertions unmodified. No regen diff.

### Task 2: The missing-uid warning matches `classify_skip`; `all_tool_names` goes

**Implementer:** sonnet. Starts after Task 1 merges (`test_write_preview.py`).

**Files:** `server/src/pkm/assistant/write_preview.py` (`_missing_uid_warning`), `policy.py`; tests `test_write_preview.py`, `test_assistant_policy.py`.

- [ ] **Red:** `test_the_missing_uid_warning_matches_classify_skip`, beside `test_the_parent_warnings_match_the_planner` and in its style. For batch `update` with text `"t"`, `"# t"`, `""`, `"  "` and `"# "`, and for batch `move`, each naming a uid no block has: plan the command with `pkm.batch.plan_batch` (the update path needs no page), call `classify_skip(op, block_exists=False, parent_exists=True)` on every op it plans, and record which land something (`landing_uid` set) and whether that is the text (`orphan_edit`) or a note (`orphan_structural`). Then assert the card's warning for the same command matches: it says the text lands exactly when an `orphan_edit` lands, and otherwise that a note lands (every case here lands at least the `set_heading` or move note, under the same header). The blank-body cases fail today.
- [ ] **Implement:** `_missing_uid_warning` takes the validated text. For a batch update whose body (`split_heading(text)[0]`) is blank by `str.strip()`, it says `if no block has uid "X", nothing is updated and a note saying so is added to today's daily note`, the move's wording; otherwise as today. Its docstring names the `set_heading` the planner adds and `classify_skip`'s blank rule. Under Question 2's other answer, the test pins the non-blank cases and the move only, and the warning is unchanged.
- [ ] **Delete** `policy.all_tool_names` and the two assertions in `test_tool_names_namespaced` that call it; the `read_tool_names()` set assertion stays. `test_system_prompt_names_every_write_verb`'s docstring stops naming it.
- [ ] **Done:** server gates green; `git grep -n "all_tool_names" -- server` is empty. No regen diff.

### Task 3: `service.py` comments state the rule

**Implementer:** sonnet.

**Files:** `server/src/pkm/assistant/service.py` (comments only).

- [ ] Rewrite in the present tense, keeping every rule: the `CREATE_TIMEOUT_S` comment (what the bound costs: the cancelled handshake's cleanup runs under the lock first, so the worst hold is the timeout plus the SDK's bounded close); the admission-lock comment (closing a reaped or evicted harness happens after the lock, because eviction needs only the pop to be atomic with the cap check); the close loop (each queued handle is closed even when a cancellation lands, since nothing else will retry it, and the first cancellation is re-raised after). Drop "used to", "lives here, once", "cross-referenced from", "closed one layer down" and the like.
- [ ] **Done:** server gates green; `git diff --stat` shows `service.py` only; `git grep -n "used to\|one layer down" -- server/src/pkm/assistant/service.py` is empty.

### Task 4: `wire_dump` generates the event union

**Implementer:** opus (the generated contract both sides compile against).

**Files:** `git mv server/src/pkm/assistant/preview_keys_dump.py server/src/pkm/assistant/wire_dump.py`; `git mv server/tests/test_preview_keys_artifact.py server/tests/test_assistant_wire_artifact.py`. Modify `events.py` (`_EVENT_NAMES` → `EVENT_NAMES`), `server/src/pkm/regen.py`, `web/src/assistant/sse.ts`, `web/tooling/fcis-exemptions.json`. Create `web/src/assistant/events.gen.ts` (by regen).

**Interfaces** (`wire_dump`, `# pattern: Imperative Shell`):
- `python -m pkm.assistant.wire_dump preview-keys` prints today's `previewKeys.gen.ts`; `… events` prints `events.gen.ts`. `main(argv: Sequence[str]) -> int`; an unknown or missing selector exits 2 with usage on stderr.
- `events_module(names: Mapping[type, str]) -> str`, pure. For each dataclass in `names` order: `| { type: "<name>"; <field>: <ts>; … }`. Field types from `typing.get_type_hints(cls)`: `str` → `string`, `bool` → `boolean`, `int` → `number`, `X | None` → `<X> | null`, `dict[str, object]` → `Record<string, unknown>`, a NewType that `web/src/api/brands.ts` exports → that name, imported as a type from `"../api/brands"`. `_OVERRIDES = {(ConfirmRequest, "preview"): "WritePreview | null"}`, imported as a type from `"./writePreview"`, with the reason in a comment: a malformed preview still yields the card, which then offers Deny only. A field with a default is emitted optional (`?:`). Anything else raises `WireDumpError`. Then `export const EVENT_TYPES: ReadonlySet<string> = new Set([...]);` in the same order.
- `events_module` raises `WireDumpError` when the members of `events.AssistantEvent` (`typing.get_args`) and the keys of `EVENT_NAMES` differ.
- The header names the command and says to regenerate when `events.py` changes; every comment line fits 80 columns.
- `regen.STEPS`: `Step("preview-keys", "pkm.assistant.wire_dump", args=("preview-keys",), target="web/src/assistant/previewKeys.gen.ts")` and `Step("assistant-events", "pkm.assistant.wire_dump", args=("events",), target="web/src/assistant/events.gen.ts")`.
- `sse.ts`: `export type { AssistantEvent } from "./events.gen"` and `import { EVENT_TYPES } from "./events.gen"`; its own union and set go. `parseFrame` is unchanged in this task.
- `fcis-exemptions.json`: a row for `src/assistant/events.gen.ts` in the wording of the `previewKeys.gen.ts` row; that row names `wire_dump.py`.

- [ ] **Red** (`test_assistant_wire_artifact.py`, which keeps every preview-keys test): `test_committed_events_artifact_matches_the_union`; `test_every_event_has_a_wire_name_and_every_name_an_event` (a fake mapping missing one member raises); `test_an_unmapped_field_type_is_refused` (a fake dataclass with a `float` field); `test_a_brand_the_web_lacks_is_refused`; `test_a_defaulted_field_is_optional`; `test_the_preview_override_names_its_import`; `test_main_prints_each_artifact` for both selectors; the 80-column test covers both modules. `test_regen.py` passes unmodified.
- [ ] **Regen.** Expected diff, only: new `web/src/assistant/events.gen.ts`; in `previewKeys.gen.ts`, the header's command line. `openapi.json` and `types.d.ts` do not change: the SSE events are not in the OpenAPI schema.
- [ ] **Check the generated union against today's.** The only differences from `sse.ts`'s hand-written union are that `tool_finished`'s `error`, `declined` and `warning` and `turn_done`'s `usage` become optional (they have defaults). `chatMachine` already reads them with `?? null` and `=== true`. A compile error elsewhere is a stop-and-report.
- [ ] **Done:** server gates and web gates green; `sse.test.ts` passes unmodified; `git grep -n "preview_keys_dump\|test_preview_keys_artifact" -- server web` is empty (docs wait for Task 10).

### Task 5: Reducer cases move to `chatMachine.test.ts`

**Implementer:** sonnet (moves; no behaviour change). Lane W's first task, so the moved tests pin Task 6.

**Files:** `web/src/assistant/useAssistant.test.tsx`, `chatMachine.test.ts`.

- [ ] **The rule:** a test moves when its assertions read only state the hook publishes from `step` (items, cards, phase, error, picker, status) and its setup only feeds events in order. It stays when it asserts which request runs, when, or how it settles: abort handles, timers, the 409 retry, the stop POST's timing, the DELETE's ordering, the beacon, the promise `respondConfirm` or `newChat` returns, or `ensureModels`' fetch.
- [ ] **Candidates** (each checked against the rule; the report lists every test moved or kept with a one-line reason): "tool events render as tool items"; the six `tool_finished` tests from "tool_finished marks the line with its own id" to "a tool_finished with an unknown id changes no line"; "phase events update the label mid-turn; turn end clears it"; "send opens an unlabelled phase; tool_started resets back to it"; "resuming from a confirm restarts the phase clock unlabelled"; "error event surfaces and unlocks"; "queues a second confirm behind the first"; "answering the last queued confirm returns to busy"; the Allow-counting tests from "a card queued behind an allowed one counts it" to "an Allow that fails to post counts for no card behind it"; the answer tests from "the answered card stays until its answer is posted" to "a turn that ends while an answer is in flight leaves the next answerable"; "a reaped conversation drops the whole queue"; the picker tests "the server's default lands after the send", "the picker shows the model the server says the conversation runs", "a 404 whose re-create fails leaves the picker unlocked", "a conversation reaped under a card leaves the picker unlocked".
- [ ] **Move** each as plain `step` calls through the file's `run(events)` helper, asserting the same values. A moved test keeps its name unless the name describes the hook ("respondConfirm …"), in which case it is renamed after the behaviour ("an answer …").
- [ ] **Rename the rest after the behaviour** (e.g. "respondConfirm restores pending state on confirmTool failure" → "a failed confirm POST shows its error and keeps the card answerable").
- [ ] **Done:** web gates green; the moved tests pass in `chatMachine.test.ts` at the base, with `chatMachine.ts` untouched (`git diff --stat` shows only the two test files); web coverage holds.

### Task 6: The confirm answer lives on the card

**Implementer:** opus (the state replacing `answering`/`sentDecision`, and the property model re-point).

**Files:** `web/src/assistant/chatMachine.ts`, `chatMachine.test.ts`, `useAssistant.ts`, `useAssistant.test.tsx`, `AssistantPanel.tsx`, `AssistantPanel.test.tsx`; `web/src/props/assistant/run.ts`, `run.test.ts`, `teeth.prop.ts`, `assistant.prop.ts`, `model.ts` (header comment only, if a rule's wording moves).

**Interfaces** (`chatMachine.ts`):
- `export type ConfirmAnswer = { allow: boolean; state: "posting" | "failed" };`
- `PendingConfirm = { confirmId: ConfirmId; preview: WritePreview | null; answer: ConfirmAnswer | null; allowedAhead: number }`. `opsPreview` and `sentDecision` go; the comment on `answer` keeps why a failed answer may only be resent unchanged and why it lives on the card (a remounted card cannot forget it).
- `ChatState.answering` goes, from the type, `initialChat`, `endTurn`, `stop` and the 404 re-create.
- `export function canStop(s: ChatState): boolean`: `chatStatus(s) === "busy" || (s.confirms[0]?.answer ?? null) !== null`.
- `export function answerFailed(c: PendingConfirm): boolean`: `c.answer?.state === "failed"`.
- `step`:
  - `answer`: refused when the head's answer is `posting`, or is `failed` with the other `allow`; otherwise the head's answer becomes `{ allow, state: "posting" }` and the `confirm` effect runs, as today.
  - `confirmPosted`: as today, less `answering: false` (the head, and its answer, leave together).
  - `confirmFailed`, not a 404: the head's answer becomes `failed` only when the head is `e.confirmId` and its answer is `posting`; the error shows as today.
  - `send`: the `conversation.kind === "creating"` clause goes.
- `useAssistant` returns `canStop: canStop(chat)` in place of `answering`. `AssistantPanel` shows Stop when `assistant.canStop`; `ConfirmCard` loses its `answering` prop, disables both buttons while `pending.answer?.state === "posting"`, and offers only "Retry Allow" or "Retry Deny" when `answerFailed(pending)`, with `pending.answer.allow`.

- [ ] **Red** (`chatMachine.test.ts`): `an answer marks the head posting and posts it`; `a second answer while the head posts posts nothing`; `a failed post marks the head failed and keeps it at the head`; `after a failure only the same answer posts again`; `a posted answer removes the head`; `a confirmFailed for a card that is not the head marks nothing`; `canStop` as a table (idle: no; busy with no card: yes; a card waiting unanswered: no; answer posting: yes; answer failed: yes; stopping: yes); `answerFailed only for a failed answer`. Task 5's moved answer tests are re-pointed from `sentDecision`/`answering` to `answer`, keeping what they assert. `AssistantPanel.test.tsx` builds its fixtures with `answer` and `canStop`; "while answering both buttons are disabled and Stop shows" and the retry tests keep their assertions.
- [ ] **Implement.** TypeScript finds every reader; `teeth.prop.ts`'s two mutant states lose `answering: false`.
- [ ] **Property model.** In `run.ts`:
  - `View.confirms` becomes `readonly { confirmId: ConfirmId; answer: ConfirmAnswer | null }[]`, and `View` gains `stoppable: boolean` (`REAL.view` reads `canStop`).
  - `Req`'s `confirm` carries `allow`; `settleConfirm` reports that `allow` in `confirmPosted`, not always `true`.
  - The World keeps, per confirm id, the answer its requests imply: `posting` from the `confirm` effect until it settles, then `failed` for a failure that is not a 404, gone once posted or once the card leaves.
  - `confirm` (widened; header updated): the head card's `answer` equals the World's record for it, and a card not at the head has none; a `confirm` effect for a card whose record is `failed` carries that `allow`.
  - New `stoppable` (header line: Stop is offered while the busy turn has no card, or its head card's answer is posting or failed): `stoppable` equals `doc.busy !== null && (cards empty || record of the head is set)`, read against the model and the World, never the reducer.
  - Tally labels in `act`'s `answer` case, from the World's record: `answer while posting`, `answer repeated after a failure`, `answer changed after a failure`. Arbitraries are unchanged, so seeds still replay.
- [ ] **Reach.** The three labels go into `REACH` under the "No floor" list until measured (see Property gate below); no existing floor, `NUM_RUNS` or limit changes.
- [ ] **Teeth** (`teeth.prop.ts`), each through `mutate` or a view mutant, with its `catches`: `a failed answer can be changed` (`answer` posts the other `allow` after a failure; `confirm`); `a failed post leaves the card posting` (`confirmFailed` keeps `posting`; `confirm`, `stoppable`); `Stop is hidden once an answer failed` (view: `stoppable` false for a failed head; `stoppable`). Add a fixed scenario to `run.test.ts` for each new invariant (an answer fails, then the other answer: the real machine posts nothing; the first mutant is caught by `confirm`).
- [ ] **Done:** web gates green, including `props/assistant/run.test.ts`; `git grep -n "answering\|sentDecision\|opsPreview" -- web/src` finds nothing but the word in prose comments that mean the user (check each). The orchestrator runs `proptest/check.sh web --file assistant` with a few `PROPTEST_SEED` values: the clean property passes, each new mutant is caught, and each new label's rate is printed.

### Task 7: The chat driver takes its client

**Implementer:** sonnet. Starts after Task 6 merges (`useAssistant.ts`).

**Files:** create `web/src/assistant/chatDriver.ts` (`// pattern: Imperative Shell`) and `chatDriver.test.ts`; modify `useAssistant.ts`.

**Interfaces:**
- `export type ChatClient = { createConversation: typeof createConversation; streamMessage: typeof streamMessage; stopTurn: typeof stopTurn; deleteConversation: typeof deleteConversation; confirmTool: typeof confirmTool }`, from `import type` of `./client`.
- `export function createChatDriver(publish: (state: ChatState) => void, client: ChatClient): ChatDriver`, with `ChatDriver = { dispatch(e: ChatEvent): Promise<void>; turnEnded(turn: TurnId): Promise<void>; current(): ChatState }`. The body moves unchanged, calling `client.*`. `streamWithBusyRetry` takes the stream function as its first parameter. `STOP_ACK_TIMEOUT_MS` and the busy-retry constants move with it; `useAssistant.ts` re-exports `STOP_ACK_TIMEOUT_MS`, which its tests import.
- `useAssistant` builds the driver with `{ createConversation, streamMessage, stopTurn, deleteConversation, confirmTool }` from `./client`; `fetchModels` and `closeConversationBeacon` stay the hook's.

- [ ] **Pin** (`chatDriver.test.ts`, with fake client functions and no `vi.mock`): `newChat sends the DELETE only after the aborted stream settles`: a stream that ignores its abort signal and settles only when the test releases it; dispatch `send` (the fake create resolves and the stream opens), then `newChat`; `deleteConversation` is not called until the release, and is called once after it. It passes at the base wiring. Show once, without committing, that it fails when `run`'s `delete` case stops awaiting `before`; say so in the report.
- [ ] **Done:** web gates green; `useAssistant.test.tsx` passes unmodified apart from imports; `chatDriver.ts` imports no React and no value from `./client`.

### Task 8: Drop the unread wire fields

**Implementer:** opus (wire compatibility). Starts after Tasks 1, 4, 6 and 7 merge.

**Files:** `server/src/pkm/assistant/events.py`, `claude_engine.py`; `server/tests/fake_engine.py`, `test_claude_engine.py`, `test_assistant_events.py`, `test_fake_engine.py`; `web/src/assistant/sse.ts`, `sse.test.ts`, `chatMachine.test.ts`, `useAssistant.test.tsx`, `client.test.ts`, `web/src/props/assistant/run.ts`; regenerated `events.gen.ts`.

- [ ] **Pins on the old code, own commit, before any field goes:** in `sse.test.ts`, `a confirm_request without ops_preview still yields its card` and `a frame's unknown keys are kept, not refused` (a `tool_finished` with an extra key); in `chatMachine.test.ts`, `a tool_finished without a name marks its line`. They pass at the branch base: they are what an old bundle does with the new server.
- [ ] **Server:** `ConfirmRequest.ops_preview` and `ToolFinished.name` go; `can_use_tool` builds `ConfirmRequest(confirm_id=…, preview=preview)`; `_finished` drops its `name` variable and the `"tool"` fallback. `test_claude_engine.py`'s `ops_preview` assertions read `preview.summary`, and the one that compares the two goes; `ToolFinished(...)` constructions lose `name=`. `TurnDone.usage` stays (Question 1).
- [ ] **Regen.** Expected diff, only: in `events.gen.ts`, `confirm_request` loses `ops_preview` and `tool_finished` loses `name`.
- [ ] **Web:** `parseFrame` builds `confirm_request` from `confirm_id` and `preview` only. Test fixtures and `run.ts`'s `streamEvent` lose `ops_preview` and `name` (TypeScript's excess-property check finds each).
- [ ] **Done:** server gates and web gates green; the pins pass unmodified; `git grep -n "ops_preview\|opsPreview" -- server web` is empty; `git grep -n "ToolFinished(" -- server | grep "name="` is empty. The server turn property imports nothing removed.

### Task 9: Live smoke of one write approval (orchestrator)

Needs the machine's Claude CLI login, as W3's smoke did (model `haiku`); no key file and no production data are involved. Nothing touches port 8974.

- [ ] **Scratch server.** `SCRATCH` is a new directory under the session scratchpad. From the branch's `server/`: `uv run python -m pkm.server.setup --data-dir "$SCRATCH" --password <scratch password> --insecure-cookie --web-dist <abs path to the branch's web/dist>` (patch `config.json`'s `web_dist` to the absolute path if needed), then `uv run python -m pkm.server.run --data-dir "$SCRATCH" --port 8975 --host 127.0.0.1` in the background, logging to the scratchpad; note its PID. `--port` is also the URL the harness's MCP server calls, so writes land on 8975. Build the SPA first (`cd web && pnpm build`).
- [ ] **Wire check** (Playwright script in the scratchpad, or `curl -N` with a cookie jar): log in, create a conversation with `haiku`, send `Use save_note to add the text "w14 smoke <nonce>" to the page "W14 Smoke".` Read the raw frames. Pass: a `confirm_request` whose data keys are exactly `confirm_id` and `preview`; after Allow, a `tool_finished` without `name`; the stream ends with `turn_done`.
- [ ] **Card check** in the browser against the same server: the card shows; Allow arms only after both markers are seen; while the confirm POST is held (Playwright `route` delaying it), both buttons are disabled and Stop is offered. Then a second write with the first confirm POST aborted by `route`: the card offers only the retry of that same answer, Stop stays offered, and the retry lands. Then a third write answered Deny: its tool line shows declined.
- [ ] **Landed on the scratch server:** `GET /api/page/W14%20Smoke` on 8975 holds the smoke blocks, and the scratch server's log shows the write requests. Nothing else is checked against any other port.
- [ ] **Old bundle, new server:** build `main`'s bundle in a throwaway worktree (`git worktree add <scratchpad>/w14-old main`, with the `node_modules` symlink rule) and point the scratch `config.json`'s `web_dist` at it (the server reads `web_dist` per request). Repeat one approval: the card renders and the write lands.
- [ ] **Teardown:** stop the server by PID, remove the throwaway worktree with `git worktree remove`, delete `$SCRATCH`. `git status -sb` in the branch worktree is clean.
- [ ] **Pass** means every bullet above held; the orchestrator writes the result, with the frames' key lists, to the handoffs directory (not committed).

If the CLI login is not available, the nearest check is `pnpm verify`'s Playwright `assistant.spec.ts`, which drives the real card through `fake_engine.py` and the real `preview_write`, plus the Task 8 pins; say that the live smoke did not run.

### Task 10: Docs say what W14 made true

**Implementer:** opus. Invoke `architecture-docs`; verify each claim against the merged code.

**Files:** `docs/architecture/assistant.md`, `frontend.md`, `backend.md`; `docs/troubleshooting.md` (Question 2 only); the epic plan's W19 table.

- [ ] **assistant.md:** the module table's `preview_keys_dump.py` row becomes `wire_dump.py` (writes `previewKeys.gen.ts` and `events.gen.ts`); the `events.py` row says `EVENT_NAMES` feeds the web's union. In § The write approval card, the `_validate` row names `check_write`, and one sentence in § The blocks a write changes states the rule: `preview_write` validates its deep copy once, and the uids read, the card and Allow's input all come from that `CheckedWrite`. The paragraph on `sentDecision` says the head card's `answer` holds the posted answer and its state, and after a failure only that answer is sent again.
- [ ] **frontend.md § The assistant panel:** the `sse.ts` bullet says the union and `EVENT_TYPES` are generated (`events.gen.ts`), and states the tolerance rule with its reason: the parser keeps unknown keys and a server-defaulted field is optional, so an older bundle reads a newer server's stream; only the preview is checked strictly. **§ The chat machine:** Stop is offered per `canStop`; the hook's driver lives in `chatDriver.ts` and takes its client functions. Update the module tree if it lists the assistant files.
- [ ] **backend.md § Generated artifacts:** the `previewKeys.gen.ts` row becomes one row for `previewKeys.gen.ts` and `events.gen.ts`, test `test_assistant_wire_artifact.py`, pinning the preview keys as before and the web's event union to `events.py`'s dataclasses and `EVENT_NAMES`.
- [ ] **troubleshooting.md:** under Question 2's default, one row (symptom: the card for a batch update with a blank body and a missing uid says its text lands on the daily note, where only a "heading change skipped" note does; cause; owner § The write approval card; bean id).
- [ ] **Epic plan, W19 table:** the driver row names `chatDriver.ts` and `ChatClient`, and that timers are still global; the confirm-answer row says W14 re-pointed the existing suite, so nothing is left for W19 there.
- [ ] **Done:** `node .claude/skills/architecture-docs/check-docs.mjs` passes; `git grep -n "preview_keys_dump\|sentDecision\|opsPreview\|ops_preview\|all_tool_names" -- docs/architecture` is empty.

## Order and parallel lanes

```
Lane S (server preview):  T1 -> T2 -> T3
Lane C (contract):        T4
Lane W (web state):       T5 -> T6 -> T7
Join:                     T8   after T1, T4, T6, T7
Then:                     T9 (orchestrator), T10
```

Lanes S, C and W start together in separate worktrees. Within a lane, tasks are serial and rebase onto the branch before merging.

| File | Tasks | Rule |
|---|---|---|
| `write_preview.py`, `test_write_preview.py` | T1, T2 | Lane S only; T2 after T1 |
| `target_reader.py`, `test_target_reader.py` | T1 | |
| `test_fake_engine.py` | T1, T8 | T8 after T1 |
| `events.py`, `regen.py`, `wire_dump.py`, `events.gen.ts`, `sse.ts` | T4, T8 | T8 after T4; regenerate, never hand-merge a `.gen.ts` |
| `chatMachine.ts`, `AssistantPanel.tsx`, `props/assistant/*` | T6, T8 (`run.ts` fixtures) | T8 after T6 |
| `useAssistant.ts` | T6, T7 | T7 after T6 |
| `useAssistant.test.tsx`, `chatMachine.test.ts` | T5, T6, T7, T8 | in that order |
| `claude_engine.py`, `fake_engine.py`, `test_claude_engine.py` | T8 | |
| docs | T10 | last |

Other branches: W15 (`refactor/web-ui`, in progress) may edit `styles.css` rules the panel uses; W14 changes no CSS. W18 later moves backend.md sections; Task 10 edits only the generated-artifacts table there. W19 stays deferred.

## Property gate

- **Server** (`test_assistant_turn_props.py`): no model change while `TurnDone.usage` stays. Task 8 drops `ToolFinished.name`, which the model reads only through `isinstance`. Floors, budgets and the teeth test unchanged. Run as part of `proptest/check.sh server`.
- **Web** (`props/assistant/`): Task 6 widens `confirm`, adds `stoppable`, three labels and three mutants; arbitraries unchanged, so every existing seed replays. Reach: the orchestrator registers the new labels, then runs the suite unseeded with `PROPTEST_REACH_LOG` set by the recipe `with_floors`' docstring owns (the same run count the existing floors' comment names), on a quiet machine, and sets their floors from it, or lists a label under "No floor" with the reason the recipe gives. Existing floors move only if that run shows one is no longer met, and then by the same recipe, with the reason in the commit. Teeth: sweep a few `PROPTEST_SEED` values before trusting the new mutants (`confirm fails` is one of the suite's rarer outcomes).
- **If Question 1 goes the other way:** the server model needs a new witness that a turn's `TurnDone` is its own result before `usage` goes, a mutant that hands a turn the previous turn's result, and a re-measure of the label `user stop as the harness finished: the turn's own result`. That is Task 8 grown, and opus.

## Traps

- **Validation order.** Putting `check_write` inside the read's `try` turns `input could not be previewed` into `could not be read`. *Detect:* Task 1's first pin.
- **The length cut.** A validation refusal that skips `_bounded` can carry a multi-kilobyte echo of the model's input to the model and the logs. *Detect:* Task 1's second pin and `test_every_refusal_is_bounded`.
- **Two copies of the input.** `approved_input` built from anything but `checked.tool_input` lets Allow run a dict changed after the card was built. *Detect:* `test_approved_input_runs_the_checked_copy` and the two snapshot tests.
- **Generated optional fields.** The dump must mark exactly the defaulted fields optional; marking `confirm_id` optional would type-check a card the server can never answer. *Detect:* `test_a_defaulted_field_is_optional` and the committed artifact.
- **Hand-merged `.gen.ts`.** A conflict in `events.gen.ts` or `previewKeys.gen.ts` is resolved by regenerating. *Detect:* `test_assistant_wire_artifact.py`.
- **A head that is not the answered card.** `confirmFailed` must mark only a posting head with its own id; marking whatever card heads the queue would put a "Retry" on a card never answered. *Detect:* `a confirmFailed for a card that is not the head marks nothing`.
- **A model that reads the reducer.** The World's answer records come from the requests the effects started and how the run settled them, never from `PendingConfirm.answer`; one copied from the reducer passes vacuously. *Detect:* the three Task 6 mutants.
- **`vi.mock` after the move.** `chatDriver.ts` must take the client, not import it; an import would keep the hook tests green and leave W19 nothing to inject. *Detect:* Task 7's done grep.
- **The smoke's port.** A server started without `--port 8975` gets an MCP URL for 8974. *Detect:* the write shows in the scratch server's log, and the block is read back from 8975.

## Final gates

| Gate | Who |
|---|---|
| Server gates after every commit | each implementer |
| Web gates without Playwright | Tasks 4 to 8 |
| `uv run python -m pkm.regen` with the expected diff | Tasks 4 and 8; a no-diff check in Tasks 1 and 2 |
| `proptest/check.sh web --file assistant`, seeds swept; reach measured for the new labels | orchestrator, serially, after Task 6 merges |
| `cd server && uv run pytest -q`, `uv run pyrefly check`, `uv run ruff check` on the merged branch | orchestrator, after each merge |
| `cd web && pnpm verify` (Playwright included; `assistant.spec.ts` runs the card through `fake_engine.py`) | orchestrator, after Task 8 and on the final branch |
| `proptest/check.sh` both sides | orchestrator, serially, on the final branch |
| Live smoke (Task 9) | orchestrator, on the final branch |
| `node .claude/skills/architecture-docs/check-docs.mjs` | Task 10 |

`perf/check.sh` is not a W14 gate: W14 changes no query and no route outside `/api/assistant/`, and the epic lists no assistant path among its perf packages. Before merge the orchestrator confirms that no perf scenario reaches the assistant routes or the panel with `git grep -n -i "assistant" -- server/tooling/perfcheck web/tooling/perf ':!*/baselines/*'`, which should find nothing, and runs perf if it does.

## Questions for Arthur

1. **`TurnDone.usage`.** The web never reads it, but the server's turn property uses the result's `usage` tag as its only proof that a turn's `TurnDone` came from that turn's own result, and a W3 reach label depends on it. *Recommendation and default:* keep it; the generated union types it optional. Dropping it means building another witness into the property first (see Property gate).
2. **The missing-uid warning for a batch update with a blank body.** For a uid no block has, the server lands the text only when the body (the text less its heading hashes) is non-blank; the `set_heading` the planner always adds lands a "heading change skipped" note either way. The card says the text lands whatever the body. *Recommendation and default:* the new test pins every case and, for a blank body, the warning says a note lands, in the move's existing wording (one condition, one troubleshooting row). The alternative pins only the non-blank cases and files a bean.
3. **Optional generated fields.** *Recommendation and default:* a field with a server-side default is optional in the generated union, which states in the type that a bundle must cope with its absence; the alternative, every field required, makes the type claim more than an older or newer server guarantees.
4. **The driver's timers.** `createChatDriver` still reads `setTimeout` and `Date.now()` directly. *Recommendation and default:* leave them; W19's shell property decides between fake timers and an injected clock when it is written.
5. **The live smoke's model call.** It uses the machine's Claude login with `haiku`, as W3's smoke did, writing only to a scratch data directory on 8975. *Recommendation and default:* run it; if the login is unavailable, report that and rely on `assistant.spec.ts` and Task 8's pins.
