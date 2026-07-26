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
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from pkm.assistant.claude_engine import ClaudeEngine, TurnMapper
from pkm.assistant.events import ConfirmRequest, ErrorEvent, TextDelta, ToolFinished, ToolStarted, TurnDone
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
    assert opts.max_turns == 40
    assert opts.env == {"ENABLE_TOOL_SEARCH": "false"}
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
        assert isinstance(ev, ConfirmRequest)
        conv.resolve_confirm(ev.tool_use_id, False)
        decision = await asyncio.wait_for(task, timeout=5)
        _ = [e async for e in stream]
        await conv.close()
        return decision

    decision = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultDeny)
    assert "declined" in decision.message


def test_close_during_live_turn_unblocks_consumer(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        # FakeSDKClient.receive_response() blocks on its empty queue, just
        # like the real SDK blocks waiting on the CLI subprocess.
        events: list = []

        async def consume():
            async for ev in conv.send("hi"):
                events.append(ev)

        consumer = asyncio.create_task(consume())
        # let the pump task start and reach the blocking receive_response()
        for _ in range(3):
            await asyncio.sleep(0)
        await conv.close()
        await asyncio.wait_for(consumer, timeout=5)
        return events

    events = asyncio.run(scenario())
    assert events
    assert events[-1] == ErrorEvent(message="conversation closed")


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


def test_send_drains_stale_queue_events(tmp_path):
    """A leftover event from an abandoned turn (e.g. a dropped SSE stream)
    must not leak into the next turn's output."""
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        conv._queue.put_nowait(TextDelta(text="stale"))
        client.feed(
            AssistantMessage(content=[TextBlock(text="fresh")], model="sonnet"),
            make_result(),
        )
        events = [ev async for ev in conv.send("hi")]
        await conv.close()
        return events

    events = asyncio.run(scenario())
    assert TextDelta(text="stale") not in events
    assert TextDelta(text="fresh") in events
    assert isinstance(events[-1], TurnDone)


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


def test_turn_mapper_emits_tool_finished_from_tool_result():
    mapper = TurnMapper()
    assistant_msg = AssistantMessage(
        content=[ToolUseBlock(id="t1", name="mcp__pkm__search", input={"q": "alpha"})],
        model="sonnet",
    )
    assert mapper.map(assistant_msg) == [ToolStarted(name="search", summary='searching "alpha"')]

    user_msg = UserMessage(content=[ToolResultBlock(tool_use_id="t1", content="ok")])
    assert mapper.map(user_msg) == [ToolFinished(name="search")]

    # an unrecognised tool_use_id (e.g. mapper created fresh mid-turn) falls back to "tool"
    unknown_msg = UserMessage(content=[ToolResultBlock(tool_use_id="unknown", content="ok")])
    assert mapper.map(unknown_msg) == [ToolFinished(name="tool")]

    # a plain string UserMessage (no tool results) maps to nothing
    assert mapper.map(UserMessage(content="hi")) == []
