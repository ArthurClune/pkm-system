# Panel Shows Refused Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a write tool's call fails (a refused Allow: 412 "block ((U))
changed after the approval card showed it, so nothing was written"; a 404;
a decline; any tool error), the assistant panel marks that call's tool line
failed and shows the tool's own reason, whatever the model's reply says.

**Architecture:** The truth is the SDK's `ToolResultBlock.is_error`, which
the harness CLI sets from the MCP result; the model's text never reaches it.
`TurnMapper` already turns each `ToolResultBlock` into `ToolFinished`; it
now carries the call's `tool_use_id` and, for a write tool whose result has
`is_error`, the clipped reason. `ToolStarted` carries the same id, so the
web pairs a result with its own line instead of the first pending line of
that name. The web shows `✗` and a fixed `Failed:` label with the reason as
a plain text node under the tool line.

**Tech Stack:** Python (claude-agent-sdk types, dataclasses), React/TS,
vitest, Playwright with `server/tests/fake_engine.py`.

**Spec:** Arthur's ruling on `.beans/pkm-0214--assistant-panel-shows-a-refused-or-failed-write-it.md`
(2026-10-25): yes, the assistant panel itself shows when an allowed write
was refused, rather than relying on the model's reply.

## Current behaviour (read before Task 1)

- `claude_engine.TurnMapper.map` emits `ToolFinished(name)` for every
  `ToolResultBlock` and ignores `is_error`, so the panel shows `✓` beside a
  refused, failed or declined write.
- `ClaudeConversation.send` builds a fresh `TurnMapper` per turn, so a
  stopped turn's write whose result lands in the next turn maps to name
  `"tool"` (its `ToolUseBlock` was seen by the old mapper).
- `useAssistant.applyEvent("tool_finished")` marks the first not-done tool
  item with that name; two calls of one tool finishing out of order mark the
  wrong line.
- SSE events are not in `web/src/api/openapi.json` (the stream is parsed by
  `web/src/assistant/sse.ts`), so no openapi regen is needed unless a task
  changes a route, response model or route docstring.
- Conversations live in memory only (server) and in React state (web): a
  reload loses the transcript. There is nothing to persist beyond the tool
  line itself.

## Decisions

| Decision | Reason |
|---|---|
| Truth comes from `ToolResultBlock.is_error is True`, read in `TurnMapper`; the reason from that block's `content` | The CLI builds that block from the MCP server's `CallToolResult.isError`, which FastMCP sets when the tool raises. The model writes neither; its reply is exactly what a prompt-injected model could misreport |
| Only write tools (`classify_tool(full_name) == "write"`) carry `error`; read lines keep today's `✓` | The ruling is about writes. Reads fail routinely while the model probes (a gone uid, a missing title), change nothing in the notes, and the reply reports them; a reason line on each would be noise. The check is one condition beside the name lookup |
| Every write error shows, not only 412-after-Allow: other tool errors, a `Refusal` (no card was shown), and a decline if the CLI marks it `is_error` | Distinguishing them needs per-call state on the conversation and a second test path, for no safety gain; each is a write that did not do what the line's `✓` claimed. A declined write today shows `✓`, which this fixes |
| `ToolStarted` and `ToolFinished` carry `tool_use_id` (the SDK's `ToolUseBlock.id` / `ToolResultBlock.tool_use_id`); the web pairs by it | A notice under the wrong call misinforms the user about which write failed. Name-FIFO pairing does so whenever two calls of one tool finish out of order |
| `ClaudeConversation` owns the id-to-tool-name map and hands it to each turn's `TurnMapper`; a result pops its id | A stopped turn's allowed write can report in the next turn (assistant.md § The blocks a write changes). With a per-turn map its refusal would lose its name and its write classification, so the notice would be suppressed |
| Reason = text of the result (a `str`, or the `text` of each `{"type": "text"}` item joined by `\n`), a leading `Error executing tool <name>: ` (FastMCP's wrapper, `mcp.server.fastmcp.tools.base`) removed, stripped; empty is `no reason given`; over `TOOL_ERROR_LIMIT_CHARS = 300` code points cut to 300 + `… (N characters)` (the `Refusal` clip format) | The panel line must stay short. The reason can echo model-chosen input (`pkm.echo` quotes it), so it is clipped server-side before it reaches the SSE stream |
| The web renders: the line's glyph `✗` (instead of `✓`/`…`), then a child `div.assistant-tool-failed` holding the fixed text `Failed: ` and the reason in `<bdi dir="ltr">` as a React text node | Fixed label, so the model cannot word it. React escapes text, and the reason never goes through `tokenizeBlock`/`InlineSegments`, so `((uid))` stays literal (no block-ref fetch or link) and markup stays text. `white-space` stays at its default so newlines in the reason collapse and cannot draw a second, fake line; `overflow-wrap: anywhere` wraps long tokens |
| Persistence: the notice lives on the tool `ChatItem` (`error: string \| null`) | It lasts exactly as long as the line it annotates: through later turns of the chat, gone on New chat or reload, like every transcript item. The server holds no history to restore |
| A `tool_finished` whose id matches no line is ignored, as an unmatched name is today | Only possible for a result of a conversation the web no longer shows |

## Global Constraints

- Worktree: `/Users/arthur/code/llm/pkm/.claude/worktrees/0214` (branch
  `security/0214`). Run every command from it; `pwd` first. Never touch
  `/Users/arthur/code/llm/pkm` directly.
- Ports: scratch server 9037; `E2E_PORT=8990`. 8974 is production: never
  bind it.
- No new runtime files are planned; any that appear carry a
  `# pattern: Functional Core` / `// pattern: Imperative Shell` header.
  `events.py` stays Functional Core.
- Comments ≤ 80 columns, other lines ≤ 120; no bean ids, line numbers or
  non-path spec pointers in code, tests or `docs/architecture/`.
- Names: `ToolStarted(tool_use_id: str, name: str, summary: str)`,
  `ToolFinished(tool_use_id: str, name: str, error: str | None = None)`,
  `TOOL_ERROR_LIMIT_CHARS = 300`, `tool_error_reason(content: str |
  list[dict[str, Any]] | None) -> str` (all in `pkm/assistant/events.py`);
  web `ChatItem` tool variant `{ kind: "tool"; toolUseId: string; name:
  string; summary: string; done: boolean; error: string | null }`; CSS class
  `assistant-tool-failed`; label text `Failed: `.
- Server gates (from `server/`): `uv run pytest -q`, `uv run pyrefly check`,
  `uv run ruff check`; from the worktree root:
  `PYTHONPATH=server/tooling python3 -m commentlint.run --all`.
- Web gate: `cd web && set -o pipefail && E2E_PORT=8990 pnpm verify`.
- openapi: regenerate per [backend.md § Generated artifacts](../../architecture/backend.md#generated-artifacts-and-parity-fixtures)
  only if a route, response model or route docstring changes (none is
  planned).
- Docs through the `architecture-docs` skill, plus one
  `docs/troubleshooting.md` row.
- Commits name paths explicitly (`git add <paths>`), never stage
  `.beans/`, carry no session URL, and end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Before merge: `perf/check.sh` (serial, quiet machine). No proptest gate:
  nothing here touches sync, ops, planning or undo.

## Review Focus

1. **Suppression by the model.** No path sets `ToolFinished.error` from
   anything but a `ToolResultBlock`; a stopped turn's write still reports
   its error in the next turn (Task 1's cross-turn test); the web pairs by
   `tool_use_id` across turns (Task 3).
2. **Spoofing by the model's text.** A reply (`.assistant-msg`, pre-wrap)
   or a read tool's summary (it quotes the model's query) can contain `✗`
   or `Failed:`, but cannot produce `.assistant-tool-failed` or flip a write
   line's glyph. Check the notice is reachable only from `item.error`.
3. **XSS / markup via the reason.** The reason is a React text node inside
   `<bdi>`, never `dangerouslySetInnerHTML`, `tokenizeBlock` or
   `InlineSegments`; `<img onerror>` and `((uid))` render literally (Task 3
   test).
4. **Misattachment.** Two calls of one tool finishing out of order mark
   each its own line (Task 3 test).
5. **Huge or odd reasons.** A multi-MB or multi-line or RTL reason: clipped
   server-side (Task 1 test), newlines collapse in the panel, `dir="ltr"`
   `<bdi>` keeps an RTL lead from reversing the label.

---

### Task 1: Server events carry the call id and a write's error

**Model:** sonnet

**Files:**
- Modify: `server/src/pkm/assistant/events.py`
- Modify: `server/src/pkm/assistant/claude_engine.py` (`TurnMapper`,
  `ClaudeConversation.__init__`, `ClaudeConversation.send`)
- Modify: `server/tests/fake_engine.py` (ids only, so the suite runs)
- Test: `server/tests/test_assistant_events.py`,
  `server/tests/test_claude_engine.py`, `server/tests/test_fake_engine.py`
  (update existing `ToolStarted(...)`/`ToolFinished(...)` constructions)

**Interfaces:**
- Produces: the names in Global Constraints;
  `TurnMapper.__init__(self, tools: dict[str, str] | None = None)` where
  `tools` maps `tool_use_id` to the tool's full SDK name and is shared with
  the caller; fake engine ids `fake-tool-<n>` (per conversation counter).

- [ ] **Step 1: Write the failing tests**

In `test_assistant_events.py`:

```python
def test_tool_error_reason_reads_text_items_and_drops_fastmcp_prefix():
    content = [{"type": "text", "text": "Error executing tool update_block: "
                "block ((AbC)) changed after the approval card showed it, "
                "so nothing was written"},
               {"type": "image", "data": "x"}]
    assert tool_error_reason(content) == (
        "block ((AbC)) changed after the approval card showed it, "
        "so nothing was written")
    assert tool_error_reason("plain reason") == "plain reason"
    assert tool_error_reason("a: Error executing tool x: b") == (
        "a: Error executing tool x: b")  # prefix only at the start
    assert tool_error_reason([{"type": "text", "text": "a"},
                              {"type": "text", "text": "b"}]) == "a\nb"

def test_tool_error_reason_empty_and_clipped():
    assert tool_error_reason(None) == "no reason given"
    assert tool_error_reason("  ") == "no reason given"
    assert tool_error_reason("x" * 300) == "x" * 300
    assert tool_error_reason("x" * 1301) == "x" * 300 + "… (1,301 characters)"

def test_tool_finished_encodes_its_error():
    frame = encode_sse(ToolFinished(tool_use_id="t1", name="update_block",
                                    error="nope"))
    assert '"tool_use_id": "t1"' in frame and '"error": "nope"' in frame
    assert '"error": null' in encode_sse(
        ToolFinished(tool_use_id="t1", name="search"))
```

In `test_claude_engine.py` (beside `test_turn_mapper_emits_tool_finished_from_tool_result`,
which is updated to the new fields):

```python
_REFUSED = ("Error executing tool update_block: block ((AAAAAAAA)) changed "
            "after the approval card showed it, so nothing was written")

def test_turn_mapper_carries_a_write_tools_error():
    mapper = TurnMapper()
    mapper.map(AssistantMessage(content=[ToolUseBlock(
        id="t1", name=_UPDATE, input={"uid": "AAAAAAAA", "text": "t"})],
        model="sonnet"))
    refused = UserMessage(content=[ToolResultBlock(
        tool_use_id="t1", content=[{"type": "text", "text": _REFUSED}],
        is_error=True)])
    assert mapper.map(refused) == [ToolFinished(
        tool_use_id="t1", name="update_block",
        error=_REFUSED.removeprefix("Error executing tool update_block: "))]

def test_turn_mapper_ignores_read_errors_and_write_successes():
    # search with is_error=True -> error None; update_block with
    # is_error None and False -> error None

def test_turn_mappers_sharing_a_map_carry_a_write_across_turns():
    tools: dict[str, str] = {}
    TurnMapper(tools).map(<AssistantMessage with ToolUseBlock t1 _UPDATE>)
    assert TurnMapper(tools).map(<refused result for t1>) == [ToolFinished(
        tool_use_id="t1", name="update_block", error=<reason>)]
    assert tools == {}  # the result popped its id
```

And one conversation-level test, modelled on
`test_a_stopped_turns_running_write_stamps_the_next_turns_cards`:
`test_a_stopped_turns_refused_write_shows_its_error_next_turn` — turn one
is fed `AssistantMessage([ToolUseBlock(id="t1", name=_UPDATE, ...)])`, the
test awaits its `ToolStarted`, then `aclose()`s the stream (Stop); turn two
(`conv.send("two")`) is fed the refused `ToolResultBlock` for `t1`, then
`make_result()`; assert the turn yields
`ToolFinished(tool_use_id="t1", name="update_block", error=<reason>)`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && uv run pytest -q tests/test_assistant_events.py tests/test_claude_engine.py -k "tool_error or turn_mapper or refused_write"`
Expected: FAIL (`tool_error_reason` not defined; unexpected keyword
`tool_use_id`).

- [ ] **Step 3: Implement**

- `events.py`: add `tool_use_id` first on `ToolStarted` and `ToolFinished`,
  `error: str | None = None` last on `ToolFinished`; add
  `TOOL_ERROR_LIMIT_CHARS` and `tool_error_reason` per the Decisions row
  (prefix match `re.compile(r"Error executing tool \w+: ")` at position 0).
- `claude_engine.py`: `TurnMapper` stores `block.name` under `block.id` in
  `tools` on each `ToolUseBlock`; on each `ToolResultBlock` it pops the id
  (absent: name `"tool"`, not a write), and sets
  `error=tool_error_reason(block.content)` only when `block.is_error is
  True` and `classify_tool(full_name) == "write"`. `ClaudeConversation`
  holds `self._tool_names: dict[str, str] = {}` and `send` builds
  `TurnMapper(self._tool_names)`.
- `fake_engine.py`: a per-conversation counter minting `fake-tool-<n>`;
  each `ToolStarted` and its `ToolFinished` share the id.

- [ ] **Step 4: Run the server gates**

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`, then `PYTHONPATH=server/tooling python3 -m commentlint.run --all` from the root.
Expected: all pass, coverage gate included.

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/assistant/events.py server/src/pkm/assistant/claude_engine.py \
  server/tests/fake_engine.py server/tests/test_assistant_events.py \
  server/tests/test_claude_engine.py server/tests/test_fake_engine.py
git commit -m "assistant: tool events carry the call id and a write's error"
```

### Task 2: The fake engine reports a refused Allow, and can misreport it

**Model:** sonnet

**Files:**
- Modify: `server/tests/fake_engine.py` (`_update`, `send`, module
  docstring)
- Test: `server/tests/test_fake_engine.py`

**Interfaces:**
- Consumes: `tool_error_reason`, `ToolFinished` from Task 1.
- Produces: trigger `please misreport update <uid>` — the `please update`
  flow, except its reply is `Updated.` whatever the tool did (the e2e's
  lying model). `please update` keeps its honest `Not updated: <error>`.

- [ ] **Step 1: Write the failing tests**

In `test_fake_engine.py`, extend `test_please_update_runs_the_tool_on_allow`
(the `raising` runner): the `ToolFinished` for `update_block` carries
`error == "boom"`; the success case carries `error is None`. Add:

```python
def test_misreport_update_says_updated_but_carries_the_error():
    def raising(short, tool_input):
        raise RuntimeError("block ((x)) changed after the approval card "
                           "showed it, so nothing was written")
    events = _update_turn_running(f"please misreport update {_VICTIM}", raising)
    finished = [e for e in events if isinstance(e, ToolFinished)]
    assert [e.error for e in finished] == [
        "block ((x)) changed after the approval card showed it, "
        "so nothing was written"]
    assert [e.text for e in events if isinstance(e, TextDelta)] == ["Updated."]
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && uv run pytest -q tests/test_fake_engine.py`
Expected: FAIL (error is None; the misreport trigger echoes).

- [ ] **Step 3: Implement**

`_update(text, trigger, misreport: bool)`: on a failed run, `ToolFinished`
gets `error=tool_error_reason(f"Error executing tool update_block: {exc}")`
(the wrapper FastMCP puts on a raised tool error, so the double's reason
goes through the same function as the real one). `send` checks
`"please misreport update"` before `"please update"`. Document the trigger
in the docstring.

- [ ] **Step 4: Run the server gates** (as Task 1 Step 4). Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add server/tests/fake_engine.py server/tests/test_fake_engine.py
git commit -m "tests: fake engine carries a refused write's error"
```

### Task 3: The panel marks a failed write's line and shows its reason

**Model:** sonnet

**Files:**
- Modify: `web/src/assistant/sse.ts` (event types)
- Modify: `web/src/assistant/useAssistant.ts` (`ChatItem`, `applyEvent`)
- Modify: `web/src/assistant/AssistantPanel.tsx` (tool line)
- Modify: `web/src/styles.css` (beside `.assistant-tool-line`)
- Test: `web/src/assistant/sse.test.ts`,
  `web/src/assistant/useAssistant.test.tsx`,
  `web/src/assistant/AssistantPanel.test.tsx`

**Interfaces:**
- Consumes: SSE `tool_started {tool_use_id, name, summary}` and
  `tool_finished {tool_use_id, name, error: string | null}` from Task 1.
- Produces: the `ChatItem` tool variant in Global Constraints.

- [ ] **Step 1: Write the failing tests**

- `sse.test.ts`: a `tool_finished` frame with `"tool_use_id": "t1"` and
  `"error": "nope"` parses to `{ type: "tool_finished", tool_use_id: "t1",
  name: "update_block", error: "nope" }`; the existing `tool_started` case
  gains `tool_use_id`.
- `useAssistant.test.tsx`: replace "tool_finished marks only the first
  pending tool item with that name" with
  `"tool_finished marks the line with its own id, carrying its error"`:
  started `t1` and `t2` (both `update_block`), finished `t2` with
  `error: "nope"` → items `t1` `{done: false, error: null}`, `t2`
  `{done: true, error: "nope"}`. Add
  `"a later turn's tool_finished marks an earlier turn's line"`: send one
  feeds `tool_started t1` and ends; send two feeds
  `tool_finished t1 error "nope"` and `turn_done` → the first turn's line
  is done with `error: "nope"`. Update other literal tool items to the new
  shape.
- `AssistantPanel.test.tsx`:

```tsx
test("a failed write's line shows ✗ and its reason as text", () => {
  state.current.items = [
    { kind: "tool", toolUseId: "t1", name: "update_block",
      summary: "update_block", done: true,
      error: 'block ((AbCdEfGh)) changed <img src=x onerror="alert(1)">' },
    { kind: "tool", toolUseId: "t2", name: "update_block",
      summary: "update_block", done: true, error: null },
  ];
  const { container } = render(<AssistantPanel open onClose={() => {}} />);
  const failed = container.querySelectorAll(".assistant-tool-failed");
  expect(failed).toHaveLength(1);
  expect(failed[0].textContent).toBe(
    'Failed: block ((AbCdEfGh)) changed <img src=x onerror="alert(1)">');
  expect(failed[0].querySelector("bdi")?.getAttribute("dir")).toBe("ltr");
  expect(container.querySelector(".assistant-messages img")).toBeNull();
  const lines = container.querySelectorAll(".assistant-tool-line");
  expect(lines[0].textContent).toMatch(/^✗ update_block/);
  expect(lines[1].textContent).toMatch(/^✓ update_block/);
});
```

  (Also assert no block-ref element rendered for `((AbCdEfGh))`, using the
  selector the existing panel tests use for refs.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && pnpm test:unit src/assistant`
Expected: FAIL (no `.assistant-tool-failed`; items lack `toolUseId`).

- [ ] **Step 3: Implement**

- `sse.ts`: add `tool_use_id: string` to both events and
  `error: string | null` to `tool_finished`.
- `useAssistant.ts`: `tool_started` pushes `toolUseId: ev.tool_use_id,
  error: null`; `tool_finished` finds the tool item with that `toolUseId`
  (done or not, any turn) and sets `done: true, error: ev.error ?? null`.
- `AssistantPanel.tsx`: glyph `item.error !== null ? "✗" : item.done ? "✓"
  : "…"`; when `item.error !== null`, a child
  `<div className="assistant-tool-failed">Failed: <bdi dir="ltr">{item.error}</bdi></div>`.
- `styles.css`: `.assistant-tool-failed { color: var(--color-error);
  font-style: normal; overflow-wrap: anywhere; }` (no `white-space`
  override).

- [ ] **Step 4: Run the web gate**

Run: `cd web && set -o pipefail && E2E_PORT=8990 pnpm verify`
Expected: exit 0 (typecheck, eslint brand rules, lint:comments,
check:fcis, unit coverage, Playwright).

- [ ] **Step 5: Commit**

```bash
git add web/src/assistant/sse.ts web/src/assistant/sse.test.ts \
  web/src/assistant/useAssistant.ts web/src/assistant/useAssistant.test.tsx \
  web/src/assistant/AssistantPanel.tsx web/src/assistant/AssistantPanel.test.tsx \
  web/src/styles.css
git commit -m "assistant panel: a failed write's line shows its reason"
```

### Task 4: E2E of a refused Allow against a lying reply, and the docs

**Model:** sonnet

**Files:**
- Modify: `web/e2e/assistant.spec.ts`
- Modify: `docs/architecture/assistant.md`, `docs/architecture/frontend.md`,
  `docs/troubleshooting.md`

**Interfaces:**
- Consumes: the `please misreport update` trigger (Task 2), the panel
  markup (Task 3), `openBesideBlock` and `waitForServerText` in the spec.

- [ ] **Step 1: Write the failing e2e**

```ts
test("the panel shows a refused Allow whatever the reply says", async ({ page }) => {
  const stamp = Date.now();
  const title = `ApprovalShown${stamp}`;
  const panel = await openBesideBlock(page, title, `as${stamp}`);
  await askInput(panel).fill(`please misreport update as${stamp}`);
  await askInput(panel).press("Enter");
  await expect(confirmCard(panel).locator(".assistant-confirm-action"))
    .toHaveText("update block");
  // edit the block with real keypresses while the card waits, exactly as
  // "Allow refuses an update to a block edited after the card showed it"
  ...
  await panel.getByRole("button", { name: "Allow" }).click();
  await expect(panel.locator(".assistant-msg-assistant")).toHaveText("Updated.");
  // the fake engine's summary for an update
  const line = panel.locator(".assistant-tool-line", { hasText: "updating a block" });
  await expect(line).toContainText("✗");
  await expect(line.locator(".assistant-tool-failed"))
    .toContainText("Failed: ");
  await expect(line.locator(".assistant-tool-failed"))
    .toContainText(/changed after the approval card showed it/);
  await expect.poll(() => serverPageTexts(page, title)).not.toContain("Replaced.");
});
```

Fix the existing refused test, whose `getByText(/changed after …/)` now
matches the reply and the notice: scope it to `.assistant-msg-assistant`.
In "Allow applies an update to an unchanged block", assert the line shows
`✓` and `.assistant-tool-failed` has count 0.

- [ ] **Step 2: Red-check**

Build at the Task 3 commit with the new spec but with Task 3's
`AssistantPanel.tsx` change reverted locally (keep the tests; confirm
`pnpm build` exits 0), run
`cd web && E2E_PORT=8990 node tooling/runPlaywright.mjs e2e/assistant.spec.ts -g "whatever the reply"`;
expected FAIL on `.assistant-tool-failed`. Restore the file.

- [ ] **Step 3: Docs (invoke the `architecture-docs` skill)**

- `assistant.md`: the `events.py` table row names `tool_error_reason`. Under
  § The write approval card, a short `### A write's result` table: the
  notice's truth is `ToolResultBlock.is_error` (reason: the model's reply
  could misreport it); write tools only (reason as in Decisions); pairing
  by `tool_use_id` and the conversation-owned map (reason: a stopped turn's
  write reports next turn); reason clipped at `TOOL_ERROR_LIMIT_CHARS`
  server-side and rendered as text. Replace "The model relays the tool's
  error" in the refusal paragraph with the panel marking the call failed
  with the tool's reason, the model relaying it too.
- `frontend.md` § The assistant panel: one bullet — tool lines pair with
  results by `tool_use_id`, across turns; a failed write's
  `.assistant-tool-failed` is a text node, never `tokenizeBlock`.
- `docs/troubleshooting.md`: one row — Symptom: an allowed assistant write
  was refused ("…changed after the approval card showed it, so nothing was
  written") yet its tool line showed `✓`, and only the model's reply said
  so | Cause: `TurnMapper` dropped the result's `is_error`; a write's
  `ToolFinished` now carries the reason and the line shows
  `.assistant-tool-failed` | Where: assistant.md § A write's result | Ref:
  pkm-0214.

- [ ] **Step 4: Run all gates**

Server gates (Task 1 Step 4), then
`cd web && set -o pipefail && E2E_PORT=8990 pnpm verify`. Expected: pass.
Then, before merge, `perf/check.sh` on a quiet machine; record its table.

- [ ] **Step 5: Commit**

```bash
git add web/e2e/assistant.spec.ts
git commit -m "e2e: the panel shows a refused Allow whatever the reply says"
git add docs/architecture/assistant.md docs/architecture/frontend.md docs/troubleshooting.md
git commit -m "docs: the panel shows a write's error from the tool result (added)"
```

## Orchestrator rulings (2026-10-25)

- A write the user declined on the card is not a failure: if its tool result arrives with `is_error`, the line shows a neutral "Declined" (no ✗, no reason), because the server knows it answered the card with a deny. Only writes that were allowed (or ran without a card) and then errored show ✗ and "Failed: <reason>". Task 1 records the deny per tool_use_id; Task 3 renders it.
- Read-tool errors stay unmarked, per the ruling's scope.
