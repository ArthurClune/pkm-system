"""SSE teardown: a vanished client must run the engine's dropped-consumer
cleanup on a schedule, not whenever CPython gets round to finalizing an
orphaned async generator (pkm-f3mo).

These tests drive the real chain, minus HTTP -- `ClaudeConversation` over a
fake SDK client, the real `AssistantService`, and the real SSE frame
generator -- because the bug lives in the seams between those three
generators, not in any one of them.
"""

import asyncio
import contextlib
import logging
from typing import cast

import pytest
from claude_agent_sdk import PermissionResultDeny
from fake_sdk_client import FakeSDKClient, HangingInterruptClient, make_engine

from pkm.assistant import claude_engine, routes
from pkm.assistant.claude_engine import ClaudeConversation
from pkm.assistant.events import SSE_COMMENT, TextDelta
from pkm.assistant.service import AssistantService


class ParkedTurn:
    """One turn parked in `can_use_tool`, streaming through the whole stack.

    `frames` is what `StreamingResponse` iterates; closing or cancelling it is
    what a client disconnect does to the server side.
    """

    def __init__(self, tmp_path, factory, keepalive: float) -> None:
        self.tmp_path = tmp_path
        self.factory = factory
        self.keepalive = keepalive
        self.decisions: list[object] = []

    async def start(self) -> "ParkedTurn":
        engine = make_engine(self.tmp_path, factory=self.factory)
        self.service = AssistantService(engine)
        self.cid, _ = await self.service.create(None)
        # the real ClaudeConversation, reached through the registry the
        # service actually streams from
        self.conversation = cast(
            ClaudeConversation, self.service._entries[self.cid].handle)
        self.client = FakeSDKClient.instances[0]

        async def fake_model_turn() -> None:
            # what the SDK does with a write tool: call the permission hook
            # and park inside it until a decision arrives. A harness parked
            # here cannot acknowledge an interrupt (pkm-mbcc), so the double
            # blocks exactly where the real one blocks.
            self.decisions.append(
                await self.conversation.can_use_tool(
                    "mcp__pkm__save_note", {"title": "Demo"}, None)
            )

        self.frames = routes._sse_frames(
            self.service.send(self.cid, "save it"), self.keepalive)
        # The turn must be running before the model asks to use a tool:
        # send() drains stale events as its first act, so a ConfirmRequest
        # queued ahead of it would be swallowed (the real harness cannot call
        # a tool before it has been given the query either).
        reading = asyncio.ensure_future(self.next_event_frame())
        for _ in range(3):
            await asyncio.sleep(0)
        self.model_turn = asyncio.create_task(fake_model_turn())
        self.first_frame = await reading
        return self

    async def next_event_frame(self, timeout: float = 5.0) -> str:
        """The next real event frame, skipping any keepalive comments."""
        while True:
            frame = await asyncio.wait_for(anext(self.frames), timeout)
            if frame != SSE_COMMENT:
                return frame

    def assert_turn_was_abandoned(self) -> None:
        """The whole dropped-consumer protocol, as one assertion."""
        assert self.client.interrupts == 1  # the harness was told to stop
        assert self.conversation.healthy is False  # ...and never acknowledged it
        assert self.cid not in self.service._entries  # so the conversation is retired
        # close() ran too: the 0600 session-token file is gone
        assert list(self.tmp_path.glob("pkm-assistant-*.json")) == []

    async def assert_confirm_was_declined(self) -> None:
        # The decline landed during teardown, so the parked hook is already
        # resolved -- awaiting it here cannot block, it only lets the task
        # observe its result.
        await asyncio.wait_for(self.model_turn, timeout=5)
        assert isinstance(self.decisions[0], PermissionResultDeny)
        assert "declined" in self.decisions[0].message


@pytest.fixture()
def quick_interrupt_timeout(monkeypatch):
    """Bound the abandon-turn interrupt tightly; the fake never answers it."""
    monkeypatch.setattr(claude_engine, "INTERRUPT_TIMEOUT_S", 0.05)


def test_disconnect_after_an_event_declines_interrupts_and_retires(
    tmp_path, quick_interrupt_timeout
):
    # The plain disconnect: the confirm frame reached the client, the client
    # went away, and Starlette closes the response body generator. Nothing is
    # in flight on the underlying stream at that moment, so before pkm-f3mo
    # the teardown did nothing at all and the engine's cleanup was left to
    # async-generator finalization.
    async def scenario():
        turn = await ParkedTurn(tmp_path, HangingInterruptClient, keepalive=30.0).start()
        assert turn.first_frame.startswith("event: confirm_request")

        await turn.frames.aclose()  # what a disconnect does to the response body
        # Asserted with no `await` in between, deliberately: asyncgen
        # finalization runs as a loop callback, so anything true here was done
        # by the explicit teardown rather than by the garbage collector.
        turn.assert_turn_was_abandoned()
        await turn.assert_confirm_was_declined()

    asyncio.run(scenario())


def test_disconnect_during_a_keepalive_gap_declines_interrupts_and_retires(
    tmp_path, quick_interrupt_timeout, caplog
):
    # The other disconnect shape: the client left while the turn was silent,
    # so a read *is* in flight on the underlying stream. It has to be
    # cancelled and awaited before the close -- aclose() on a generator with
    # an __anext__ still running raises "asynchronous generator is already
    # running", which would abandon the teardown at its first step.
    async def scenario():
        turn = await ParkedTurn(tmp_path, HangingInterruptClient, keepalive=0.01).start()
        assert turn.first_frame.startswith("event: confirm_request")
        # the confirm is parked and nothing else will ever be queued, so the
        # next frame is a keepalive -- and the anext() behind it is still live
        assert await asyncio.wait_for(anext(turn.frames), timeout=5) == SSE_COMMENT

        with caplog.at_level(logging.WARNING, logger="pkm.assistant"):
            await turn.frames.aclose()
        turn.assert_turn_was_abandoned()
        await turn.assert_confirm_was_declined()
        assert not [r for r in caplog.records if "close" in r.message]

    asyncio.run(scenario())


def test_cancelled_consumer_stays_cancelled_and_still_abandons_the_turn(
    tmp_path, quick_interrupt_timeout
):
    # uvicorn/Starlette cancel the response task on disconnect rather than
    # closing the generator politely. Teardown must ride that cancellation to
    # completion -- awaiting the cancelled consumer must not return before the
    # engine cleanup has finished -- and must not swallow the cancellation.
    async def scenario():
        turn = await ParkedTurn(tmp_path, HangingInterruptClient, keepalive=30.0).start()
        assert turn.first_frame.startswith("event: confirm_request")
        seen: list[str] = []

        async def consume() -> None:
            async for frame in turn.frames:  # nothing more will ever arrive
                seen.append(frame)  # pragma: no cover - the turn is parked

        consumer = asyncio.create_task(consume())
        for _ in range(5):
            await asyncio.sleep(0)  # let the read park inside the keepalive wait
        assert seen == []
        consumer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await consumer  # returns only once the task has finished unwinding

        turn.assert_turn_was_abandoned()
        await turn.assert_confirm_was_declined()

    asyncio.run(scenario())


def test_teardown_completes_through_a_repeated_cancellation(
    tmp_path, quick_interrupt_timeout
):
    # A real disconnect is not one cancellation. Starlette runs the response
    # body inside an anyio cancel scope, and anyio's _deliver_cancellation
    # re-cancels every task still in the scope on every loop cycle
    # (call_soon), so each await in teardown is cancelled as soon as it
    # starts. A plain task.cancel() is delivered once and hides this
    # completely: verified against a real uvicorn disconnect, interrupt() was
    # called, its bounded wait was cancelled rather than timing out, and
    # `healthy` stayed True -- so the conversation the teardown exists to
    # retire stayed in the registry, harness and credential file included.
    async def scenario():
        turn = await ParkedTurn(tmp_path, HangingInterruptClient, keepalive=30.0).start()

        async def consume() -> None:
            async for _ in turn.frames:
                pass  # pragma: no cover - the turn is parked

        consumer = asyncio.create_task(consume())
        for _ in range(5):
            await asyncio.sleep(0)  # let the read park inside the keepalive wait

        async def storm() -> None:
            for _ in range(10_000):  # bounded so a regression fails rather than hangs
                if consumer.done():
                    return
                consumer.cancel()
                await asyncio.sleep(0)

        storming = asyncio.create_task(storm())
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(consumer, timeout=5)
        await storming

        turn.assert_turn_was_abandoned()
        await turn.assert_confirm_was_declined()

    asyncio.run(scenario())


def test_a_failing_stream_close_is_logged_not_raised(caplog):
    # Teardown runs while a GeneratorExit (or a cancellation) is already in
    # flight. Letting the cleanup's own failure out would replace the
    # disconnect with an unrelated error at the caller, and skip whatever
    # teardown still had to do.
    async def exploding_stream():
        try:
            yield TextDelta(text="hi")
            await asyncio.Event().wait()  # never set
        finally:
            raise RuntimeError("cleanup exploded")

    async def scenario():
        gen = routes._with_keepalive(exploding_stream(), 30.0)
        assert await anext(gen) == 'event: text_delta\ndata: {"text": "hi"}\n\n'
        await gen.aclose()  # must return, not raise

    with caplog.at_level(logging.ERROR, logger="pkm.assistant"):
        asyncio.run(scenario())
    assert any("close failed" in r.message for r in caplog.records)


def test_normal_completion_closes_the_stream_without_complaint(tmp_path, caplog):
    # The same teardown runs on the happy path (the stream is already
    # exhausted, so closing it is a no-op); it must stay silent there.
    from fake_sdk_client import make_result

    async def scenario():
        engine = make_engine(tmp_path)
        service = AssistantService(engine)
        cid, _ = await service.create(None)
        FakeSDKClient.instances[0].feed(make_result())
        frames = [f async for f in routes._sse_frames(service.send(cid, "hi"), 30.0)]
        assert frames[-1].startswith("event: turn_done")
        assert cid in service._entries  # a completed turn retires nothing
        await service.close_all()

    with caplog.at_level(logging.WARNING, logger="pkm.assistant"):
        asyncio.run(scenario())
    assert not [r for r in caplog.records if "close" in r.message]


def test_engine_failure_mid_stream_is_still_reported_in_band(tmp_path):
    # The in-band error frame is the pre-existing contract for an engine that
    # raises mid-turn; wrapping the SSE path in an explicit close must not
    # turn that into a broken response.
    async def boom():
        yield TextDelta(text="partial")
        raise RuntimeError("engine crashed")

    async def scenario():
        return [f async for f in routes._sse_frames(boom(), 30.0)]

    frames = asyncio.run(scenario())
    assert frames[0].startswith("event: text_delta")
    assert frames[-1].startswith("event: error")
    assert "engine crashed" in frames[-1]


def test_a_cancelled_stream_close_is_logged_not_re_raised(caplog):
    # A second cancellation -- lifespan shutdown arriving on top of the
    # disconnect that started this teardown -- can land while the stream is
    # closing. Letting it out would replace the disconnect the caller is
    # already unwinding, and the task it would cancel is that same task.
    async def stream():
        try:
            yield TextDelta(text="hi")
        finally:
            raise asyncio.CancelledError

    async def scenario():
        gen = stream()
        assert await anext(gen) == TextDelta(text="hi")
        await routes._abandon_stream(gen, None)

    with caplog.at_level(logging.WARNING, logger="pkm.assistant"):
        asyncio.run(scenario())
    assert any("close cancelled" in r.message for r in caplog.records)


def test_teardown_gives_up_on_a_close_that_never_finishes(monkeypatch, caplog):
    # The wait is not free -- under a cancellation storm each pass costs a
    # cancelled shield per loop cycle -- so a cleanup that never returns must
    # not hold the response task (and a core) until the process restarts.
    monkeypatch.setattr(routes, "TEARDOWN_TIMEOUT_S", 0.05)

    async def stream():
        try:
            yield TextDelta(text="hi")
        finally:
            await asyncio.Event().wait()  # never set: a wedged close

    async def scenario():
        gen = stream()
        assert await anext(gen) == TextDelta(text="hi")
        await routes._abandon_stream(gen, None)

    with caplog.at_level(logging.WARNING, logger="pkm.assistant"):
        asyncio.run(scenario())
    assert any("unfinished after" in r.message for r in caplog.records)


def test_teardown_gives_up_on_a_read_that_never_finishes(monkeypatch, caplog):
    # Same for the first step: a read that will not end leaves the generator
    # running, so the close is skipped rather than attempted and logged as a
    # spurious failure.
    monkeypatch.setattr(routes, "TEARDOWN_TIMEOUT_S", 0.05)

    async def stream():
        yield TextDelta(text="hi")

    async def stubborn() -> TextDelta:
        # ignores teardown's cancel, then goes quietly on the test's own
        for _ in range(2):
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.Event().wait()  # never set
        return TextDelta(text="never read")

    async def scenario():
        pending = asyncio.ensure_future(stubborn())
        await asyncio.sleep(0)
        await routes._abandon_stream(stream(), pending)
        pending.cancel()

    with caplog.at_level(logging.WARNING, logger="pkm.assistant"):
        asyncio.run(scenario())
    assert any("unfinished after" in r.message for r in caplog.records)
    assert not [r for r in caplog.records if "close failed" in r.message]


def test_teardown_drops_a_failed_pending_read_rather_than_raising_from_it():
    # The in-flight read can settle with the engine's own exception exactly
    # when teardown awaits it. That result is worthless by then -- the caller
    # is unwinding a disconnect -- and re-raising it from a finally would
    # replace the disconnect with an unrelated error.
    async def stream():
        yield TextDelta(text="hi")

    async def boom():
        raise RuntimeError("engine crashed")

    async def scenario():
        pending = asyncio.ensure_future(boom())
        await asyncio.sleep(0)  # let it fail before teardown looks at it
        assert pending.done()
        await routes._abandon_stream(stream(), pending)

    asyncio.run(scenario())
