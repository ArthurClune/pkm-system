import asyncio
from collections.abc import AsyncIterator

import pytest

from fake_engine import FakeEngine
from pkm.assistant.engine import ConversationHandle
from pkm.assistant.events import AssistantEvent, ConfirmRequest, TextDelta, TurnDone
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


class _StubHandle:
    def __init__(self) -> None:
        self.closed = False

    def send(self, text: str) -> AsyncIterator[AssistantEvent]:
        async def _gen() -> AsyncIterator[AssistantEvent]:
            return
            yield  # pragma: no cover - never reached, satisfies AsyncIterator

        return _gen()

    def resolve_confirm(self, tool_use_id: str, allow: bool) -> None:
        pass

    async def close(self) -> None:
        self.closed = True


class BarrierEngine:
    """Engine whose create_conversation() can be held open by the test.

    The first `hold` calls block on `gate` (an asyncio.Event the test
    controls) before returning/raising, so a test can pause a creation
    mid-admission and observe whether a second concurrent create() is
    able to reach the engine while the first is still in flight.
    Every entry/exit of create_conversation() is recorded so tests can
    assert the engine is never invoked concurrently by two admissions.
    """

    def __init__(self, *, hold: int = 1, fail_first: bool = False) -> None:
        self.gate = asyncio.Event()
        self._hold = hold
        self._fail_first = fail_first
        self.calls = 0
        self.in_progress = 0
        self.max_concurrent = 0
        self.conversations: list[_StubHandle] = []

    async def create_conversation(self, system_prompt: str, model: str) -> ConversationHandle:
        self.calls += 1
        call_index = self.calls
        self.in_progress += 1
        self.max_concurrent = max(self.max_concurrent, self.in_progress)
        try:
            if call_index <= self._hold:
                await self.gate.wait()
            if self._fail_first and call_index == 1:
                raise RuntimeError("boom")
            handle = _StubHandle()
            self.conversations.append(handle)
            return handle
        finally:
            self.in_progress -= 1


async def _let_event_loop_run(times: int = 3) -> None:
    for _ in range(times):
        await asyncio.sleep(0)


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


# --- pkm-rovq: admission (cap check + eviction + creation) must be serialized ---


def test_concurrent_creates_never_enter_engine_simultaneously():
    # Without a lock, two concurrent create() calls both read the (unchanged)
    # entries dict before either inserts, so both proceed to call the engine
    # at once. This proves the engine is only ever entered by one admission
    # at a time, i.e. admission is fully serialized end to end.
    engine = BarrierEngine(hold=1)
    service = AssistantService(engine, max_conversations=5)

    async def scenario():
        task1 = asyncio.create_task(service.create(None))
        await _let_event_loop_run()  # task1 reaches the engine and blocks on the gate
        task2 = asyncio.create_task(service.create(None))
        await _let_event_loop_run()  # task2 must block on the admission lock, not the engine
        assert engine.calls == 1  # task2 has not entered the engine yet
        engine.gate.set()
        cid1, _ = await task1
        cid2, _ = await task2
        return cid1, cid2

    cid1, cid2 = asyncio.run(scenario())
    assert cid1 != cid2
    assert engine.max_concurrent == 1  # engine was never entered concurrently
    assert engine.calls == 2
    assert len(service._entries) == 2


def test_cap_never_exceeded_across_a_pending_creation():
    # pkm-rovq: with max_conversations=1 and no existing entries, two
    # concurrent create() calls used to both observe "0 >= 1 is false" and
    # both proceed, ending with 2 entries against a cap of 1. The lock must
    # force the second call to re-check the cap only after the first
    # creation has actually landed (or failed), so it evicts the first
    # conversation instead of exceeding the cap.
    engine = BarrierEngine(hold=1)
    service = AssistantService(engine, max_conversations=1)

    async def scenario():
        task1 = asyncio.create_task(service.create(None))
        await _let_event_loop_run()  # task1 is blocked inside the engine, holding the lock
        task2 = asyncio.create_task(service.create(None))
        await _let_event_loop_run()
        # task2 cannot have observed free capacity yet: it is stuck behind
        # the lock, and the engine has not been entered a second time.
        assert engine.calls == 1
        assert len(service._entries) == 0  # task1 hasn't inserted its entry yet either
        engine.gate.set()
        cid1, _ = await task1
        cid2, _ = await task2
        return cid1, cid2

    cid1, cid2 = asyncio.run(scenario())
    assert cid1 != cid2
    assert engine.max_concurrent == 1
    # cap of 1 was never exceeded: task2's admission evicted task1's
    # (idle) conversation rather than creating a second one alongside it.
    assert len(service._entries) == 1
    assert cid1 not in service._entries
    assert cid2 in service._entries
    assert engine.conversations[0].closed is True


def test_failed_creation_releases_the_admission_lock():
    engine = BarrierEngine(hold=1, fail_first=True)
    service = AssistantService(engine, max_conversations=1)
    engine.gate.set()  # don't block; fail immediately once entered

    async def scenario():
        with pytest.raises(RuntimeError, match="boom"):
            await service.create(None)
        # a failed creation must not leave the lock held forever
        return await asyncio.wait_for(service.create(None), timeout=1.0)

    cid, _ = asyncio.run(scenario())
    assert cid
    assert len(service._entries) == 1


def test_cancelled_creation_releases_the_admission_lock():
    engine = BarrierEngine(hold=1)  # gate never set: first call blocks forever
    service = AssistantService(engine, max_conversations=1)

    async def scenario():
        task1 = asyncio.create_task(service.create(None))
        await _let_event_loop_run()  # task1 is now parked inside the engine call
        task1.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task1
        # a cancelled creation must not leave the lock held forever
        return await asyncio.wait_for(service.create(None), timeout=1.0)

    cid, _ = asyncio.run(scenario())
    assert cid
    assert len(service._entries) == 1
