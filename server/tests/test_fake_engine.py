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
        events = []

        async def consume():
            async for ev in conv.send("please write"):
                events.append(ev)
                if isinstance(ev, ConfirmRequest):
                    break

        await asyncio.wait_for(consume(), timeout=5)
        await conv.close()
        return conv

    conv = asyncio.run(scenario())
    assert conv.closed is True
    assert conv.model == "haiku"
