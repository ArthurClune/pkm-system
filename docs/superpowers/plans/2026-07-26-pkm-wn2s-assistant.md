# Embedded LLM Assistant (pkm-wn2s) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server-side LLM assistant (Claude Agent SDK harness confined to the pkm-mcp tool surface) streamed over SSE to a floating chat panel in the web app, with confirm-gated writes.

**Architecture:** New `server/src/pkm/assistant/` package: Functional Core (`events.py`, `policy.py`, `engine.py` protocols) + Imperative Shell (`claude_engine.py` SDK adapter, `service.py` registry, `routes.py` SSE endpoints). Web: new `web/src/assistant/` feature dir (SSE parser core, fetch client, `useAssistant` hook, `AssistantPanel`), wired into `App.tsx` (Cmd/Ctrl+J + sidebar entry). Tests run against a scripted `FakeEngine`; no real LLM in CI.

**Tech Stack:** FastAPI `StreamingResponse` SSE (first in app), `claude-agent-sdk` (new dep, drives the `claude` CLI Max login), existing pkm-mcp stdio server, React + plain CSS tokens, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-26-pkm-wn2s-assistant-design.md`. **Bean:** pkm-wn2s.

## Global Constraints

- Python ≥3.12; server tests enforce **95% branch coverage** (`--cov-fail-under=95`) on every `uv run pytest` — all new server code needs tests.
- Web coverage thresholds (fail `pnpm test:coverage`): statements 95 / branches 91 / functions 89 / lines 95.
- Every runtime file declares `# pattern: Functional Core` / `# pattern: Imperative Shell` (Python line 1, TS `//` header). Web headers are ENFORCED by `web/tooling/fcis.mjs`; Python is convention.
- Any server route change ⇒ regenerate `web/src/api/openapi.json` + `web/src/api/types.d.ts` (Task 6) or `test_committed_openapi_matches_live_schema` fails.
- New GET routes returning JSON must declare `response_model=`; SSE/204 responses are exempt from that rule but not from the openapi diff.
- Models allowlist: `sonnet` (default) | `opus` | `haiku` — CLI aliases, validated server-side.
- The ten MCP tools: read = `get_page get_block search query backlinks todos`; write (confirm-gated) = `save_note update_block batch upload_asset`. Namespaced form: `mcp__pkm__<name>`.
- Do NOT bind port 8974 in dev/tests (prod launchd service owns it).
- Commit messages: `pkm-wn2s: <what>`; include bean file changes with code commits.
- Run all server commands from `server/` with `uv run`, web from `web/` with `pnpm`.

---

### Task 1: Server dependency + `events.py` (event union + SSE encoding)

**Files:**
- Modify: `server/pyproject.toml` (via `uv add`)
- Create: `server/src/pkm/assistant/__init__.py` (empty)
- Create: `server/src/pkm/assistant/events.py`
- Test: `server/tests/test_assistant_events.py`

**Interfaces:**
- Produces: dataclasses `TextDelta(text)`, `ToolStarted(name, summary)`, `ToolFinished(name)`, `ConfirmRequest(tool_use_id, ops_preview)`, `TurnDone(usage: dict | None)`, `ErrorEvent(message)`; union alias `AssistantEvent`; `event_name(ev) -> str`; `encode_sse(ev) -> str`. All later server tasks consume these.

- [ ] **Step 1: Add the SDK dependency**

```bash
cd server && uv add claude-agent-sdk
```

Expected: `claude-agent-sdk` appears under `[project] dependencies` in `server/pyproject.toml` and `uv.lock` updates. (Used in Task 7; added now so one commit owns the lockfile churn.)

- [ ] **Step 2: Write the failing test**

`server/tests/test_assistant_events.py`:

```python
import json

from pkm.assistant.events import (
    ConfirmRequest,
    ErrorEvent,
    TextDelta,
    ToolFinished,
    ToolStarted,
    TurnDone,
    encode_sse,
    event_name,
)


def test_event_names():
    assert event_name(TextDelta(text="hi")) == "text_delta"
    assert event_name(ToolStarted(name="search", summary='searching "x"')) == "tool_started"
    assert event_name(ToolFinished(name="search")) == "tool_finished"
    assert event_name(ConfirmRequest(tool_use_id="c1", ops_preview="Create note")) == "confirm_request"
    assert event_name(TurnDone(usage=None)) == "turn_done"
    assert event_name(ErrorEvent(message="boom")) == "error"


def test_encode_sse_shape():
    out = encode_sse(TextDelta(text="hello"))
    assert out == 'event: text_delta\ndata: {"text": "hello"}\n\n'


def test_encode_sse_escapes_newlines():
    # SSE data must stay on one line; json escapes \n
    out = encode_sse(TextDelta(text="a\nb"))
    lines = out.split("\n")
    assert lines[0] == "event: text_delta"
    assert json.loads(lines[1][len("data: "):]) == {"text": "a\nb"}
    assert out.endswith("\n\n")


def test_turn_done_usage_serialized():
    out = encode_sse(TurnDone(usage={"input_tokens": 3}))
    assert json.loads(out.split("\n")[1][len("data: "):]) == {"usage": {"input_tokens": 3}}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_assistant_events.py -q --no-cov`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.assistant'`

- [ ] **Step 4: Write the implementation**

Create empty `server/src/pkm/assistant/__init__.py`, then `server/src/pkm/assistant/events.py`:

```python
# pattern: Functional Core
"""Assistant event union and SSE encoding.

Routes and the web UI speak only these events; nothing engine-specific
leaks upward (see the pkm-wn2s design spec).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ToolStarted:
    name: str
    summary: str


@dataclass(frozen=True)
class ToolFinished:
    name: str


@dataclass(frozen=True)
class ConfirmRequest:
    tool_use_id: str
    ops_preview: str


@dataclass(frozen=True)
class TurnDone:
    usage: dict | None = None


@dataclass(frozen=True)
class ErrorEvent:
    message: str


AssistantEvent = TextDelta | ToolStarted | ToolFinished | ConfirmRequest | TurnDone | ErrorEvent

_EVENT_NAMES: dict[type, str] = {
    TextDelta: "text_delta",
    ToolStarted: "tool_started",
    ToolFinished: "tool_finished",
    ConfirmRequest: "confirm_request",
    TurnDone: "turn_done",
    ErrorEvent: "error",
}


def event_name(event: AssistantEvent) -> str:
    return _EVENT_NAMES[type(event)]


def encode_sse(event: AssistantEvent) -> str:
    data = json.dumps(asdict(event), ensure_ascii=False)
    return f"event: {event_name(event)}\ndata: {data}\n\n"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_assistant_events.py -q --no-cov`
Expected: 4 passed

- [ ] **Step 6: Commit**

```bash
git add server/pyproject.toml server/uv.lock server/src/pkm/assistant/ server/tests/test_assistant_events.py
git commit -m "pkm-wn2s: assistant event union + SSE encoding; add claude-agent-sdk dep"
```

### Task 2: `policy.py` (tool gate, models, previews, system prompt)

**Files:**
- Create: `server/src/pkm/assistant/policy.py`
- Test: `server/tests/test_assistant_policy.py`

**Interfaces:**
- Produces: `MCP_SERVER_NAME = "pkm"`, `READ_TOOLS`, `WRITE_TOOLS` (tuples of short names), `mcp_tool_name(short) -> str`, `all_tool_names() -> list[str]`, `read_tool_names() -> list[str]`, `classify_tool(full_name) -> Literal["read", "write", "unknown"]`, `MODELS = ("sonnet", "opus", "haiku")`, `DEFAULT_MODEL = "sonnet"`, `resolve_model(name: str | None) -> str` (raises `ValueError`), `short_tool_name(full_name) -> str`, `tool_summary(short, tool_input) -> str`, `ops_preview(short, tool_input) -> str`, `SYSTEM_PROMPT: str`.
- Consumed by Tasks 4, 5, 7.

- [ ] **Step 1: Write the failing test**

`server/tests/test_assistant_policy.py`:

```python
import pytest

from pkm.assistant.policy import (
    DEFAULT_MODEL,
    SYSTEM_PROMPT,
    all_tool_names,
    classify_tool,
    mcp_tool_name,
    ops_preview,
    read_tool_names,
    resolve_model,
    short_tool_name,
    tool_summary,
)


def test_tool_names_namespaced():
    assert mcp_tool_name("search") == "mcp__pkm__search"
    assert "mcp__pkm__save_note" in all_tool_names()
    assert set(read_tool_names()) == {
        "mcp__pkm__get_page", "mcp__pkm__get_block", "mcp__pkm__search",
        "mcp__pkm__query", "mcp__pkm__backlinks", "mcp__pkm__todos",
    }
    assert len(all_tool_names()) == 10


def test_classify_tool():
    assert classify_tool("mcp__pkm__search") == "read"
    assert classify_tool("mcp__pkm__batch") == "write"
    assert classify_tool("Bash") == "unknown"
    assert classify_tool("mcp__other__search") == "unknown"
    assert classify_tool("mcp__pkm__made_up") == "unknown"


def test_short_tool_name():
    assert short_tool_name("mcp__pkm__get_page") == "get_page"
    assert short_tool_name("Bash") == "Bash"


def test_resolve_model():
    assert resolve_model(None) == DEFAULT_MODEL == "sonnet"
    assert resolve_model("opus") == "opus"
    assert resolve_model("haiku") == "haiku"
    with pytest.raises(ValueError):
        resolve_model("gpt-4o")
    with pytest.raises(ValueError):
        resolve_model("")


def test_tool_summary():
    assert tool_summary("search", {"q": "quarterly review"}) == 'searching "quarterly review"'
    assert tool_summary("get_page", {"title": "Projects"}) == 'reading page "Projects"'
    assert tool_summary("backlinks", {"title": "Alice"}) == 'backlinks for "Alice"'
    assert tool_summary("todos", {}) == "listing TODOs"
    # unknown keys fall back to the verb name
    assert tool_summary("get_block", {}) == "get_block"


def test_ops_preview_save_note():
    out = ops_preview("save_note", {"title": "Demo", "content": "hello world"})
    assert "save_note" in out and "Demo" in out


def test_ops_preview_batch_lists_ops():
    out = ops_preview("batch", {"ops": [{"op": "move", "uid": "abc123"}, {"op": "delete", "uid": "def456"}]})
    assert "2 operation" in out
    assert "abc123" in out and "def456" in out


def test_ops_preview_truncates_long_values():
    out = ops_preview("update_block", {"uid": "abc123", "text": "x" * 500})
    assert len(out) < 400


def test_system_prompt_mentions_tools_and_confirm():
    assert "search" in SYSTEM_PROMPT
    assert "backlinks" in SYSTEM_PROMPT
    assert "confirm" in SYSTEM_PROMPT.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_assistant_policy.py -q --no-cov`
Expected: FAIL — `ModuleNotFoundError` / `ImportError`

- [ ] **Step 3: Write the implementation**

`server/src/pkm/assistant/policy.py`:

```python
# pattern: Functional Core
"""Tool-gate policy, model allowlist, previews, and the system prompt."""

from __future__ import annotations

import json
from typing import Literal

MCP_SERVER_NAME = "pkm"

READ_TOOLS: tuple[str, ...] = ("get_page", "get_block", "search", "query", "backlinks", "todos")
WRITE_TOOLS: tuple[str, ...] = ("save_note", "update_block", "batch", "upload_asset")

MODELS: tuple[str, ...] = ("sonnet", "opus", "haiku")
DEFAULT_MODEL = "sonnet"

_MAX_VALUE_CHARS = 120


def mcp_tool_name(short: str) -> str:
    return f"mcp__{MCP_SERVER_NAME}__{short}"


def read_tool_names() -> list[str]:
    return [mcp_tool_name(t) for t in READ_TOOLS]


def all_tool_names() -> list[str]:
    return [mcp_tool_name(t) for t in READ_TOOLS + WRITE_TOOLS]


def short_tool_name(full_name: str) -> str:
    prefix = f"mcp__{MCP_SERVER_NAME}__"
    return full_name.removeprefix(prefix)


def classify_tool(full_name: str) -> Literal["read", "write", "unknown"]:
    short = short_tool_name(full_name)
    if short == full_name:  # prefix absent: not one of ours
        return "unknown"
    if short in READ_TOOLS:
        return "read"
    if short in WRITE_TOOLS:
        return "write"
    return "unknown"


def resolve_model(name: str | None) -> str:
    if name is None:
        return DEFAULT_MODEL
    if name not in MODELS:
        raise ValueError(f"unknown model {name!r}; expected one of {', '.join(MODELS)}")
    return name


def _clip(value: object) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(text) > _MAX_VALUE_CHARS:
        return text[: _MAX_VALUE_CHARS - 1] + "…"
    return text


_SUMMARY_KEYS: dict[str, tuple[str, str]] = {
    # short tool name -> (format, input key)
    "search": ('searching "{}"', "q"),
    "query": ('querying "{}"', "q"),
    "get_page": ('reading page "{}"', "title"),
    "backlinks": ('backlinks for "{}"', "title"),
    "get_block": ("reading block {}", "uid"),
}


def tool_summary(short: str, tool_input: dict) -> str:
    if short == "todos":
        return "listing TODOs"
    entry = _SUMMARY_KEYS.get(short)
    if entry is not None:
        fmt, key = entry
        value = tool_input.get(key)
        if value:
            return fmt.format(_clip(value))
    return short


def ops_preview(short: str, tool_input: dict) -> str:
    if short == "batch":
        ops = tool_input.get("ops") or []
        lines = [f"batch: {len(ops)} operation(s)"]
        lines += [f"  {i + 1}. {_clip(op)}" for i, op in enumerate(ops)]
        return "\n".join(lines)
    args = ", ".join(f"{k}={_clip(v)}" for k, v in tool_input.items())
    return f"{short}({args})"


SYSTEM_PROMPT = """\
You are the assistant embedded in the user's personal knowledge base (PKM).
Your only tools are the ten PKM verbs exposed over MCP; you have no shell,
filesystem, or web access.

Retrieval questions ("what have I written about X", "who did I meet"):
- Loop: search -> get_page -> backlinks. Backlinks (not search) usually
  answer "who/when" questions; daily notes are pages titled like
  "July 26th, 2026".
- Quote or reference the notes you used, with their page titles.

Editing and reorganisation ("tidy this page", "merge these notes"):
- Read the page first with get_page; blocks carry uids.
- Propose changes concisely, then apply them with the write verbs
  (save_note, update_block, batch, upload_asset).
- Every write pauses for the user to confirm in the UI. If the user
  declines a write, do not retry it; ask what they want instead.

Style: answer in plain markdown, be brief, never invent page titles or
uids — always look them up first.
"""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_assistant_policy.py -q --no-cov`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/assistant/policy.py server/tests/test_assistant_policy.py
git commit -m "pkm-wn2s: assistant tool-gate policy, model allowlist, previews, system prompt"
```

### Task 3: `engine.py` protocols + `FakeEngine` test double

**Files:**
- Create: `server/src/pkm/assistant/engine.py`
- Create: `server/tests/fake_engine.py` (plain module in `tests/`, so `e2e_serve.py` can import it too)
- Test: `server/tests/test_fake_engine.py`

**Interfaces:**
- Produces: `ConversationHandle` protocol (`send(text) -> AsyncIterator[AssistantEvent]`, `resolve_confirm(tool_use_id, allow)`, `async close()`), `AgentEngine` protocol (`async create_conversation(system_prompt, model) -> ConversationHandle`).
- Produces (tests): `FakeEngine` with `.conversations: list[FakeConversation]`; `FakeConversation` with `.model`, `.system_prompt`, `.closed`, `.sent: list[str]`. Behavior keyed on message text: contains `"please write"` → confirm flow with `tool_use_id="fake-confirm-1"`; anything else → echo. Tasks 5 and 13 rely on these exact strings.

- [ ] **Step 1: Write the failing test**

`server/tests/test_fake_engine.py`:

```python
import asyncio

from fake_engine import FakeEngine
from pkm.assistant.engine import AgentEngine
from pkm.assistant.events import ConfirmRequest, TextDelta, ToolFinished, ToolStarted, TurnDone
from pkm.assistant.policy import SYSTEM_PROMPT


def test_fake_engine_satisfies_protocol():
    engine: AgentEngine = FakeEngine()  # type-checks under pyrefly
    assert isinstance(engine, FakeEngine)


def test_echo_turn():
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        return [ev async for ev in conv.send("hello")]

    events = asyncio.run(scenario())
    assert events == [TextDelta(text="echo: hello"), TurnDone(usage={"input_tokens": 1})]


def test_confirm_flow_allow():
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        events = []

        async def consume():
            async for ev in conv.send("please write"):
                events.append(ev)
                if isinstance(ev, ConfirmRequest):
                    conv.resolve_confirm(ev.tool_use_id, True)

        await asyncio.wait_for(consume(), timeout=5)
        return events

    events = asyncio.run(scenario())
    assert events[0] == ToolStarted(name="save_note", summary="saving a note")
    assert events[1] == ConfirmRequest(tool_use_id="fake-confirm-1", ops_preview='save_note(title="Demo")')
    assert ToolFinished(name="save_note") in events
    assert TextDelta(text="Saved.") in events
    assert isinstance(events[-1], TurnDone)


def test_confirm_flow_deny():
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        events = []
        async for ev in conv.send("please write"):
            events.append(ev)
            if isinstance(ev, ConfirmRequest):
                conv.resolve_confirm(ev.tool_use_id, False)
        return events

    events = asyncio.run(scenario())
    assert TextDelta(text="Okay, not saving.") in events
    assert ToolFinished(name="save_note") not in events


def test_close_marks_closed():
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "haiku")
        await conv.close()
        return conv

    conv = asyncio.run(scenario())
    assert conv.closed is True
    assert conv.model == "haiku"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_fake_engine.py -q --no-cov`
Expected: FAIL — `ModuleNotFoundError: No module named 'fake_engine'`

- [ ] **Step 3: Write the protocols**

`server/src/pkm/assistant/engine.py`:

```python
# pattern: Functional Core
"""AgentEngine / ConversationHandle protocols (types only, no I/O)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from pkm.assistant.events import AssistantEvent


class ConversationHandle(Protocol):
    def send(self, text: str) -> AsyncIterator[AssistantEvent]:
        """Send one user turn; yields events until TurnDone or ErrorEvent."""
        ...

    def resolve_confirm(self, tool_use_id: str, allow: bool) -> None:
        """Answer a pending ConfirmRequest. Unknown ids are ignored."""
        ...

    async def close(self) -> None: ...


class AgentEngine(Protocol):
    async def create_conversation(self, system_prompt: str, model: str) -> ConversationHandle: ...
```

- [ ] **Step 4: Write the FakeEngine**

`server/tests/fake_engine.py`:

```python
# pattern: Imperative Shell
"""Scripted AgentEngine double for unit/route tests and the e2e server.

Behavior is keyed on the user text so Playwright can drive it:
- "please write"  -> ToolStarted + ConfirmRequest (id "fake-confirm-1"),
                     then Saved./Okay, not saving. after resolve_confirm.
- anything else   -> TextDelta("echo: <text>") + TurnDone.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from pkm.assistant.events import (
    AssistantEvent,
    ConfirmRequest,
    TextDelta,
    ToolFinished,
    ToolStarted,
    TurnDone,
)


class FakeConversation:
    def __init__(self, system_prompt: str, model: str) -> None:
        self.system_prompt = system_prompt
        self.model = model
        self.closed = False
        self.sent: list[str] = []
        self._decisions: dict[str, asyncio.Future[bool]] = {}
        self._confirm_seq = 0

    async def send(self, text: str) -> AsyncIterator[AssistantEvent]:
        self.sent.append(text)
        if "please write" in text:
            self._confirm_seq += 1
            tool_use_id = f"fake-confirm-{self._confirm_seq}"
            fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
            self._decisions[tool_use_id] = fut
            yield ToolStarted(name="save_note", summary="saving a note")
            yield ConfirmRequest(tool_use_id=tool_use_id, ops_preview='save_note(title="Demo")')
            allowed = await fut
            if allowed:
                yield ToolFinished(name="save_note")
                yield TextDelta(text="Saved.")
            else:
                yield TextDelta(text="Okay, not saving.")
            yield TurnDone(usage={"input_tokens": 1})
            return
        yield TextDelta(text=f"echo: {text}")
        yield TurnDone(usage={"input_tokens": 1})

    def resolve_confirm(self, tool_use_id: str, allow: bool) -> None:
        fut = self._decisions.get(tool_use_id)
        if fut is not None and not fut.done():
            fut.set_result(allow)

    async def close(self) -> None:
        self.closed = True
        for fut in self._decisions.values():
            if not fut.done():
                fut.set_result(False)


class FakeEngine:
    def __init__(self) -> None:
        self.conversations: list[FakeConversation] = []

    async def create_conversation(self, system_prompt: str, model: str) -> FakeConversation:
        conv = FakeConversation(system_prompt, model)
        self.conversations.append(conv)
        return conv
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_fake_engine.py -q --no-cov`
Expected: 5 passed

- [ ] **Step 6: Type check, then commit**

Run: `cd server && uv run pyrefly check`
Expected: clean (the `engine: AgentEngine = FakeEngine()` line proves protocol conformance).

```bash
git add server/src/pkm/assistant/engine.py server/tests/fake_engine.py server/tests/test_fake_engine.py
git commit -m "pkm-wn2s: engine protocols + scripted FakeEngine"
```

### Task 4: `service.py` (conversation registry, caps, idle reaping)

**Files:**
- Create: `server/src/pkm/assistant/service.py`
- Test: `server/tests/test_assistant_service.py`

**Interfaces:**
- Consumes: `AgentEngine`/`ConversationHandle` (Task 3), `resolve_model`, `SYSTEM_PROMPT` (Task 2), events (Task 1).
- Produces: `AssistantService(engine, *, max_conversations=3, idle_ttl=900.0, clock=time.monotonic)` with `async create(model: str | None) -> tuple[str, str]` (returns `(conversation_id, model)`; raises `ValueError` on bad model, `ConversationLimitError` when full), `send(conversation_id, text) -> AsyncIterator[AssistantEvent]` (raises `UnknownConversationError`, `BusyError` — validation happens BEFORE iteration starts), `confirm(conversation_id, tool_use_id, allow)`, `async delete(conversation_id)` (idempotent), `async close_all()`. Exceptions: `ConversationLimitError`, `UnknownConversationError`, `BusyError` (all `Exception` subclasses). Task 5 consumes all of these.

- [ ] **Step 1: Write the failing test**

`server/tests/test_assistant_service.py`:

```python
import asyncio

import pytest

from fake_engine import FakeEngine
from pkm.assistant.events import ConfirmRequest, TextDelta, TurnDone
from pkm.assistant.service import (
    AssistantService,
    BusyError,
    ConversationLimitError,
    UnknownConversationError,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_create_resolves_model_and_uses_system_prompt():
    engine = FakeEngine()
    service = AssistantService(engine)

    async def scenario():
        return await service.create(None), await service.create("opus")

    (cid1, model1), (cid2, model2) = asyncio.run(scenario())
    assert model1 == "sonnet" and model2 == "opus"
    assert cid1 != cid2
    assert engine.conversations[0].model == "sonnet"
    assert "PKM" in engine.conversations[0].system_prompt


def test_create_rejects_unknown_model():
    service = AssistantService(FakeEngine())
    with pytest.raises(ValueError):
        asyncio.run(service.create("gpt-4o"))


def test_conversation_cap():
    service = AssistantService(FakeEngine(), max_conversations=2)

    async def scenario():
        await service.create(None)
        await service.create(None)
        with pytest.raises(ConversationLimitError):
            await service.create(None)

    asyncio.run(scenario())


def test_idle_conversations_reaped_on_create():
    clock = FakeClock()
    engine = FakeEngine()
    service = AssistantService(engine, max_conversations=1, idle_ttl=900.0, clock=clock)

    async def scenario():
        await service.create(None)
        clock.now += 901.0
        await service.create(None)  # reaps the idle one instead of raising

    asyncio.run(scenario())
    assert engine.conversations[0].closed is True
    assert len(engine.conversations) == 2


def test_send_streams_and_unknown_id_raises():
    engine = FakeEngine()
    service = AssistantService(engine)

    async def scenario():
        cid, _ = await service.create(None)
        events = [ev async for ev in service.send(cid, "hi")]
        with pytest.raises(UnknownConversationError):
            service.send("nope", "hi")
        return events

    events = asyncio.run(scenario())
    assert events == [TextDelta(text="echo: hi"), TurnDone(usage={"input_tokens": 1})]


def test_send_while_busy_raises():
    engine = FakeEngine()
    service = AssistantService(engine)

    async def scenario():
        cid, _ = await service.create(None)
        stream = service.send(cid, "please write")  # blocks awaiting confirm
        first = [await anext(stream), await anext(stream)]
        assert isinstance(first[-1], ConfirmRequest)
        with pytest.raises(BusyError):
            service.send(cid, "second message")
        service.confirm(cid, first[-1].tool_use_id, True)
        rest = [ev async for ev in stream]
        return rest

    rest = asyncio.run(scenario())
    assert isinstance(rest[-1], TurnDone)


def test_confirm_unknown_conversation_raises():
    service = AssistantService(FakeEngine())
    with pytest.raises(UnknownConversationError):
        service.confirm("nope", "t1", True)


def test_delete_closes_and_is_idempotent():
    engine = FakeEngine()
    service = AssistantService(engine)

    async def scenario():
        cid, _ = await service.create(None)
        await service.delete(cid)
        await service.delete(cid)  # no error
        with pytest.raises(UnknownConversationError):
            service.send(cid, "hi")

    asyncio.run(scenario())
    assert engine.conversations[0].closed is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_assistant_service.py -q --no-cov`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.assistant.service'`

- [ ] **Step 3: Write the implementation**

`server/src/pkm/assistant/service.py`:

```python
# pattern: Imperative Shell
"""In-memory conversation registry: caps, idle reaping, per-conversation lock."""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

from pkm.assistant.engine import AgentEngine, ConversationHandle
from pkm.assistant.events import AssistantEvent
from pkm.assistant.policy import SYSTEM_PROMPT, resolve_model

logger = logging.getLogger("pkm.assistant")


class ConversationLimitError(Exception):
    pass


class UnknownConversationError(Exception):
    pass


class BusyError(Exception):
    pass


@dataclass
class _Entry:
    handle: ConversationHandle
    model: str
    last_used: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class AssistantService:
    def __init__(
        self,
        engine: AgentEngine,
        *,
        max_conversations: int = 3,
        idle_ttl: float = 900.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._engine = engine
        self._max = max_conversations
        self._idle_ttl = idle_ttl
        self._clock = clock
        self._entries: dict[str, _Entry] = {}

    async def create(self, model: str | None) -> tuple[str, str]:
        resolved = resolve_model(model)
        await self._reap_idle()
        if len(self._entries) >= self._max:
            raise ConversationLimitError(f"at most {self._max} concurrent conversations")
        handle = await self._engine.create_conversation(SYSTEM_PROMPT, resolved)
        cid = secrets.token_hex(8)
        self._entries[cid] = _Entry(handle=handle, model=resolved, last_used=self._clock())
        logger.info("assistant conversation %s created (model=%s)", cid, resolved)
        return cid, resolved

    def send(self, conversation_id: str, text: str) -> AsyncIterator[AssistantEvent]:
        entry = self._get(conversation_id)
        if entry.lock.locked():
            raise BusyError("a turn is already in progress")
        return self._stream(conversation_id, entry, text)

    async def _stream(self, cid: str, entry: _Entry, text: str) -> AsyncIterator[AssistantEvent]:
        async with entry.lock:
            entry.last_used = self._clock()
            async for event in entry.handle.send(text):
                yield event
            entry.last_used = self._clock()

    def confirm(self, conversation_id: str, tool_use_id: str, allow: bool) -> None:
        self._get(conversation_id).handle.resolve_confirm(tool_use_id, allow)

    async def delete(self, conversation_id: str) -> None:
        entry = self._entries.pop(conversation_id, None)
        if entry is not None:
            await entry.handle.close()
            logger.info("assistant conversation %s closed", conversation_id)

    async def close_all(self) -> None:
        for cid in list(self._entries):
            await self.delete(cid)

    def _get(self, conversation_id: str) -> _Entry:
        entry = self._entries.get(conversation_id)
        if entry is None:
            raise UnknownConversationError(conversation_id)
        return entry

    async def _reap_idle(self) -> None:
        cutoff = self._clock() - self._idle_ttl
        stale = [cid for cid, e in self._entries.items() if e.last_used < cutoff and not e.lock.locked()]
        for cid in stale:
            logger.info("assistant conversation %s reaped (idle)", cid)
            await self.delete(cid)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && uv run pytest tests/test_assistant_service.py -q --no-cov`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add server/src/pkm/assistant/service.py server/tests/test_assistant_service.py
git commit -m "pkm-wn2s: assistant conversation registry with cap + idle reaping"
```

### Task 5: `routes.py` + app wiring (first SSE endpoint in the app)

**Files:**
- Create: `server/src/pkm/assistant/routes.py`
- Modify: `server/src/pkm/server/response_models.py` (append two models)
- Modify: `server/src/pkm/server/app.py` (signature + wiring; router registered before the SPA catch-all)
- Modify: `server/src/pkm/server/run.py:54` (pass `api_port=args.port`)
- Modify: `server/tests/conftest.py` (add `assistant_client` fixture)
- Test: `server/tests/test_assistant_routes.py`

**Interfaces:**
- Consumes: `AssistantService` + exceptions (Task 4), `encode_sse` (Task 1), `FakeEngine` (Task 3), `require_auth` (`pkm.server.auth`).
- Produces: HTTP surface `POST /api/assistant/conversations` `{model?} -> {id, model}` (400 bad model, 409 at cap); `POST /api/assistant/conversations/{cid}/messages` `{text}` → SSE stream (404, 409 busy); `POST /api/assistant/conversations/{cid}/confirm` `{tool_use_id, allow} -> {ok: true}` (404); `DELETE /api/assistant/conversations/{cid}` → `{ok: true}` (idempotent). Response models `AssistantConversation(id, model)`, `AssistantAck(ok: bool)`. `create_app(config, *, api_port: int = 8974, assistant_engine: AgentEngine | None = None)`. Confirm/delete return JSON 200 (not 204) so the web `apiFetch` wrapper (which always calls `res.json()`) can be used.

- [ ] **Step 1: Add the conftest fixture**

Append to `server/tests/conftest.py` (import `FakeEngine` at top: `from fake_engine import FakeEngine`; import `create_app` is already there):

```python
@pytest.fixture
def fake_engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def assistant_client(seeded_config, fake_engine):
    from fastapi.testclient import TestClient

    from pkm.server.app import create_app

    with TestClient(create_app(seeded_config, assistant_engine=fake_engine)) as c:
        password = "test-password"  # match the password used by seeded_config's existing seeding
        r = c.post("/api/login", json={"password": password})
        assert r.status_code == 200
        yield c
```

NOTE: read `conftest.py` first — reuse the exact password/login shape the existing `client` fixture uses (copy its login lines verbatim rather than the sketch above).

- [ ] **Step 2: Write the failing test**

`server/tests/test_assistant_routes.py`:

```python
import json
import time
from concurrent.futures import ThreadPoolExecutor


def parse_sse(body: str) -> list[tuple[str, dict]]:
    events = []
    for chunk in body.split("\n\n"):
        if not chunk.strip():
            continue
        lines = chunk.split("\n")
        name = lines[0].removeprefix("event: ")
        data = json.loads(lines[1].removeprefix("data: "))
        events.append((name, data))
    return events


def test_requires_auth(anon_client):
    r = anon_client.post("/api/assistant/conversations", json={})
    assert r.status_code == 401


def test_create_conversation_defaults_to_sonnet(assistant_client):
    r = assistant_client.post("/api/assistant/conversations", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["model"] == "sonnet"
    assert len(body["id"]) == 16


def test_create_conversation_bad_model_400(assistant_client):
    r = assistant_client.post("/api/assistant/conversations", json={"model": "gpt-4o"})
    assert r.status_code == 400


def test_conversation_cap_409(assistant_client):
    for _ in range(3):
        assert assistant_client.post("/api/assistant/conversations", json={}).status_code == 200
    r = assistant_client.post("/api/assistant/conversations", json={})
    assert r.status_code == 409


def test_message_stream_echo(assistant_client):
    cid = assistant_client.post("/api/assistant/conversations", json={}).json()["id"]
    with assistant_client.stream(
        "POST", f"/api/assistant/conversations/{cid}/messages", json={"text": "hi"}
    ) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        body = "".join(r.iter_text())
    events = parse_sse(body)
    assert events[0] == ("text_delta", {"text": "echo: hi"})
    assert events[-1][0] == "turn_done"


def test_message_unknown_conversation_404(assistant_client):
    r = assistant_client.post("/api/assistant/conversations/nope/messages", json={"text": "hi"})
    assert r.status_code == 404


def test_confirm_roundtrip_over_http(assistant_client):
    cid = assistant_client.post("/api/assistant/conversations", json={}).json()["id"]

    def consume() -> list[tuple[str, dict]]:
        with assistant_client.stream(
            "POST", f"/api/assistant/conversations/{cid}/messages", json={"text": "please write"}
        ) as r:
            return parse_sse("".join(r.iter_text()))

    with ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(consume)
        # wait until the stream is blocked on the confirm, then answer it
        deadline = time.time() + 5
        while time.time() < deadline:
            resp = assistant_client.post(
                f"/api/assistant/conversations/{cid}/confirm",
                json={"tool_use_id": "fake-confirm-1", "allow": True},
            )
            assert resp.status_code == 200
            if fut.done():
                break
            time.sleep(0.05)
        events = fut.result(timeout=5)

    names = [n for n, _ in events]
    assert "confirm_request" in names
    assert ("text_delta", {"text": "Saved."}) in events


def test_confirm_unknown_conversation_404(assistant_client):
    r = assistant_client.post(
        "/api/assistant/conversations/nope/confirm", json={"tool_use_id": "x", "allow": True}
    )
    assert r.status_code == 404


def test_delete_conversation(assistant_client):
    cid = assistant_client.post("/api/assistant/conversations", json={}).json()["id"]
    assert assistant_client.delete(f"/api/assistant/conversations/{cid}").json() == {"ok": True}
    # idempotent
    assert assistant_client.delete(f"/api/assistant/conversations/{cid}").status_code == 200
    # gone
    r = assistant_client.post(f"/api/assistant/conversations/{cid}/messages", json={"text": "hi"})
    assert r.status_code == 404
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_assistant_routes.py -q --no-cov`
Expected: FAIL — 404s everywhere (routes not registered) / import errors.

- [ ] **Step 4: Add response models**

Append to `server/src/pkm/server/response_models.py` (match the file's existing style — likely `BaseModel` subclasses):

```python
class AssistantConversation(BaseModel):
    id: str
    model: str


class AssistantAck(BaseModel):
    ok: bool = True
```

- [ ] **Step 5: Write the routes**

`server/src/pkm/assistant/routes.py`:

```python
# pattern: Imperative Shell
"""HTTP/SSE endpoints for the embedded assistant."""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from pkm.assistant.events import ErrorEvent, encode_sse
from pkm.assistant.service import (
    AssistantService,
    BusyError,
    ConversationLimitError,
    UnknownConversationError,
)
from pkm.server.auth import require_auth
from pkm.server.response_models import AssistantAck, AssistantConversation

router = APIRouter(dependencies=[Depends(require_auth)])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class CreateConversationRequest(BaseModel):
    model: str | None = None


class SendMessageRequest(BaseModel):
    text: str


class ConfirmRequestBody(BaseModel):
    tool_use_id: str
    allow: bool


def get_service(request: Request) -> AssistantService:
    return request.app.state.assistant


@router.post("/api/assistant/conversations", response_model=AssistantConversation)
async def create_conversation(
    body: CreateConversationRequest, service: AssistantService = Depends(get_service)
) -> dict:
    try:
        cid, model = await service.create(body.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ConversationLimitError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"id": cid, "model": model}


@router.post("/api/assistant/conversations/{conversation_id}/messages")
async def send_message(
    conversation_id: str,
    body: SendMessageRequest,
    service: AssistantService = Depends(get_service),
) -> StreamingResponse:
    try:
        stream = service.send(conversation_id, body.text)
    except UnknownConversationError as exc:
        raise HTTPException(status_code=404, detail="unknown conversation") from exc
    except BusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    async def sse() -> AsyncIterator[str]:
        try:
            async for event in stream:
                yield encode_sse(event)
        except Exception as exc:  # engine failure mid-stream: report in-band
            yield encode_sse(ErrorEvent(message=str(exc)))

    return StreamingResponse(sse(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/api/assistant/conversations/{conversation_id}/confirm", response_model=AssistantAck)
async def confirm_tool(
    conversation_id: str,
    body: ConfirmRequestBody,
    service: AssistantService = Depends(get_service),
) -> dict:
    try:
        service.confirm(conversation_id, body.tool_use_id, body.allow)
    except UnknownConversationError as exc:
        raise HTTPException(status_code=404, detail="unknown conversation") from exc
    return {"ok": True}


@router.delete("/api/assistant/conversations/{conversation_id}", response_model=AssistantAck)
async def delete_conversation(
    conversation_id: str, service: AssistantService = Depends(get_service)
) -> dict:
    await service.delete(conversation_id)
    return {"ok": True}
```

(Use a real `from collections.abc import AsyncIterator` import instead of the string annotation if pyrefly prefers; keep whichever passes `uv run pyrefly check` cleanly.)

- [ ] **Step 6: Wire into `create_app` and `run.py`**

Task 7 creates `claude_engine.py`, so in THIS task `create_app` cannot build a real engine yet. Wire it so that with no engine passed the routes exist but answer 503; Task 7 swaps the default to a real `ClaudeEngine`.

In `server/src/pkm/server/app.py`, change the signature and register the router with the other protected routers (BEFORE the static mount / SPA catch-all):

```python
from pkm.assistant.engine import AgentEngine
from pkm.assistant.routes import router as assistant_router
from pkm.assistant.service import AssistantService


def create_app(
    config: Config,
    *,
    api_port: int = 8974,
    assistant_engine: AgentEngine | None = None,
) -> FastAPI:
    ...
    # Task 7 replaces this None default with a real ClaudeEngine(base_url=..., session_secret_hex=...)
    app.state.assistant = AssistantService(assistant_engine) if assistant_engine is not None else None
    app.include_router(assistant_router)
    ...
```

and make `get_service` in `routes.py` guard the unconfigured case (this replaces the plain attribute read shown in Step 5):

```python
def get_service(request: Request) -> AssistantService:
    service = request.app.state.assistant
    if service is None:
        raise HTTPException(status_code=503, detail="assistant not configured")
    return service
```

Add one test:

```python
def test_assistant_unconfigured_503(client):
    # the standard `client` fixture builds create_app() without an engine
    r = client.post("/api/assistant/conversations", json={})
    assert r.status_code == 503
```

(After Task 7 this test changes: `create_app` without an explicit engine builds a real `ClaudeEngine` lazily, so DELETE this 503 test in Task 7 and drop the guard only if `app.state.assistant` can no longer be `None`.)

In `server/src/pkm/server/run.py` line 54, pass the port through:

```python
        create_app(config, api_port=args.port), port=args.port,
```

- [ ] **Step 7: Run the tests**

Run: `cd server && uv run pytest tests/test_assistant_routes.py -q --no-cov`
Expected: all pass (including the threaded confirm round-trip).

Run: `cd server && uv run pytest -q`
Expected: **`test_committed_openapi_matches_live_schema` FAILS** (new routes not in committed openapi.json) — that is Task 6's job; everything else passes. Do not commit yet if anything ELSE fails.

- [ ] **Step 8: Regenerate OpenAPI + types (fold in now so the suite is green at commit)**

```bash
cd server && uv run python -m pkm.server.openapi_dump > ../web/src/api/openapi.json
cd ../web && pnpm gen-types
cd ../server && uv run pytest -q && uv run pyrefly check && uv run ruff check
```

Expected: full suite green, coverage ≥95%, types clean.

- [ ] **Step 9: Commit**

```bash
git add server/src/pkm/assistant/routes.py server/src/pkm/server/response_models.py \
  server/src/pkm/server/app.py server/src/pkm/server/run.py server/tests/conftest.py \
  server/tests/test_assistant_routes.py web/src/api/openapi.json web/src/api/types.d.ts
git commit -m "pkm-wn2s: assistant HTTP/SSE routes wired into app; regen openapi types"
```

### Task 6: (folded into Task 5 Step 8 — openapi regen)

No separate work; kept as a numbered placeholder so later task references stay stable. Verify `git status` is clean of `web/src/api/*` drift before starting Task 7.

### Task 7: `claude_engine.py` (Claude Agent SDK adapter)

**Files:**
- Create: `server/src/pkm/assistant/claude_engine.py`
- Modify: `server/src/pkm/server/app.py` (replace the `None` service default with a real `ClaudeEngine`; delete the 503 test if the guard becomes unreachable — see Task 5 Step 6)
- Test: `server/tests/test_claude_engine.py`

**Interfaces:**
- Consumes: `sign_session` (`pkm.server.auth_core`), policy functions (Task 2), events (Task 1); `claude_agent_sdk` package (`ClaudeSDKClient`, `ClaudeAgentOptions`, `PermissionResultAllow`, `PermissionResultDeny`, message types `AssistantMessage`, `UserMessage`, `ResultMessage`, `StreamEvent`, blocks `TextBlock`, `ToolUseBlock`, `ToolResultBlock`).
- Produces: `ClaudeEngine(*, base_url: str, session_secret_hex: str, client_factory: Callable[[ClaudeAgentOptions], Any] | None = None, config_dir: Path | None = None)` implementing `AgentEngine`; `ClaudeConversation` implementing `ConversationHandle`; pure helper `TurnMapper` with `map(msg) -> list[AssistantEvent]`.

**SDK facts (verified 2026-07-26 against the Python SDK docs):**
- Multi-turn requires `ClaudeSDKClient` (module-level `query()` is one-shot). `await client.connect()`, `await client.query(text)`, iterate `client.receive_response()` (stops after `ResultMessage`), `await client.disconnect()`.
- `ClaudeAgentOptions(model=..., system_prompt=..., tools=[], allowed_tools=[...], can_use_tool=..., mcp_servers={...}, setting_sources=[], include_partial_messages=True, max_turns=...)`. `tools=[]` disables ALL built-ins; `setting_sources=[]` ignores `~/.claude` settings/CLAUDE.md (auth credentials are still found — separate mechanism).
- `can_use_tool` is `async (tool_name, tool_input, context) -> PermissionResultAllow() | PermissionResultDeny(message=..., interrupt=False)`; it may block on asyncio primitives while the loop waits. MCP tool names arrive namespaced (`mcp__pkm__search`).
- Stdio MCP server config: `{"pkm": {"type": "stdio", "command": sys.executable, "args": ["-m", "pkm.mcp.server"], "env": {"PKM_CLI_CONFIG": <path>}}}` — `pkm/mcp/server.py` already has an `if __name__ == "__main__": main()` guard; `sys.executable -m` avoids PATH dependence under launchd.
- With `include_partial_messages=True` the stream yields `StreamEvent` objects whose `.event` dict carries raw API events (`{"type": "content_block_delta", "delta": {"type": "text_delta", "text": ...}}`).
- Auth: with no `ANTHROPIC_API_KEY`, the CLI resolves the Max-plan login from `~/.claude` / Keychain automatically; subprocess inherits `os.environ` (launchd note in Task 14).

- [ ] **Step 1: Write the failing test**

`server/tests/test_claude_engine.py`. A `FakeSDKClient` stands in for `ClaudeSDKClient` via `client_factory`; it records the options and replays scripted SDK messages, and its script can call `can_use_tool` the way the real SDK does.

```python
import asyncio
import json
import stat
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

from pkm.assistant.claude_engine import ClaudeEngine, TurnMapper
from pkm.assistant.events import ConfirmRequest, TextDelta, ToolStarted, TurnDone
from pkm.assistant.policy import SYSTEM_PROMPT

SECRET = "ab" * 32


def make_result(**over):
    defaults = dict(
        subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
        num_turns=1, session_id="s1", usage={"input_tokens": 5},
    )
    defaults.update(over)
    return ResultMessage(**defaults)


class FakeSDKClient:
    """Stands in for ClaudeSDKClient; instances are created by client_factory.

    receive_response() awaits a queue (like the real SDK awaits the CLI), so
    the engine's pump task stays alive while a confirm round-trip is pending.
    Feed messages with feed(); a ResultMessage ends the turn.
    """

    instances: list["FakeSDKClient"] = []

    def __init__(self, options):
        self.options = options
        self.connected = False
        self.queries: list[str] = []
        self.messages: asyncio.Queue = asyncio.Queue()
        FakeSDKClient.instances.append(self)

    def feed(self, *msgs):
        for msg in msgs:
            self.messages.put_nowait(msg)

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.connected = False

    async def query(self, text):
        self.queries.append(text)

    async def receive_response(self):
        while True:
            msg = await self.messages.get()
            yield msg
            if isinstance(msg, ResultMessage):
                return


def make_engine(tmp_path) -> ClaudeEngine:
    FakeSDKClient.instances.clear()
    return ClaudeEngine(
        base_url="http://127.0.0.1:8999",
        session_secret_hex=SECRET,
        client_factory=FakeSDKClient,
        config_dir=tmp_path,
    )


def test_create_conversation_options_and_config_file(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        return await engine.create_conversation(SYSTEM_PROMPT, "opus")

    conv = asyncio.run(scenario())
    client = FakeSDKClient.instances[0]
    assert client.connected is True
    opts = client.options
    assert opts.model == "opus"
    assert opts.system_prompt == SYSTEM_PROMPT
    assert opts.tools == []
    assert opts.setting_sources == []
    assert opts.include_partial_messages is True
    assert set(opts.allowed_tools) == {
        f"mcp__pkm__{t}" for t in ("get_page", "get_block", "search", "query", "backlinks", "todos")
    }
    server_cfg = opts.mcp_servers["pkm"]
    cfg_path = Path(server_cfg["env"]["PKM_CLI_CONFIG"])
    assert cfg_path.parent == tmp_path
    assert stat.S_IMODE(cfg_path.stat().st_mode) == 0o600
    cfg = json.loads(cfg_path.read_text())
    assert cfg["url"] == "http://127.0.0.1:8999"
    assert cfg["token"].startswith("v1.")
    asyncio.run(conv.close())
    assert not cfg_path.exists()  # config file removed on close
    assert client.connected is False


def test_can_use_tool_allows_reads_denies_unknown(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        read = await conv.can_use_tool("mcp__pkm__search", {"q": "x"}, None)
        unknown = await conv.can_use_tool("Bash", {"command": "rm"}, None)
        await conv.close()
        return read, unknown

    read, unknown = asyncio.run(scenario())
    assert isinstance(read, PermissionResultAllow)
    assert isinstance(unknown, PermissionResultDeny)


def test_write_tool_emits_confirm_and_blocks(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]

        results = {}

        async def fake_model_turn():
            # what the SDK does internally: call the hook, wait for the
            # decision, then finish the turn with a ResultMessage
            results["decision"] = await conv.can_use_tool(
                "mcp__pkm__save_note", {"title": "Demo"}, None
            )
            client.feed(make_result())

        task = asyncio.create_task(fake_model_turn())
        stream = conv.send("save it")
        ev1 = await asyncio.wait_for(anext(stream), timeout=5)  # ConfirmRequest via the queue
        assert isinstance(ev1, ConfirmRequest)
        assert "save_note" in ev1.ops_preview
        conv.resolve_confirm(ev1.tool_use_id, True)
        await asyncio.wait_for(task, timeout=5)
        rest = [ev async for ev in stream]
        await conv.close()
        return results["decision"], rest

    decision, rest = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultAllow)
    assert isinstance(rest[-1], TurnDone)


def test_deny_returns_declined_message(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]

        async def decide():
            decision = await conv.can_use_tool("mcp__pkm__batch", {"ops": []}, None)
            client.feed(make_result())
            return decision

        task = asyncio.create_task(decide())
        stream = conv.send("go")
        ev = await asyncio.wait_for(anext(stream), timeout=5)
        conv.resolve_confirm(ev.tool_use_id, False)
        decision = await asyncio.wait_for(task, timeout=5)
        _ = [e async for e in stream]
        await conv.close()
        return decision

    decision = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultDeny)
    assert "declined" in decision.message


def test_send_streams_mapped_events(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        client.feed(
            AssistantMessage(
                content=[TextBlock(text="Found it."),
                         ToolUseBlock(id="t1", name="mcp__pkm__search", input={"q": "alpha"})],
                model="sonnet",
            ),
            make_result(),
        )
        events = [ev async for ev in conv.send("find alpha")]
        await conv.close()
        return events, client.queries

    events, queries = asyncio.run(scenario())
    assert queries == ["find alpha"]
    # no partial deltas were seen, so the full TextBlock is emitted as one delta
    assert TextDelta(text="Found it.") in events
    assert ToolStarted(name="search", summary='searching "alpha"') in events
    assert isinstance(events[-1], TurnDone)
    assert events[-1].usage == {"input_tokens": 5}


def test_turn_mapper_prefers_partial_deltas():
    from claude_agent_sdk import StreamEvent

    mapper = TurnMapper()
    # a partial delta arrives first...
    se = StreamEvent(uuid="u1", session_id="s1",
                     event={"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Fo"}})
    assert mapper.map(se) == [TextDelta(text="Fo")]
    # ...so the later full TextBlock is NOT duplicated
    msg = AssistantMessage(content=[TextBlock(text="Found.")], model="sonnet")
    assert mapper.map(msg) == []


def test_turn_mapper_error_result():
    mapper = TurnMapper()
    result = make_result(is_error=True, subtype="error_during_execution")
    events = mapper.map(result)
    assert len(events) == 1
    assert events[0].__class__.__name__ == "ErrorEvent"
```

NOTE for implementer: exact constructor signatures of `AssistantMessage`/`ResultMessage`/`StreamEvent` may differ slightly by SDK version — adjust the test helpers (`make_result`, block construction) to the installed `claude_agent_sdk` version, keeping the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && uv run pytest tests/test_claude_engine.py -q --no-cov`
Expected: FAIL — `ModuleNotFoundError: No module named 'pkm.assistant.claude_engine'`

- [ ] **Step 3: Write the implementation**

`server/src/pkm/assistant/claude_engine.py`:

```python
# pattern: Imperative Shell
"""Claude Agent SDK adapter: harness subprocess confined to the pkm MCP tools."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import sys
import tempfile
import time
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    StreamEvent,
    TextBlock,
    ToolUseBlock,
)

from pkm.assistant.events import (
    AssistantEvent,
    ConfirmRequest,
    ErrorEvent,
    TextDelta,
    ToolStarted,
    TurnDone,
)
from pkm.assistant.policy import (
    classify_tool,
    ops_preview,
    read_tool_names,
    short_tool_name,
    tool_summary,
)
from pkm.server.auth_core import sign_session

logger = logging.getLogger("pkm.assistant")

MAX_TURNS = 40


class TurnMapper:
    """Pure-ish mapping from SDK messages to AssistantEvents.

    Prefers partial text deltas; falls back to whole TextBlocks when no
    deltas were seen (older CLI versions).
    """

    def __init__(self) -> None:
        self._saw_delta = False

    def map(self, msg: Any) -> list[AssistantEvent]:
        if isinstance(msg, StreamEvent):
            event = msg.event
            if event.get("type") == "content_block_delta":
                delta = event.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    self._saw_delta = True
                    return [TextDelta(text=delta["text"])]
            return []
        if isinstance(msg, AssistantMessage):
            out: list[AssistantEvent] = []
            for block in msg.content:
                if isinstance(block, TextBlock) and not self._saw_delta:
                    out.append(TextDelta(text=block.text))
                elif isinstance(block, ToolUseBlock):
                    short = short_tool_name(block.name)
                    out.append(ToolStarted(name=short, summary=tool_summary(short, block.input or {})))
            return out
        if isinstance(msg, ResultMessage):
            if msg.is_error:
                return [ErrorEvent(message=f"assistant error: {msg.subtype}")]
            return [TurnDone(usage=msg.usage)]
        return []


class ClaudeConversation:
    def __init__(self, config_path: Path) -> None:
        self._config_path = config_path
        self._client: Any = None
        self._queue: asyncio.Queue[AssistantEvent] = asyncio.Queue()
        self._pending: dict[str, asyncio.Future[bool]] = {}
        self._confirm_seq = 0

    def attach(self, client: Any) -> None:
        self._client = client

    async def can_use_tool(self, tool_name: str, tool_input: dict, context: Any) -> Any:
        kind = classify_tool(tool_name)
        if kind == "read":
            return PermissionResultAllow()
        if kind != "write":
            logger.warning("assistant requested unexpected tool %s", tool_name)
            return PermissionResultDeny(message="Tool not permitted.")
        self._confirm_seq += 1
        tool_use_id = f"confirm-{self._confirm_seq}"
        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._pending[tool_use_id] = fut
        short = short_tool_name(tool_name)
        await self._queue.put(
            ConfirmRequest(tool_use_id=tool_use_id, ops_preview=ops_preview(short, tool_input or {}))
        )
        try:
            allowed = await fut
        finally:
            self._pending.pop(tool_use_id, None)
        if allowed:
            return PermissionResultAllow()
        return PermissionResultDeny(message="The user declined this action.")

    def resolve_confirm(self, tool_use_id: str, allow: bool) -> None:
        fut = self._pending.get(tool_use_id)
        if fut is not None and not fut.done():
            fut.set_result(allow)

    async def send(self, text: str) -> AsyncIterator[AssistantEvent]:
        await self._client.query(text)
        mapper = TurnMapper()
        pump = asyncio.create_task(self._pump(mapper))
        try:
            while True:
                event = await self._queue.get()
                yield event
                if isinstance(event, (TurnDone, ErrorEvent)):
                    break
        finally:
            # if the consumer went away mid-turn (browser dropped the SSE
            # stream), don't block generator close on a live harness turn
            if not pump.done():
                pump.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pump

    async def _pump(self, mapper: TurnMapper) -> None:
        try:
            async for msg in self._client.receive_response():
                for event in mapper.map(msg):
                    await self._queue.put(event)
        except Exception as exc:  # subprocess died, JSON decode, etc.
            logger.exception("assistant turn failed")
            await self._queue.put(ErrorEvent(message=str(exc)))

    async def close(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_result(False)
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # already dead is fine
                logger.exception("assistant disconnect failed")
        self._config_path.unlink(missing_ok=True)


class ClaudeEngine:
    def __init__(
        self,
        *,
        base_url: str,
        session_secret_hex: str,
        client_factory: Callable[[ClaudeAgentOptions], Any] | None = None,
        config_dir: Path | None = None,
    ) -> None:
        self._base_url = base_url
        self._secret = session_secret_hex
        self._client_factory = client_factory or (lambda opts: ClaudeSDKClient(options=opts))
        self._config_dir = config_dir

    def _write_cli_config(self) -> Path:
        token = sign_session(bytes.fromhex(self._secret), int(time.time() * 1000))
        fd, raw_path = tempfile.mkstemp(prefix="pkm-assistant-", suffix=".json", dir=self._config_dir)
        path = Path(raw_path)
        with os.fdopen(fd, "w") as fh:  # mkstemp is already 0600
            json.dump({"url": self._base_url, "token": token}, fh)
        return path

    async def create_conversation(self, system_prompt: str, model: str) -> ClaudeConversation:
        config_path = self._write_cli_config()
        conversation = ClaudeConversation(config_path)
        options = ClaudeAgentOptions(
            model=model,
            system_prompt=system_prompt,
            tools=[],
            allowed_tools=read_tool_names(),
            can_use_tool=conversation.can_use_tool,
            mcp_servers={
                "pkm": {
                    "type": "stdio",
                    "command": sys.executable,
                    "args": ["-m", "pkm.mcp.server"],
                    "env": {"PKM_CLI_CONFIG": str(config_path)},
                }
            },
            setting_sources=[],
            include_partial_messages=True,
            max_turns=MAX_TURNS,
        )
        client = self._client_factory(options)
        conversation.attach(client)
        await client.connect()
        logger.info("assistant harness started (model=%s)", model)
        return conversation
```

- [ ] **Step 4: Replace the app default engine (from Task 5)**

In `server/src/pkm/server/app.py`, replace the `None` service default with:

```python
    if assistant_engine is None:
        from pkm.assistant.claude_engine import ClaudeEngine

        assistant_engine = ClaudeEngine(
            base_url=f"http://127.0.0.1:{api_port}",
            session_secret_hex=config.session_secret,
        )
    app.state.assistant = AssistantService(assistant_engine)
```

Keep `get_service`'s 503 guard tolerant (it now never fires; simplify it to a plain attribute read if pyrefly complains about the dead branch) and DELETE `test_assistant_unconfigured_503` from Task 5. Constructing `ClaudeEngine` is cheap — no subprocess until a conversation is created — so existing tests that build `create_app(cfg)` stay fast.

- [ ] **Step 5: Run the tests**

Run: `cd server && uv run pytest tests/test_claude_engine.py -q --no-cov`
Expected: all pass.

Run: `cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check`
Expected: full suite green (coverage ≥95%), types + lint clean.

- [ ] **Step 6: One manual smoke test (NOT in CI)**

With a dev server running on a scratch port (never 8974):

```bash
cd server && uv run python - <<'EOF'
# quick REPL-style smoke: create a conversation against a running dev server
# (requires the machine's claude Max login; skip in CI)
import asyncio
from pkm.assistant.claude_engine import ClaudeEngine
from pkm.assistant.policy import SYSTEM_PROMPT
from pkm.server.config import load_config

config = load_config("<path-to-dev-config.json>")
engine = ClaudeEngine(base_url="http://127.0.0.1:<dev-port>", session_secret_hex=config.session_secret)

async def main():
    conv = await engine.create_conversation(SYSTEM_PROMPT, "haiku")
    async for ev in conv.send("What pages mention 'test'? Use search."):
        print(ev)
    await conv.close()

asyncio.run(main())
EOF
```

Expected: `ToolStarted(name='search', …)` followed by text deltas and `TurnDone`. Record the outcome in the bean.

- [ ] **Step 7: Commit**

```bash
git add server/src/pkm/assistant/claude_engine.py server/src/pkm/server/app.py \
  server/tests/test_claude_engine.py server/tests/test_assistant_routes.py
git commit -m "pkm-wn2s: Claude Agent SDK engine (MCP-confined, confirm-gated writes)"
```

### Task 8: Web SSE parser (`web/src/assistant/sse.ts`)

**Files:**
- Create: `web/src/assistant/sse.ts`
- Test: `web/src/assistant/sse.test.ts`

**Interfaces:**
- Produces: `type AssistantEvent = { type: "text_delta"; text: string } | { type: "tool_started"; name: string; summary: string } | { type: "tool_finished"; name: string } | { type: "confirm_request"; tool_use_id: string; ops_preview: string } | { type: "turn_done"; usage: Record<string, unknown> | null } | { type: "error"; message: string }`; `createSseParser(): { push(chunk: string): AssistantEvent[] }` — incremental, buffers partial frames across chunks. Tasks 9–11 consume these.

- [ ] **Step 1: Write the failing test**

`web/src/assistant/sse.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { createSseParser } from "./sse";

describe("createSseParser", () => {
  test("parses a complete frame", () => {
    const p = createSseParser();
    expect(p.push('event: text_delta\ndata: {"text": "hi"}\n\n')).toEqual([
      { type: "text_delta", text: "hi" },
    ]);
  });

  test("buffers partial frames across chunks", () => {
    const p = createSseParser();
    expect(p.push("event: text_delta\nda")).toEqual([]);
    expect(p.push('ta: {"text": "hi"}\n\n')).toEqual([{ type: "text_delta", text: "hi" }]);
  });

  test("parses multiple frames in one chunk", () => {
    const p = createSseParser();
    const events = p.push(
      'event: tool_started\ndata: {"name": "search", "summary": "searching \\"x\\""}\n\n' +
        'event: turn_done\ndata: {"usage": null}\n\n',
    );
    expect(events).toEqual([
      { type: "tool_started", name: "search", summary: 'searching "x"' },
      { type: "turn_done", usage: null },
    ]);
  });

  test("ignores malformed frames", () => {
    const p = createSseParser();
    expect(p.push("event: text_delta\ndata: {not json}\n\n")).toEqual([]);
    expect(p.push(": comment\n\n")).toEqual([]);
  });

  test("parses confirm_request", () => {
    const p = createSseParser();
    expect(
      p.push('event: confirm_request\ndata: {"tool_use_id": "c1", "ops_preview": "save_note(...)"}\n\n'),
    ).toEqual([{ type: "confirm_request", tool_use_id: "c1", ops_preview: "save_note(...)" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/assistant/sse.test.ts`
Expected: FAIL — cannot resolve `./sse`

- [ ] **Step 3: Write the implementation**

`web/src/assistant/sse.ts`:

```typescript
// pattern: Functional Core
// Incremental parser for the assistant's SSE stream (event:/data: frames).

export type AssistantEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_started"; name: string; summary: string }
  | { type: "tool_finished"; name: string }
  | { type: "confirm_request"; tool_use_id: string; ops_preview: string }
  | { type: "turn_done"; usage: Record<string, unknown> | null }
  | { type: "error"; message: string };

const EVENT_TYPES = new Set([
  "text_delta",
  "tool_started",
  "tool_finished",
  "confirm_request",
  "turn_done",
  "error",
]);

function parseFrame(frame: string): AssistantEvent | null {
  let eventName = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) eventName = line.slice("event: ".length);
    else if (line.startsWith("data: ")) data = line.slice("data: ".length);
  }
  if (!EVENT_TYPES.has(eventName) || !data) return null;
  try {
    const payload = JSON.parse(data) as Record<string, unknown>;
    return { type: eventName, ...payload } as AssistantEvent;
  } catch {
    return null;
  }
}

export function createSseParser(): { push(chunk: string): AssistantEvent[] } {
  let buffer = "";
  return {
    push(chunk: string): AssistantEvent[] {
      buffer += chunk;
      const events: AssistantEvent[] = [];
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseFrame(frame);
        if (parsed) events.push(parsed);
      }
      return events;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run src/assistant/sse.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add web/src/assistant/sse.ts web/src/assistant/sse.test.ts
git commit -m "pkm-wn2s: web SSE parser for assistant events"
```

### Task 9: Web assistant API client (`web/src/assistant/client.ts`)

**Files:**
- Create: `web/src/assistant/client.ts`
- Test: `web/src/assistant/client.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError` from `web/src/api/client.ts`; `createSseParser`, `AssistantEvent` (Task 8).
- Produces: `createConversation(model: string | null): Promise<{ id: string; model: string }>`; `deleteConversation(id: string): Promise<void>`; `confirmTool(id: string, toolUseId: string, allow: boolean): Promise<void>`; `streamMessage(id: string, text: string, onEvent: (ev: AssistantEvent) => void): Promise<void>` — resolves when the stream ends; throws `ApiError` on non-OK; redirects to `/login` on 401 (mirrors `apiFetch`, which can't stream because it calls `res.json()`).

- [ ] **Step 1: Write the failing test**

`web/src/assistant/client.test.ts` (jsdom; stub global `fetch`):

```typescript
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
import { streamMessage } from "./client";

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("streamMessage", () => {
  test("POSTs the text and forwards parsed events", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sseResponse([
          'event: text_delta\ndata: {"text": "he"}\n\n',
          'event: text_delta\ndata: {"text": "y"}\n\nevent: turn_done\ndata: {"usage": null}\n\n',
        ]),
      );
    const seen: string[] = [];
    await streamMessage("c1", "hi", (ev) => seen.push(ev.type));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assistant/conversations/c1/messages",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    expect(seen).toEqual(["text_delta", "text_delta", "turn_done"]);
  });

  test("throws ApiError on non-OK status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(streamMessage("c1", "hi", () => {})).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/assistant/client.test.ts`
Expected: FAIL — cannot resolve `./client`

- [ ] **Step 3: Write the implementation**

`web/src/assistant/client.ts`:

```typescript
// pattern: Imperative Shell
// HTTP client for /api/assistant/*. streamMessage bypasses apiFetch because
// apiFetch consumes res.json(); it replicates apiFetch's 401 handling.

import { ApiError, apiFetch } from "../api/client";
import { createSseParser, type AssistantEvent } from "./sse";

export async function createConversation(
  model: string | null,
): Promise<{ id: string; model: string }> {
  return apiFetch("/api/assistant/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(model ? { model } : {}),
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await apiFetch(`/api/assistant/conversations/${id}`, { method: "DELETE" });
}

export async function confirmTool(
  id: string,
  toolUseId: string,
  allow: boolean,
): Promise<void> {
  await apiFetch(`/api/assistant/conversations/${id}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool_use_id: toolUseId, allow }),
  });
}

export async function streamMessage(
  id: string,
  text: string,
  onEvent: (ev: AssistantEvent) => void,
): Promise<void> {
  const path = `/api/assistant/conversations/${id}/messages`;
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (res.status === 401) {
    window.location.assign("/login");
    throw new ApiError(401, path);
  }
  if (!res.ok || !res.body) throw new ApiError(res.status, path);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(ev);
  }
}
```

NOTE: check `web/src/api/client.ts` exports — if `ApiError`'s constructor signature differs (e.g. `(status, path, message?)`), match it. If `apiFetch`'s 401 hook is exported (an `onUnauthorized` setter), call that instead of `window.location.assign`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run src/assistant/client.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add web/src/assistant/client.ts web/src/assistant/client.test.ts
git commit -m "pkm-wn2s: web assistant API client with SSE streaming"
```

### Task 10: `useAssistant` hook

**Files:**
- Create: `web/src/assistant/useAssistant.ts`
- Test: `web/src/assistant/useAssistant.test.tsx`

**Interfaces:**
- Consumes: Task 9 client functions, `AssistantEvent` (Task 8).
- Produces:

```typescript
export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; summary: string; done: boolean };

export type PendingConfirm = { toolUseId: string; opsPreview: string };

export function useAssistant(): {
  items: ChatItem[];
  status: "idle" | "busy" | "confirm";
  error: string | null;
  model: string;                       // "sonnet" | "opus" | "haiku"
  setModel(model: string): void;
  modelLocked: boolean;                // true once the conversation has messages
  pendingConfirm: PendingConfirm | null;
  send(text: string): Promise<void>;   // creates the conversation lazily
  respondConfirm(allow: boolean): Promise<void>;
  newChat(): Promise<void>;
};
```

Task 11 consumes exactly this shape.

- [ ] **Step 1: Write the failing test**

`web/src/assistant/useAssistant.test.tsx`. Convention: no `renderHook` in this codebase — use a Harness component (see `src/components/ConfirmDialog.test.tsx`). Mock the client module.

```tsx
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AssistantEvent } from "./sse";

const mocks = vi.hoisted(() => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  confirmTool: vi.fn(),
  streamMessage: vi.fn(),
}));
vi.mock("./client", () => mocks);

import { useAssistant } from "./useAssistant";

let latest: ReturnType<typeof useAssistant>;
function Harness() {
  latest = useAssistant();
  return <div data-testid="status">{latest.status}</div>;
}

afterEach(() => vi.clearAllMocks());

function feed(events: AssistantEvent[]) {
  mocks.streamMessage.mockImplementation(
    async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
      for (const ev of events) onEvent(ev);
    },
  );
}

describe("useAssistant", () => {
  test("send creates conversation lazily and accumulates deltas", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([
      { type: "text_delta", text: "he" },
      { type: "text_delta", text: "y" },
      { type: "turn_done", usage: null },
    ]);
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(mocks.createConversation).toHaveBeenCalledWith("sonnet");
    expect(latest.items).toEqual([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hey" },
    ]);
    expect(latest.status).toBe("idle");
    expect(latest.modelLocked).toBe(true);

    // second send reuses the conversation
    await act(() => latest.send("again"));
    expect(mocks.createConversation).toHaveBeenCalledTimes(1);
  });

  test("tool events render as tool items", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([
      { type: "tool_started", name: "search", summary: 'searching "x"' },
      { type: "tool_finished", name: "search" },
      { type: "text_delta", text: "found" },
      { type: "turn_done", usage: null },
    ]);
    render(<Harness />);
    await act(() => latest.send("find x"));
    expect(latest.items).toEqual([
      { kind: "user", text: "find x" },
      { kind: "tool", name: "search", summary: 'searching "x"', done: true },
      { kind: "assistant", text: "found" },
    ]);
  });

  test("confirm_request pauses, respondConfirm answers", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    let release!: () => void;
    mocks.streamMessage.mockImplementation(
      async (_id: string, _text: string, onEvent: (ev: AssistantEvent) => void) => {
        onEvent({ type: "confirm_request", tool_use_id: "t1", ops_preview: "save_note(...)" });
        await new Promise<void>((r) => (release = r));
        onEvent({ type: "text_delta", text: "Saved." });
        onEvent({ type: "turn_done", usage: null });
      },
    );
    mocks.confirmTool.mockResolvedValue(undefined);
    render(<Harness />);
    let sendDone!: Promise<void>;
    await act(async () => {
      sendDone = latest.send("please write");
      await Promise.resolve();
    });
    expect(latest.status).toBe("confirm");
    expect(latest.pendingConfirm).toEqual({ toolUseId: "t1", opsPreview: "save_note(...)" });
    await act(async () => {
      await latest.respondConfirm(true);
      release();
      await sendDone;
    });
    expect(mocks.confirmTool).toHaveBeenCalledWith("c1", "t1", true);
    expect(latest.status).toBe("idle");
    expect(latest.pendingConfirm).toBeNull();
  });

  test("error event surfaces and unlocks", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    feed([{ type: "error", message: "boom" }]);
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(latest.error).toBe("boom");
    expect(latest.status).toBe("idle");
  });

  test("newChat deletes and resets", async () => {
    mocks.createConversation.mockResolvedValue({ id: "c1", model: "sonnet" });
    mocks.deleteConversation.mockResolvedValue(undefined);
    feed([{ type: "turn_done", usage: null }]);
    render(<Harness />);
    await act(() => latest.send("hi"));
    await act(() => latest.newChat());
    expect(mocks.deleteConversation).toHaveBeenCalledWith("c1");
    expect(latest.items).toEqual([]);
    expect(latest.modelLocked).toBe(false);
  });

  test("send failure surfaces error", async () => {
    mocks.createConversation.mockRejectedValue(new Error("cap reached"));
    render(<Harness />);
    await act(() => latest.send("hi"));
    expect(latest.error).toContain("cap reached");
    expect(latest.status).toBe("idle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/assistant/useAssistant.test.tsx`
Expected: FAIL — cannot resolve `./useAssistant`

- [ ] **Step 3: Write the implementation**

`web/src/assistant/useAssistant.ts`:

```typescript
// pattern: Imperative Shell
// Chat state for the assistant panel: lazy conversation, SSE-driven items.

import { useCallback, useRef, useState } from "react";
import { confirmTool, createConversation, deleteConversation, streamMessage } from "./client";
import type { AssistantEvent } from "./sse";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; summary: string; done: boolean };

export type PendingConfirm = { toolUseId: string; opsPreview: string };

export function useAssistant() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState<"idle" | "busy" | "confirm">("idle");
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("sonnet");
  const [modelLocked, setModelLocked] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const conversationId = useRef<string | null>(null);

  const applyEvent = useCallback((ev: AssistantEvent) => {
    switch (ev.type) {
      case "text_delta":
        setItems((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "assistant") {
            return [...prev.slice(0, -1), { kind: "assistant", text: last.text + ev.text }];
          }
          return [...prev, { kind: "assistant", text: ev.text }];
        });
        break;
      case "tool_started":
        setItems((prev) => [...prev, { kind: "tool", name: ev.name, summary: ev.summary, done: false }]);
        break;
      case "tool_finished":
        setItems((prev) =>
          prev.map((item) =>
            item.kind === "tool" && item.name === ev.name && !item.done
              ? { ...item, done: true }
              : item,
          ),
        );
        break;
      case "confirm_request":
        setPendingConfirm({ toolUseId: ev.tool_use_id, opsPreview: ev.ops_preview });
        setStatus("confirm");
        break;
      case "turn_done":
        break;
      case "error":
        setError(ev.message);
        break;
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setError(null);
      setStatus("busy");
      setItems((prev) => [...prev, { kind: "user", text }]);
      try {
        if (conversationId.current === null) {
          const created = await createConversation(model);
          conversationId.current = created.id;
        }
        setModelLocked(true);
        await streamMessage(conversationId.current, text, applyEvent);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingConfirm(null);
        setStatus("idle");
      }
    },
    [applyEvent, model],
  );

  const respondConfirm = useCallback(async (allow: boolean) => {
    const id = conversationId.current;
    const pending = pendingConfirm;
    if (id === null || pending === null) return;
    setPendingConfirm(null);
    setStatus("busy");
    await confirmTool(id, pending.toolUseId, allow);
  }, [pendingConfirm]);

  const newChat = useCallback(async () => {
    const id = conversationId.current;
    conversationId.current = null;
    setItems([]);
    setError(null);
    setStatus("idle");
    setPendingConfirm(null);
    setModelLocked(false);
    if (id !== null) {
      try {
        await deleteConversation(id);
      } catch {
        // server may have reaped it already; a fresh chat is the goal
      }
    }
  }, []);

  return {
    items, status, error, model, setModel, modelLocked, pendingConfirm,
    send, respondConfirm, newChat,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && pnpm vitest run src/assistant/useAssistant.test.tsx`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add web/src/assistant/useAssistant.ts web/src/assistant/useAssistant.test.tsx
git commit -m "pkm-wn2s: useAssistant hook (lazy conversation, confirm flow)"
```

### Task 11: `AssistantPanel` component + styles

**Files:**
- Create: `web/src/assistant/AssistantPanel.tsx`
- Modify: `web/src/styles.css` (append panel styles)
- Test: `web/src/assistant/AssistantPanel.test.tsx`

**Interfaces:**
- Consumes: `useAssistant` (Task 10); `tokenizeBlock` (`web/src/grammar/tokenize.ts`), `InlineSegments` (`web/src/components/InlineSegments.tsx`) for message rendering; tokens `--radius-panel`, `.btn-secondary`, `.btn-danger`.
- Produces: `export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null`. Task 12 consumes this.

**Layout:** fixed bottom-right card (not a route, not modal — no backdrop), `z-index: 60` (above block menu, below full-screen modals at 1000). Header: title, model `<select>` (disabled when `modelLocked`), "New chat" button, close `×`. Scrollable message list; tool items as subdued one-liners; confirm card with ops preview in `<pre>` + Allow (`.btn-secondary`) / Deny (`.btn-danger`); `<textarea>` + Send. Enter sends (Shift+Enter newline). Esc inside the panel closes it (root `onKeyDown`, NOT a window listener — window Esc would steal editor/dialog escapes).

- [ ] **Step 1: Write the failing test**

`web/src/assistant/AssistantPanel.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatItem, PendingConfirm } from "./useAssistant";

const state = vi.hoisted(() => ({
  current: {
    items: [] as ChatItem[],
    status: "idle" as "idle" | "busy" | "confirm",
    error: null as string | null,
    model: "sonnet",
    setModel: vi.fn(),
    modelLocked: false,
    pendingConfirm: null as PendingConfirm | null,
    send: vi.fn().mockResolvedValue(undefined),
    respondConfirm: vi.fn().mockResolvedValue(undefined),
    newChat: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("./useAssistant", () => ({ useAssistant: () => state.current }));

import { AssistantPanel } from "./AssistantPanel";

afterEach(() => {
  vi.clearAllMocks();
  state.current.items = [];
  state.current.status = "idle";
  state.current.error = null;
  state.current.modelLocked = false;
  state.current.pendingConfirm = null;
});

describe("AssistantPanel", () => {
  test("renders nothing when closed", () => {
    const { container } = render(<AssistantPanel open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders messages and tool lines", () => {
    state.current.items = [
      { kind: "user", text: "find x" },
      { kind: "tool", name: "search", summary: 'searching "x"', done: true },
      { kind: "assistant", text: "Found **it**" },
    ];
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("find x")).toBeInTheDocument();
    expect(screen.getByText(/searching "x"/)).toBeInTheDocument();
    expect(screen.getByText("it")).toBeInTheDocument(); // bold rendered via InlineSegments
  });

  test("Enter sends, Shift+Enter does not", () => {
    render(<AssistantPanel open onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/ask about your notes/i);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(state.current.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(state.current.send).toHaveBeenCalledWith("hello");
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  test("confirm card wires Allow and Deny", () => {
    state.current.status = "confirm";
    state.current.pendingConfirm = { toolUseId: "t1", opsPreview: "save_note(title=Demo)" };
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText("save_note(title=Demo)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(state.current.respondConfirm).toHaveBeenCalledWith(false);
  });

  test("model select locked after first message; New chat unlocks via hook", () => {
    state.current.modelLocked = true;
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByLabelText(/model/i)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    expect(state.current.newChat).toHaveBeenCalled();
  });

  test("Escape inside panel closes it", () => {
    const onClose = vi.fn();
    render(<AssistantPanel open onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/ask about your notes/i), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  test("shows error line", () => {
    state.current.error = "cap reached";
    render(<AssistantPanel open onClose={() => {}} />);
    expect(screen.getByText(/cap reached/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run src/assistant/AssistantPanel.test.tsx`
Expected: FAIL — cannot resolve `./AssistantPanel`

- [ ] **Step 3: Write the component**

`web/src/assistant/AssistantPanel.tsx`:

```tsx
// pattern: Imperative Shell
// Floating assistant chat panel (bottom-right overlay; not a route).

import { useEffect, useRef, useState } from "react";
import { InlineSegments } from "../components/InlineSegments";
import { tokenizeBlock } from "../grammar/tokenize";
import { useAssistant } from "./useAssistant";

const MODELS = ["sonnet", "opus", "haiku"];

export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const assistant = useAssistant();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [assistant.items, assistant.pendingConfirm]);

  if (!open) return null;

  const submit = () => {
    const text = draft.trim();
    if (!text || assistant.status !== "idle") return;
    setDraft("");
    void assistant.send(text);
  };

  return (
    <section
      className="assistant-panel"
      aria-label="Assistant"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="assistant-header">
        <span className="assistant-title">Assistant</span>
        <label className="assistant-model">
          model
          <select
            aria-label="model"
            value={assistant.model}
            disabled={assistant.modelLocked}
            onChange={(e) => assistant.setModel(e.target.value)}
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={() => void assistant.newChat()}>
          New chat
        </button>
        <button type="button" className="assistant-close" aria-label="Close assistant" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="assistant-messages" ref={listRef}>
        {assistant.items.map((item, i) =>
          item.kind === "tool" ? (
            <div key={i} className="assistant-tool-line">
              {item.done ? "✓" : "…"} {item.summary}
            </div>
          ) : (
            <div key={i} className={`assistant-msg assistant-msg-${item.kind}`}>
              {item.kind === "assistant" ? (
                <InlineSegments segments={tokenizeBlock(item.text)} />
              ) : (
                item.text
              )}
            </div>
          ),
        )}
        {assistant.pendingConfirm && (
          <div className="assistant-confirm-card">
            <div className="assistant-confirm-title">The assistant wants to write:</div>
            <pre>{assistant.pendingConfirm.opsPreview}</pre>
            <div className="assistant-confirm-actions">
              <button type="button" className="btn-secondary" onClick={() => void assistant.respondConfirm(true)}>
                Allow
              </button>
              <button type="button" className="btn-danger" onClick={() => void assistant.respondConfirm(false)}>
                Deny
              </button>
            </div>
          </div>
        )}
        {assistant.error && <div className="assistant-error">{assistant.error}</div>}
        {assistant.status === "busy" && <div className="assistant-tool-line">thinking…</div>}
      </div>
      <div className="assistant-input">
        <textarea
          placeholder="Ask about your notes…"
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={assistant.status !== "idle"}
          onClick={submit}
        >
          Send
        </button>
      </div>
    </section>
  );
}
```

NOTE: check `InlineSegments`'s actual prop name/signature in `web/src/components/InlineSegments.tsx` before use (`segments={tokenizeBlock(text)}` per `BlockTree.tsx:66`); if it needs extra props (e.g. a navigate handler), copy the minimal usage from `BlockTree.tsx`.

- [ ] **Step 4: Append styles**

Append to `web/src/styles.css` (dark theme comes free via tokens):

```css
/* Assistant panel */
.assistant-panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  width: min(420px, calc(100vw - 32px));
  height: min(560px, calc(100vh - 32px));
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  box-shadow: 0 4px 14px rgba(var(--shadow-rgb), 0.15);
}
.assistant-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
}
.assistant-title { font-weight: 600; margin-right: auto; }
.assistant-model { display: flex; align-items: center; gap: 4px; font-size: 0.85em; color: var(--color-text-secondary); }
.assistant-close { background: none; border: none; font-size: 1.2em; cursor: pointer; color: var(--color-text-secondary); }
.assistant-messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.assistant-msg { white-space: pre-wrap; overflow-wrap: anywhere; }
.assistant-msg-user { align-self: flex-end; background: var(--color-bg-hover, rgba(127, 127, 127, 0.12)); border-radius: var(--radius-card); padding: 6px 10px; max-width: 85%; }
.assistant-tool-line { font-size: 0.85em; color: var(--color-text-secondary); font-style: italic; }
.assistant-confirm-card { border: 1px solid var(--color-border-input); border-radius: var(--radius-card); padding: 10px; }
.assistant-confirm-title { font-weight: 600; margin-bottom: 6px; }
.assistant-confirm-card pre { overflow-x: auto; font-size: 0.85em; margin: 0 0 8px; }
.assistant-confirm-actions { display: flex; gap: 8px; }
.assistant-error { color: var(--color-danger, #c62828); font-size: 0.9em; }
.assistant-input { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--color-border); }
.assistant-input textarea { flex: 1; resize: none; border: 1px solid var(--color-border-input); border-radius: var(--radius-control); padding: 6px 8px; background: inherit; color: inherit; font: inherit; }
```

Check `styles.css` for the real names of hover/danger color tokens (`--color-bg-hover`, `--color-danger` are guesses with fallbacks — replace with the file's actual tokens if present).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && pnpm vitest run src/assistant/AssistantPanel.test.tsx`
Expected: 7 passed

- [ ] **Step 6: Commit**

```bash
git add web/src/assistant/AssistantPanel.tsx web/src/assistant/AssistantPanel.test.tsx web/src/styles.css
git commit -m "pkm-wn2s: assistant floating panel component"
```

### Task 12: App wiring — Cmd/Ctrl+J, sidebar entry, keyboard.md

**Files:**
- Modify: `web/src/App.tsx` (state ~line 38-44, keydown effect ~lines 88-103, sidebar secondary section ~line 138-146, render panel near `<UndoRedoKeys/>` ~line 116)
- Modify: `docs/keyboard.md` (row in the "Anywhere in the app" table, lines 11-16)
- Test: `web/src/App.test.tsx` if an App-level test exists — otherwise covered by the e2e in Task 13 (check for existing App tests first and extend them rather than adding a new harness)

**Interfaces:**
- Consumes: `AssistantPanel` (Task 11).

- [ ] **Step 1: Wire state + shortcut + panel in `App.tsx`**

Add state next to `navOpen`/`sidebarHidden`:

```tsx
const [assistantOpen, setAssistantOpen] = useState(false);
```

Add a branch inside the existing `window.addEventListener("keydown", …)` effect (same shape as the Cmd+/ branch; keep the dep array correct):

```tsx
if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
  e.preventDefault();
  setAssistantOpen((o) => !o);
}
```

Render the panel once, outside the router content (near `<UndoRedoKeys/>`):

```tsx
<AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
```

- [ ] **Step 2: Sidebar entry above Settings**

In the secondary section (between `<SidebarNav/>` and the Settings NavLink), matching the `.nav-link`-on-button precedent from `SidebarNav.tsx`:

```tsx
<button
  type="button"
  className="nav-link"
  onClick={() => {
    setAssistantOpen(true);
    setNavOpen(false);
  }}
>
  Assistant
</button>
```

- [ ] **Step 3: Document the shortcut**

Add to the "Anywhere in the app" table in `docs/keyboard.md`:

```markdown
| Cmd+J (or Ctrl+J) | Show / hide the assistant panel |
```

(The Help page renders keyboard.md automatically. NOTE: the drift-guard test covers slash commands only, not key chords — this row is convention, no test forces it, so do not skip it.)

- [ ] **Step 4: Verify**

Run: `cd web && pnpm typecheck && pnpm test:unit`
Expected: clean; no unit regressions (Help page tests re-parse keyboard.md — they must still pass).

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx docs/keyboard.md
git commit -m "pkm-wn2s: Cmd/Ctrl+J assistant toggle + sidebar entry + keyboard doc"
```

### Task 13: Playwright e2e against the FakeEngine

**Files:**
- Modify: `server/tests/e2e_serve.py` (wire the FakeEngine — e2e must never spawn a real harness)
- Create: `web/e2e/assistant.spec.ts`

**Interfaces:**
- Consumes: `FakeEngine` (Task 3 — `e2e_serve.py` runs from `server/tests/`, so `from fake_engine import FakeEngine` resolves), `create_app(..., assistant_engine=...)` (Task 5). FakeEngine script strings: send `"please write"` → confirm card; anything else → `echo: <text>`.

- [ ] **Step 1: Wire the FakeEngine into the e2e server**

In `server/tests/e2e_serve.py`, find the `create_app(config)` call and change it to:

```python
from fake_engine import FakeEngine

...
app = create_app(config, assistant_engine=FakeEngine())
```

(Match the file's actual structure; the point is: e2e always uses the fake.)

- [ ] **Step 2: Write the e2e spec**

`web/e2e/assistant.spec.ts` — import from `./fixtures` (fails on 5xx), copy the login pattern from an existing spec (e.g. `edit.spec.ts`), and do NOT write to today's journal:

```typescript
import { expect, test } from "./fixtures";

// login helper: copy the exact beforeEach/login pattern used by edit.spec.ts

test("assistant panel: toggle, echo turn, confirm allow/deny", async ({ page }) => {
  await page.goto("/");
  // ... login as in other specs ...

  // open via keyboard
  await page.keyboard.press("ControlOrMeta+j");
  const panel = page.getByRole("region", { name: "Assistant" });
  await expect(panel).toBeVisible();

  // model dropdown enabled before first message
  await expect(panel.getByLabel("model")).toBeEnabled();

  // echo turn
  await panel.getByPlaceholder(/ask about your notes/i).fill("hello there");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("echo: hello there")).toBeVisible();
  await expect(panel.getByLabel("model")).toBeDisabled();

  // confirm flow: deny
  await panel.getByPlaceholder(/ask about your notes/i).fill("please write");
  await page.keyboard.press("Enter");
  await expect(panel.getByText('save_note(title="Demo")')).toBeVisible();
  await panel.getByRole("button", { name: "Deny" }).click();
  await expect(panel.getByText("Okay, not saving.")).toBeVisible();

  // confirm flow: allow
  await panel.getByPlaceholder(/ask about your notes/i).fill("please write");
  await page.keyboard.press("Enter");
  await panel.getByRole("button", { name: "Allow" }).click();
  await expect(panel.getByText("Saved.")).toBeVisible();

  // Esc closes (focus is inside the panel textarea)
  await panel.getByPlaceholder(/ask about your notes/i).click();
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();

  // sidebar entry reopens
  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(page.getByRole("region", { name: "Assistant" })).toBeVisible();
});
```

Adjust selectors to what Tasks 11–12 actually rendered; keep assertions. If `ControlOrMeta+j` is not supported by the installed Playwright, use `process.platform === "darwin" ? "Meta+j" : "Control+j"`.

- [ ] **Step 3: Build and run the spec**

```bash
cd web && pnpm build && npx playwright test e2e/assistant.spec.ts
```

Expected: PASS. (e2e serves `web/dist` — stale dist gives false results, so build first. Use `E2E_PORT` if 8975 is taken.)

- [ ] **Step 4: Commit**

```bash
git add server/tests/e2e_serve.py web/e2e/assistant.spec.ts
git commit -m "pkm-wn2s: e2e for assistant panel against FakeEngine"
```

### Task 14: Security + deploy documentation

**Files:**
- Modify: `docs/SECURITY.md` (append assistant threat-model section)
- Modify: `deploy/README.md` (prod prerequisites note)

- [ ] **Step 1: SECURITY.md addendum**

Append to `docs/SECURITY.md`:

```markdown
## Embedded assistant (pkm-wn2s)

The assistant runs entirely server-side: the browser talks only to
`/api/assistant/*`, which sits behind the same `pkm_session` cookie auth as
every other API route. Provider credentials never reach the browser; the
Claude Agent SDK harness uses the service user's Claude Code login.

Threat model:

- **Prompt injection.** Note content is untrusted input to the model. The
  blast radius of a fully injected model is the ten PKM MCP tools — the
  harness runs with all built-in tools disabled (no shell, filesystem, or
  web access) and `setting_sources=[]`, so filesystem settings/CLAUDE.md
  are ignored.
- **Write gating.** The four write verbs (`save_note`, `update_block`,
  `batch`, `upload_asset`) each require explicit per-call confirmation in
  the UI before executing; denial is reported to the model as a declined
  action.
- **Subprocess auth.** Each conversation mints a fresh `pkm_session` token,
  written to a 0600 config file passed via `PKM_CLI_CONFIG` and pointing at
  the loopback listener; the file is deleted when the conversation closes.
  The token is a standard session token (1-year validity) — deleting it
  from disk does not revoke it, same as any logged-in session.
- **Resource caps.** At most 3 concurrent conversations; idle conversations
  are reaped after ~15 minutes; conversations do not survive a server
  restart.
```

- [ ] **Step 2: deploy/README.md note**

Append:

```markdown
## Assistant prerequisites

The embedded assistant (pkm-wn2s) spawns the `claude` CLI via the Claude
Agent SDK. The launchd service user therefore needs:

- `node` on PATH and the `claude` CLI installed (`~/.local/bin/claude`)
- a logged-in Claude subscription (`claude /login` as the service user);
  credentials resolve from `~/.claude` / the login Keychain, so the launchd
  plist must run as that user with `HOME` set (it already does)
- no `ANTHROPIC_API_KEY` in the service environment (it would override the
  subscription login and bill per-token)

If the login is missing the assistant returns an error event in-chat; the
rest of the app is unaffected.
```

- [ ] **Step 3: Commit**

```bash
git add docs/SECURITY.md deploy/README.md
git commit -m "pkm-wn2s: document assistant threat model + deploy prerequisites"
```

### Task 15: Final verification + bean completion

- [ ] **Step 1: Full server gates**

```bash
cd server && uv run pytest -q && uv run pyrefly check && uv run ruff check
```

Expected: all green, coverage ≥95%.

- [ ] **Step 2: Full web gates**

```bash
cd web && pnpm verify
```

Expected: typecheck, eslint, fcis (new `web/src/assistant/*` files need their `// pattern:` headers), unit coverage (95/91/89/95), build, and Playwright all green. Known flakes: `lintConfig.test`, `link-reference.spec` — rerun once before investigating.

- [ ] **Step 3: Manual smoke against a dev server (real engine)**

Start a dev server on a scratch port (NOT 8974), open the app, press Cmd+J, run one retrieval question on `haiku`, and one write request (confirm card must appear; test both Allow and Deny). Verify the model dropdown locks after the first message and New chat unlocks it.

- [ ] **Step 4: Update the bean and complete**

```bash
beans update pkm-wn2s -s completed --body-append "## Summary of Changes
..."
```

Include: what shipped, the FakeEngine test strategy, the manual smoke result, and follow-up beans to offer: (a) OpenAI/Codex second engine, (b) persistent conversation history, (c) network-facing streamable-HTTP MCP endpoint, (d) Settings-page configuration.

- [ ] **Step 5: Merge per finishing-a-development-branch**

Merge the worktree branch with `git merge --no-ff`, run the full gates once more on main, push. Deploy is a separate user decision (prod needs the `claude` login prerequisite from Task 14 verified first).

