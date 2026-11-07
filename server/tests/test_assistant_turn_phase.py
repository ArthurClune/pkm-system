"""After a Stop, a stall or a lost harness, the next send() answers its own
message or the conversation is retired: never a turn behind."""

import asyncio
import contextlib

import pytest
from claude_agent_sdk import PermissionResultDeny, StreamEvent
from fake_sdk_client import FakeSDKClient, make_engine, make_result

from pkm.assistant import claude_engine, harness_env
from pkm.assistant.events import ErrorEvent, TextDelta, TurnDone
from pkm.assistant.policy import SYSTEM_PROMPT
from pkm.assistant.service import AssistantService, UnknownConversationError


@pytest.fixture(autouse=True)
def _no_cli_discovery(monkeypatch):
    monkeypatch.setattr(claude_engine, "harness_cli", lambda: "/no/claude")


def delta(text: str) -> StreamEvent:
    return StreamEvent(uuid="u", session_id="s1", event={
        "type": "content_block_delta",
        "delta": {"type": "text_delta", "text": text}})


async def turn(conv, text: str, client: FakeSDKClient, timeout: float = 2.0):
    """Run send(text) to its end while the harness answers it."""
    async def collect():
        return [ev async for ev in conv.send(text)]

    task = asyncio.create_task(collect())
    for _ in range(5):
        await asyncio.sleep(0)
    client.feed(delta(f"re {text}"), make_result(usage={"tag": text}))
    return await asyncio.wait_for(task, timeout)


async def stop_mid_turn(conv, client: FakeSDKClient, text: str = "one"):
    """The Stop button: the consumer closes send() after the first event."""
    stream = conv.send(text)
    reading = asyncio.ensure_future(anext(stream))
    for _ in range(3):
        await asyncio.sleep(0)
    client.feed(delta("partial"))
    assert await asyncio.wait_for(reading, 2) == TextDelta(text="partial")
    await asyncio.wait_for(stream.aclose(), 15)


async def user_types_next_message():
    """The seconds a person takes to send again: the aborted turn's result
    has long reached the SDK's buffer by then."""
    await asyncio.sleep(0.05)


@pytest.mark.parametrize("model", ["sonnet", "glm"])
@pytest.mark.parametrize("order", ["after_ack", "before_ack"])
def test_stop_then_send_answers_the_new_message(tmp_path, monkeypatch, order,
                                                model):
    monkeypatch.setattr(FakeSDKClient, "interrupt_result", order)
    engine = make_engine(tmp_path, zai_token="zk-test")

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, model)
        client = FakeSDKClient.instances[0]
        routed = client.options.env.get("ANTHROPIC_BASE_URL")
        assert (routed == harness_env.ZAI_BASE_URL) is (model == "glm")
        await stop_mid_turn(conv, client)
        await user_types_next_message()
        events = await turn(conv, "two", client)
        await conv.close()
        return conv, client, events

    conv, client, events = asyncio.run(scenario())
    assert client.interrupts == 1
    assert events == [TextDelta(text="re two"), TurnDone(usage={"tag": "two"})]


def test_stall_then_send_answers_the_new_message(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_engine, "STALL_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        stalled = [ev async for ev in conv.send("one")]
        healthy_after_stall = conv.healthy
        await user_types_next_message()
        events = await turn(conv, "two", client)
        await conv.close()
        return stalled, healthy_after_stall, events

    stalled, healthy_after_stall, events = asyncio.run(scenario())
    assert len(stalled) == 1 and isinstance(stalled[0], ErrorEvent)
    assert "no response from the model" in stalled[0].message.lower()
    assert healthy_after_stall is True
    assert events == [TextDelta(text="re two"), TurnDone(usage={"tag": "two"})]


def test_an_interrupt_with_no_result_retires_the_conversation(tmp_path, monkeypatch):
    # acknowledged, but the aborted turn never reports its end: whatever it
    # writes later would be the next turn's first message
    monkeypatch.setattr(FakeSDKClient, "interrupt_result", "never")
    monkeypatch.setattr(claude_engine, "DRAIN_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        await stop_mid_turn(conv, FakeSDKClient.instances[0])
        await conv.close()
        return conv

    assert asyncio.run(scenario()).healthy is False


def test_stop_after_the_harness_finished_keeps_the_conversation(tmp_path):
    # the result is already in the buffer when Stop lands: the interrupt
    # reaches an idle CLI, which acknowledges and writes nothing more
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        stream = conv.send("one")
        reading = asyncio.ensure_future(anext(stream))
        for _ in range(3):
            await asyncio.sleep(0)
        client.feed(delta("partial"), make_result(usage={"tag": "one"}))
        await asyncio.wait_for(reading, 2)
        await asyncio.wait_for(stream.aclose(), 15)
        await user_types_next_message()
        events = await turn(conv, "two", client)
        await conv.close()
        return conv, events

    conv, events = asyncio.run(scenario())
    assert events == [TextDelta(text="re two"), TurnDone(usage={"tag": "two"})]


def test_process_death_mid_turn_retires_the_conversation(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]

        async def collect():
            return [ev async for ev in conv.send("one")]

        task = asyncio.create_task(collect())
        for _ in range(3):
            await asyncio.sleep(0)
        client.die()
        events = await asyncio.wait_for(task, 2)
        healthy = conv.healthy
        await conv.close()
        return events, healthy

    events, healthy = asyncio.run(scenario())
    assert len(events) == 1 and isinstance(events[0], ErrorEvent)
    assert healthy is False


def test_clean_eof_without_a_result_ends_the_turn(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]

        async def collect():
            return [ev async for ev in conv.send("one")]

        task = asyncio.create_task(collect())
        for _ in range(3):
            await asyncio.sleep(0)
        client.end_stream()
        try:
            events = await asyncio.wait_for(task, 2)
        except TimeoutError:
            events = None  # send() waited forever on a result
        healthy = conv.healthy
        await conv.close()
        return events, healthy

    events, healthy = asyncio.run(scenario())
    assert events is not None
    assert len(events) == 1 and isinstance(events[0], ErrorEvent)
    assert healthy is False


def test_the_service_retires_a_conversation_whose_harness_died(tmp_path):
    engine = make_engine(tmp_path)
    service = AssistantService(engine)

    async def scenario():
        cid, _ = await service.create("sonnet")
        client = FakeSDKClient.instances[0]

        async def collect():
            return [ev async for ev in service.send(cid, "one")]

        task = asyncio.create_task(collect())
        for _ in range(3):
            await asyncio.sleep(0)
        client.die()
        await asyncio.wait_for(task, 2)
        with pytest.raises(UnknownConversationError):
            service.send(cid, "two")
        await service.close_all()

    asyncio.run(scenario())


def test_a_confirm_parked_between_turns_is_declined(tmp_path):
    # a write that reaches can_use_tool while no send() consumes has no
    # card to show: it is declined, never left parked behind a dropped
    # ConfirmRequest
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        await turn(conv, "one", client)
        parked = asyncio.create_task(conv.can_use_tool(
            "mcp__pkm__save_note", {"text": "Demo"}, None))
        for _ in range(3):
            await asyncio.sleep(0)
        await turn(conv, "two", client)
        try:
            decision = await asyncio.wait_for(parked, 2)
        except TimeoutError:
            decision = None
        finally:
            parked.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await parked
        await conv.close()
        return decision

    decision = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultDeny)


def test_a_stall_whose_interrupt_never_reports_retires_the_conversation(
        tmp_path, monkeypatch):
    monkeypatch.setattr(FakeSDKClient, "interrupt_result", "never")
    monkeypatch.setattr(claude_engine, "STALL_TIMEOUT_S", 0.05)
    monkeypatch.setattr(claude_engine, "DRAIN_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        events = await asyncio.wait_for(
            asyncio.ensure_future(_collect(conv.send("one"))), 2)
        healthy = conv.healthy
        await conv.close()
        return events, healthy

    events, healthy = asyncio.run(scenario())
    assert len(events) == 1 and "no response" in events[0].message.lower()
    assert healthy is False


async def _collect(stream):
    return [ev async for ev in stream]


def test_a_dead_harness_is_never_sent_another_query(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        client.die()  # while idle: the next query is the first to notice
        first = await _collect(conv.send("one"))
        second = await _collect(conv.send("two"))
        await conv.close()
        return client, first, second

    client, first, second = asyncio.run(scenario())
    assert client.queries == []
    assert [type(ev) for ev in first + second] == [ErrorEvent, ErrorEvent]
    assert second[0].message == claude_engine.HARNESS_LOST


def test_a_drain_abandoned_by_a_second_cancellation_retires(tmp_path, monkeypatch):
    monkeypatch.setattr(FakeSDKClient, "interrupt_result", "never")
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        task = asyncio.create_task(_collect(conv.send("one")))
        for _ in range(3):
            await asyncio.sleep(0)
        task.cancel()  # Stop: interrupt, acknowledged, then the drain
        for _ in range(5):
            await asyncio.sleep(0)
        assert conv.phase == "draining"
        task.cancel()  # lands in the drain's wait
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        healthy = conv.healthy
        await conv.close()
        return healthy

    assert asyncio.run(scenario()) is False


class ManualAbortClient(FakeSDKClient):
    """Acknowledges an interrupt; the test writes the aborted result."""

    async def interrupt(self):
        self.interrupts += 1
        self.turn_open = False


class HeldInterruptClient(FakeSDKClient):
    """An interrupt is answered only once the test sets `release`."""

    def __init__(self, options):
        super().__init__(options)
        self.release = asyncio.Event()

    async def interrupt(self):
        await self.release.wait()
        await super().interrupt()


async def _until(condition, timeout: float = 2.0) -> None:
    async def poll():
        while not condition():
            await asyncio.sleep(0.005)
    await asyncio.wait_for(poll(), timeout)


def test_stop_while_a_stall_drains_keeps_the_conversation(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_engine, "STALL_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path, factory=ManualAbortClient)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        task = asyncio.create_task(_collect(conv.send("one")))
        await _until(lambda: conv.phase == "draining")
        task.cancel()  # Stop while the stall's drain is open
        for _ in range(5):
            await asyncio.sleep(0)
        client.feed(make_result(subtype="error_during_execution",
                                is_error=True))
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        healthy = conv.healthy
        await user_types_next_message()
        events = await turn(conv, "two", client)
        await conv.close()
        return client, healthy, events

    client, healthy, events = asyncio.run(scenario())
    assert client.interrupts == 1
    assert healthy is True
    assert events == [TextDelta(text="re two"), TurnDone(usage={"tag": "two"})]


def test_stop_while_a_stall_interrupts_sends_no_second_interrupt(
        tmp_path, monkeypatch):
    monkeypatch.setattr(claude_engine, "STALL_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path, factory=HeldInterruptClient)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        task = asyncio.create_task(_collect(conv.send("one")))
        await asyncio.sleep(0.1)  # the stall fires; its interrupt waits
        task.cancel()  # Stop while the stall's interrupt is in flight
        for _ in range(5):
            await asyncio.sleep(0)
        client.release.set()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        healthy = conv.healthy
        await user_types_next_message()
        events = await turn(conv, "two", client)
        await conv.close()
        return client, healthy, events

    client, healthy, events = asyncio.run(scenario())
    assert client.interrupts == 1
    assert healthy is True
    assert events == [TextDelta(text="re two"), TurnDone(usage={"tag": "two"})]
