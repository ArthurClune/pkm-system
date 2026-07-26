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
