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


def test_full_cap_evicts_oldest_idle_instead_of_raising():
    # pkm-c98s item 1: a page reload orphans a conversation id client-side
    # without deleting it server-side; three reloads used to exhaust the cap
    # and 409 the next create for up to idle_ttl. Evicting the
    # least-recently-used idle conversation avoids that lockout.
    clock = FakeClock()
    engine = FakeEngine()
    service = AssistantService(engine, max_conversations=3, idle_ttl=900.0, clock=clock)

    async def scenario():
        cid1, _ = await service.create(None)
        clock.now += 1.0
        await service.create(None)
        clock.now += 1.0
        await service.create(None)
        clock.now += 1.0
        cid4, _ = await service.create(None)  # cap reached, well under idle_ttl
        return cid1, cid4

    cid1, cid4 = asyncio.run(scenario())
    assert cid1 != cid4
    assert cid1 not in service._entries  # oldest evicted
    assert cid4 in service._entries
    assert len(service._entries) == 3
    assert engine.conversations[0].closed is True  # the evicted one, specifically


def test_full_cap_raises_when_every_conversation_is_busy():
    engine = FakeEngine()
    service = AssistantService(engine, max_conversations=2)

    async def scenario():
        cid1, _ = await service.create(None)
        cid2, _ = await service.create(None)
        stream1 = service.send(cid1, "please write")
        stream2 = service.send(cid2, "please write")
        await anext(stream1)  # ToolStarted
        await anext(stream1)  # ConfirmRequest: stream1 now parked mid-turn
        await anext(stream2)
        await anext(stream2)
        with pytest.raises(ConversationLimitError):
            await service.create(None)
        # tidy up the parked turns
        service.confirm(cid1, "fake-confirm-1", False)
        service.confirm(cid2, "fake-confirm-1", False)
        _ = [ev async for ev in stream1]
        _ = [ev async for ev in stream2]

    asyncio.run(scenario())


def test_send_race_second_synchronous_call_raises_busy_immediately():
    # pkm-c98s item 7: two near-simultaneous sends must not both observe
    # "free" -- the reservation happens synchronously in send(), before the
    # returned generator is ever iterated.
    engine = FakeEngine()
    service = AssistantService(engine)

    async def scenario():
        cid, _ = await service.create(None)
        stream = service.send(cid, "hi")  # not iterated yet at all
        with pytest.raises(BusyError):
            service.send(cid, "again")
        return [ev async for ev in stream]

    events = asyncio.run(scenario())
    assert isinstance(events[-1], TurnDone)


def test_busy_flag_cleared_after_turn_completes():
    engine = FakeEngine()
    service = AssistantService(engine)

    async def scenario():
        cid, _ = await service.create(None)
        _ = [ev async for ev in service.send(cid, "hi")]
        # busy must be released so a following send succeeds
        return [ev async for ev in service.send(cid, "again")]

    events = asyncio.run(scenario())
    assert isinstance(events[-1], TurnDone)


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
