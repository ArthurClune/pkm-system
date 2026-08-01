import asyncio
import contextlib
import logging
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
    _Entry,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class _StubHandle:
    def __init__(self, *, hang_close: bool = False, unhealthy_after_interrupt: bool = False) -> None:
        self.closed = False
        self.healthy = True
        self._hang_close = hang_close
        # Models what claude_engine.ClaudeConversation.send() does for real:
        # a turn that blocks (as a live turn does) until the consumer drops,
        # at which point cleanup attempts an interrupt that never lands, and
        # the handle goes unhealthy. Blocking rather than returning early
        # matters here (pkm-mbcc lesson): a fake that resolves immediately
        # never exercises the cancellation-triggered cleanup path.
        self._unhealthy_after_interrupt = unhealthy_after_interrupt

    def send(self, text: str) -> AsyncIterator[AssistantEvent]:
        async def _gen() -> AsyncIterator[AssistantEvent]:
            if self._unhealthy_after_interrupt:
                try:
                    await asyncio.Event().wait()  # never set: blocks like a live turn
                finally:
                    self.healthy = False
                return
            return
            yield  # pragma: no cover - never reached, satisfies AsyncIterator

        return _gen()

    def resolve_confirm(self, tool_use_id: str, allow: bool) -> None:
        pass

    async def close(self) -> None:
        if self._hang_close:
            await asyncio.Event().wait()  # never set: simulates a wedged harness
        self.closed = True


class BarrierEngine:
    """Engine whose create_conversation() can be held open by the test.

    The first `hold` calls block on `gate` (an asyncio.Event the test
    controls) before returning/raising, so a test can pause a creation
    mid-admission and observe whether a second concurrent create() is
    able to reach the engine while the first is still in flight.
    Every entry/exit of create_conversation() is recorded so tests can
    assert the engine is never invoked concurrently by two admissions.

    `hang_close_first_call`, when set, makes only the handle returned by
    the *first* create_conversation() call hang forever on close() --
    modelling a single wedged harness among otherwise healthy ones, so
    tests can prove that closing it (during reap/eviction) doesn't block
    admission for anyone else.
    """

    def __init__(
        self,
        *,
        hold: int = 1,
        fail_first: bool = False,
        hang_close_first_call: bool = False,
    ) -> None:
        self.gate = asyncio.Event()
        self._hold = hold
        self._fail_first = fail_first
        self._hang_close_first_call = hang_close_first_call
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
            handle = _StubHandle(hang_close=self._hang_close_first_call and call_index == 1)
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


# --- pkm-rwwc: an interrupt that never lands leaves the harness state
# uncertain -- the conversation must be retired, not reused for a later
# turn. ---


async def _drain(stream: AsyncIterator[AssistantEvent]) -> None:
    async for _ in stream:
        pass


def test_second_send_after_failed_interrupt_gets_unknown_conversation():
    engine = FakeEngine()
    service = AssistantService(engine)
    handle = _StubHandle(unhealthy_after_interrupt=True)
    service._entries["broken"] = _Entry(handle=handle, model="sonnet", last_used=service._clock())

    async def scenario():
        stream = service.send("broken", "hi")
        task = asyncio.create_task(_drain(stream))
        for _ in range(3):
            await asyncio.sleep(0)  # let it reach the blocking send()
        task.cancel()  # simulates the SSE consumer dropping mid-turn
        with contextlib.suppress(asyncio.CancelledError):
            await task
        with pytest.raises(UnknownConversationError):
            service.send("broken", "again")

    asyncio.run(scenario())
    assert handle.healthy is False
    assert handle.closed is True
    assert "broken" not in service._entries


def test_healthy_conversation_is_reused_after_a_dropped_turn():
    # control for the test above: a turn abandoned by the consumer is not by
    # itself terminal -- only a handle that actually goes unhealthy should
    # be retired.
    engine = FakeEngine()
    service = AssistantService(engine)
    handle = _StubHandle()
    service._entries["ok"] = _Entry(handle=handle, model="sonnet", last_used=service._clock())

    async def scenario():
        _ = [ev async for ev in service.send("ok", "hi")]

    asyncio.run(scenario())
    assert handle.healthy is True
    assert handle.closed is False
    assert "ok" in service._entries
    # the entry is usable again, not stuck busy or removed
    assert service._entries["ok"].busy is False


def test_concurrent_delete_during_unacknowledged_interrupt_is_not_logged_as_retired(
        caplog):
    # A pagehide-beacon delete() can race the same cid's interrupt-cleanup
    # in _stream's finally: delete() pops and closes it first, so the
    # cleanup's own pop finds nothing (removed=False) and must not close
    # the handle again -- and must not claim it "retired" a conversation
    # that a different code path already tore down.
    engine = FakeEngine()
    service = AssistantService(engine)
    handle = _StubHandle(unhealthy_after_interrupt=True)
    service._entries["broken"] = _Entry(handle=handle, model="sonnet", last_used=service._clock())

    async def scenario():
        stream = service.send("broken", "hi")
        task = asyncio.create_task(_drain(stream))
        for _ in range(3):
            await asyncio.sleep(0)  # let it reach the blocking send()
        await service.delete("broken")  # races the interrupt-cleanup below
        task.cancel()  # simulates the SSE consumer dropping mid-turn
        with contextlib.suppress(asyncio.CancelledError):
            await task

    with caplog.at_level(logging.WARNING, logger="pkm.assistant"):
        asyncio.run(scenario())

    assert handle.closed is True  # closed exactly once, by delete()
    assert "broken" not in service._entries
    assert not any("retired after an unacknowledged interrupt" in r.message
                  for r in caplog.records)


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


# --- pkm-rovq review round 1: neither an unbounded engine.connect() nor an
# unbounded teardown close() of a reaped/evicted conversation may hold the
# admission lock indefinitely and wedge every future create(). ---


def test_hung_engine_connect_times_out_and_releases_the_lock():
    # engine.create_conversation() (the harness subprocess connect) is
    # awaited under the admission lock with a bound: a wedged harness must
    # raise instead of holding the lock -- and therefore every future
    # create() -- forever.
    engine = BarrierEngine(hold=1)  # gate never set: first call blocks forever
    service = AssistantService(engine, max_conversations=1, create_timeout=0.05)

    async def scenario():
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(service.create(None), timeout=1.0)
        # the lock must already be free: a second create() succeeds promptly
        return await asyncio.wait_for(service.create(None), timeout=1.0)

    cid, _ = asyncio.run(scenario())
    assert cid
    assert len(service._entries) == 1


def test_hung_teardown_of_an_evicted_conversation_does_not_block_the_next_admission():
    # The old code closed a reaped/evicted conversation's harness *inside*
    # the admission lock (via delete()). If that close() hangs (a wedged
    # subprocess never acknowledging disconnect), every future create()
    # would block on the lock forever. The fix pops the evicted entry from
    # `_entries` (atomic, under the lock) but defers the actual close()
    # until after the lock is released, so a hung teardown only ever
    # affects the request that triggered it.
    clock = FakeClock()
    engine = BarrierEngine(hold=0, hang_close_first_call=True)
    service = AssistantService(engine, max_conversations=2, clock=clock)

    async def scenario():
        cid1, _ = await service.create(None)  # this handle hangs on close()
        clock.now += 1.0
        cid_a, _ = await service.create(None)  # cap now full (2/2); no eviction yet
        clock.now += 1.0
        # Cap reached: this evicts cid1 (oldest idle), registers a new
        # conversation, then gets stuck in its own teardown closing cid1's
        # (hung) harness. It is expected to never resolve -- exactly the
        # request that triggered the eviction inherits the hang.
        task_evict = asyncio.create_task(service.create(None))
        await _let_event_loop_run()
        assert not task_evict.done()
        # A fresh create() must not be stuck behind the same lock: it
        # evicts cid_a (a normal, fast-closing handle) and completes
        # promptly, proving the lock was released long before task_evict's
        # hung close() of cid1 will ever finish.
        cid_c, _ = await asyncio.wait_for(service.create(None), timeout=1.0)
        task_evict.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task_evict
        return cid1, cid_a, cid_c

    cid1, cid_a, cid_c = asyncio.run(scenario())
    assert len({cid1, cid_a, cid_c}) == 3
    assert engine.conversations[0].closed is False  # cid1: cancelled mid-hang, never finished
    assert engine.conversations[1].closed is True  # cid_a: closed promptly, no hang


def test_close_loop_continues_past_a_cancelled_handle_and_reraises():
    # pkm-4zq4 final-review fix wave: the outer-finally teardown loop caught
    # only `except Exception` around each queued handle's close(). A
    # CancelledError (BaseException) landing while parked in one handle's
    # close() used to abort the loop entirely -- and every remaining
    # to_close entry was already popped from _entries under the lock above,
    # so nothing would ever close it: its subprocess and 0600 session-token
    # config file (pkm-4zq4) leak until process exit. This resurrects the
    # exact credential-leak class pkm-4zq4 closes, one layer up. The fix
    # must keep closing the rest of the queue after a cancellation and only
    # re-raise once every entry has been attempted.
    clock = FakeClock()
    engine = FakeEngine()
    service = AssistantService(engine, max_conversations=5, idle_ttl=1.0, clock=clock)

    hung = _StubHandle(hang_close=True)
    normal = _StubHandle()
    # Seed two already-idle entries directly so a single create() reaps both
    # into to_close in one pass, in insertion order (hung first).
    service._entries["stale-hung"] = _Entry(handle=hung, model="sonnet", last_used=0.0)
    service._entries["stale-normal"] = _Entry(handle=normal, model="sonnet", last_used=0.0)

    async def scenario():
        task = asyncio.create_task(service.create(None))
        for _ in range(10):
            await asyncio.sleep(0)  # let the reap, the new engine call, and
            # the finally-loop reach the hung handle's close() all happen
        assert hung.closed is False and normal.closed is False  # not there yet
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert normal.closed is True  # the second queued handle still got closed
    assert hung.closed is False  # cancelled mid-await, never actually finished
