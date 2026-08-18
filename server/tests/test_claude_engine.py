import asyncio
import contextlib
import json
import logging
import stat
from pathlib import Path

import pytest

from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    PermissionResultDeny,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
# FakeSDKClient, HangingInterruptClient, make_engine and make_result live in
# fake_sdk_client.py: the SSE-teardown tests drive the same real engine.
from fake_sdk_client import FakeSDKClient, HangingInterruptClient, make_engine, make_result

from pkm.assistant import claude_engine, harness_env
from pkm.assistant.claude_engine import TurnMapper
from pkm.assistant.events import ConfirmRequest, ErrorEvent, TextDelta, ToolFinished, ToolStarted, TurnDone
from pkm.assistant.policy import SYSTEM_PROMPT


class BrokenInterruptClient(FakeSDKClient):
    """interrupt() raises -- e.g. the subprocess is already gone."""

    async def interrupt(self):
        self.interrupts += 1
        raise RuntimeError("harness already dead")


class FailingConnectClient(FakeSDKClient):
    """connect() raises -- e.g. the CLI subprocess failed to spawn."""

    async def connect(self):
        raise RuntimeError("connect failed")


class HangingConnectClient(FakeSDKClient):
    """connect() never returns until cancelled -- simulates a wedged
    handshake that the admission lock's wait_for(create_timeout) times out
    on (pkm-rovq)."""

    async def connect(self):
        await asyncio.Event().wait()  # never set


def failing_factory(options):
    raise RuntimeError("factory boom")


class HangingDisconnectClient(FakeSDKClient):
    """connect() hangs until a first cancellation; disconnect() -- reached
    only via the resulting cleanup path -- hangs until a second one.
    Reproduces a wedged harness being cancelled twice: once by
    wait_for(create_timeout), again by whatever cancels the enclosing task
    (an aborted POST, lifespan shutdown)."""

    async def connect(self):
        await asyncio.Event().wait()  # never set; first cancellation lands here

    async def disconnect(self):
        self.disconnect_calls += 1
        await asyncio.Event().wait()  # never set; second cancellation lands here


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
        f"mcp__pkm__{t}" for t in ("get_page", "get_block", "search", "query", "backlinks", "todos", "search_assets")
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


def test_glm_routes_to_zai_endpoint(tmp_path):
    engine = make_engine(tmp_path, zai_token="zk-test")

    async def scenario():
        return await engine.create_conversation(SYSTEM_PROMPT, "glm")

    conv = asyncio.run(scenario())
    opts = FakeSDKClient.instances[0].options
    # z.ai maps the Claude alias to its plan-default GLM server-side, so no
    # GLM version name is hardcoded anywhere.
    assert opts.model == "sonnet"
    assert opts.env["ANTHROPIC_BASE_URL"] == "https://api.z.ai/api/anthropic"
    assert opts.env["ANTHROPIC_AUTH_TOKEN"] == "zk-test"
    # the MCP-tool eager-load setting must survive the provider override
    assert opts.env["ENABLE_TOOL_SEARCH"] == "false"
    asyncio.run(conv.close())


def test_zai_routing_covers_every_zai_model(tmp_path, monkeypatch):
    # policy.ZAI_MODELS is the set of z.ai-routed models; resolution must
    # consult it rather than a "glm" literal, or a future entry would
    # silently run on the Claude subscription instead.
    monkeypatch.setattr(harness_env, "ZAI_MODELS", ("glm", "glm-air"))
    engine = make_engine(tmp_path, zai_token="zk-test")

    async def scenario():
        return await engine.create_conversation(SYSTEM_PROMPT, "glm-air")

    conv = asyncio.run(scenario())
    opts = FakeSDKClient.instances[0].options
    assert opts.env["ANTHROPIC_BASE_URL"] == "https://api.z.ai/api/anthropic"
    assert opts.env["ANTHROPIC_AUTH_TOKEN"] == "zk-test"
    asyncio.run(conv.close())


def test_glm_startup_log_names_the_requested_model(tmp_path, caplog):
    # The alias rewrite (glm -> sonnet for the SDK) must not reach the log,
    # or a glm harness is indistinguishable from a real sonnet one.
    engine = make_engine(tmp_path, zai_token="zk-test")

    async def scenario():
        return await engine.create_conversation(SYSTEM_PROMPT, "glm")

    with caplog.at_level(logging.INFO, logger="pkm.assistant"):
        conv = asyncio.run(scenario())
    assert any("model=glm" in r.getMessage() for r in caplog.records)
    asyncio.run(conv.close())


def test_claude_models_unaffected_by_zai_config(tmp_path):
    engine = make_engine(tmp_path, zai_token="zk-test")

    async def scenario():
        return await engine.create_conversation(SYSTEM_PROMPT, "opus")

    conv = asyncio.run(scenario())
    opts = FakeSDKClient.instances[0].options
    assert opts.model == "opus"
    # a configured z.ai key must never leak into Claude-subscription runs
    assert "ANTHROPIC_BASE_URL" not in opts.env
    assert "ANTHROPIC_AUTH_TOKEN" not in opts.env
    asyncio.run(conv.close())


def test_glm_without_token_is_rejected_before_any_side_effect(tmp_path):
    engine = make_engine(tmp_path)  # no zai_token

    async def scenario():
        return await engine.create_conversation(SYSTEM_PROMPT, "glm")

    with pytest.raises(ValueError, match="z.ai"):
        asyncio.run(scenario())
    assert FakeSDKClient.instances == []  # no subprocess client constructed
    assert list(tmp_path.iterdir()) == []  # no credential file left behind


def test_create_conversation_factory_failure_unlinks_config(tmp_path):
    # pkm-4zq4: a client_factory failure must not leave the 0600 credential
    # file behind -- there is no client to disconnect, but the config still
    # needs cleanup.
    engine = make_engine(tmp_path, factory=failing_factory)

    async def scenario():
        with pytest.raises(RuntimeError, match="factory boom"):
            await engine.create_conversation(SYSTEM_PROMPT, "sonnet")

    asyncio.run(scenario())
    assert list(tmp_path.glob("pkm-assistant-*.json")) == []


def test_create_conversation_connect_failure_unlinks_and_disconnects(tmp_path):
    # pkm-4zq4: connect() failing after the client was created must still
    # disconnect the partially-started client and unlink the config file.
    engine = make_engine(tmp_path, factory=FailingConnectClient)

    async def scenario():
        with pytest.raises(RuntimeError, match="connect failed"):
            await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        return FakeSDKClient.instances[0]

    client = asyncio.run(scenario())
    assert client.disconnect_calls == 1
    assert list(tmp_path.glob("pkm-assistant-*.json")) == []


def test_create_conversation_cancelled_during_connect_cleans_up(tmp_path):
    # pkm-4zq4: this is what happens when service.create()'s
    # asyncio.wait_for(create_conversation(...), CREATE_TIMEOUT_S) times out
    # on a wedged handshake -- CancelledError is delivered into connect().
    # Startup must still disconnect the client and unlink the config file
    # rather than leaving both behind for every future admission to trip
    # over.
    engine = make_engine(tmp_path, factory=HangingConnectClient)

    async def scenario():
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(engine.create_conversation(SYSTEM_PROMPT, "sonnet"), 0.05)
        return FakeSDKClient.instances[0]

    client = asyncio.run(scenario())
    assert client.disconnect_calls == 1
    assert list(tmp_path.glob("pkm-assistant-*.json")) == []


def test_close_cleanup_survives_a_second_cancellation_during_disconnect(tmp_path):
    # pkm-4zq4 fix round 1, finding 1: close() awaited client.disconnect()
    # guarded only by `except Exception`, then unlinked the config file as a
    # separate, later statement. CancelledError is BaseException, not
    # Exception -- a second cancellation delivered into that disconnect()
    # await (e.g. uvicorn cancelling the aborted POST, on top of the
    # create_timeout cancellation that got us into cleanup in the first
    # place) skipped the unlink entirely, leaking the 0600 session-token
    # file. No prior fake's disconnect() ever awaited anything, which is why
    # the suite was green over this hole.
    engine = make_engine(tmp_path, factory=HangingDisconnectClient)

    async def scenario():
        task = asyncio.create_task(engine.create_conversation(SYSTEM_PROMPT, "sonnet"))
        for _ in range(5):
            await asyncio.sleep(0)  # let it reach the blocking connect()
        task.cancel()  # first cancellation: lands in connect()
        for _ in range(10):
            await asyncio.sleep(0)  # let the except-block's close() reach disconnect()
        assert FakeSDKClient.instances[0].disconnect_calls == 1  # confirms it's there to interrupt
        task.cancel()  # second cancellation: lands in disconnect()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)

    asyncio.run(scenario())
    assert list(tmp_path.glob("pkm-assistant-*.json")) == []


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


def test_send_interrupts_harness_when_consumer_drops_before_any_event(tmp_path):
    # pkm-c98s item 2: an SSE consumer that disconnects mid-turn must not
    # leave the CLI subprocess still executing the abandoned query. A
    # generator that is cancelled while genuinely suspended mid-body (as
    # Starlette cancels the streaming task on client disconnect) -- not one
    # that is aclose()'d before it has ever been started -- is what actually
    # exercises the send() generator's finally block.
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]

        async def consume():
            async for _ in conv.send("hi"):  # no messages fed: blocks forever
                pass

        task = asyncio.create_task(consume())
        for _ in range(3):
            await asyncio.sleep(0)  # let it reach the blocking queue.get()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await conv.close()
        return client

    client = asyncio.run(scenario())
    assert client.interrupts == 1


def test_send_interrupts_harness_when_consumer_drops_mid_confirm(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]

        async def fake_model_turn():
            await conv.can_use_tool("mcp__pkm__save_note", {"title": "Demo"}, None)

        task = asyncio.create_task(fake_model_turn())
        stream = conv.send("save it")
        ev = await asyncio.wait_for(anext(stream), timeout=5)
        assert isinstance(ev, ConfirmRequest)
        await stream.aclose()  # consumer gone before the user ever answered
        # the pending can_use_tool hook must not be left dangling forever
        await asyncio.wait_for(task, timeout=5)
        await conv.close()
        return client

    client = asyncio.run(scenario())
    assert client.interrupts == 1


def test_parked_confirm_is_declined_without_waiting_for_interrupt(tmp_path):
    # pkm-mbcc defect 2: the decline loop used to run *after* awaiting
    # interrupt(), which cannot return while the harness sits inside
    # can_use_tool awaiting the very decision that loop supplies. The parked
    # confirm was therefore never answered, and the harness stayed wedged
    # until the process restarted.
    engine = make_engine(tmp_path, factory=HangingInterruptClient)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        decisions = []

        async def fake_model_turn():
            decisions.append(
                await conv.can_use_tool("mcp__pkm__save_note", {"title": "Demo"}, None)
            )

        waiting = asyncio.create_task(fake_model_turn())
        stream = conv.send("save it")
        ev = await asyncio.wait_for(anext(stream), timeout=5)
        assert isinstance(ev, ConfirmRequest)
        # the consumer disappears without ever answering the confirm
        closing = asyncio.create_task(stream.aclose())
        # the decision must land promptly, i.e. before/independently of the
        # interrupt() that never returns
        await asyncio.wait_for(waiting, timeout=1)
        closing.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await closing
        await conv.close()
        return decisions[0]

    decision = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultDeny)
    assert "declined" in decision.message


def test_disconnect_cleanup_survives_a_wedged_interrupt(tmp_path, monkeypatch):
    # pkm-mbcc defect 2, second half: even with nothing pending, cleanup must
    # not hang forever on a harness that never acknowledges the interrupt.
    monkeypatch.setattr(claude_engine, "INTERRUPT_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path, factory=HangingInterruptClient)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]

        async def consume():
            async for _ in conv.send("hi"):  # no messages fed: blocks forever
                pass

        task = asyncio.create_task(consume())
        for _ in range(3):
            await asyncio.sleep(0)  # let it reach the blocking queue.get()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)
        await conv.close()
        return conv, client

    conv, client = asyncio.run(scenario())
    assert client.interrupts == 1


def test_disconnect_cleanup_survives_an_interrupt_that_raises(tmp_path):
    engine = make_engine(tmp_path, factory=BrokenInterruptClient)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]

        async def consume():
            async for _ in conv.send("hi"):
                pass

        task = asyncio.create_task(consume())
        for _ in range(3):
            await asyncio.sleep(0)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)
        await conv.close()
        return conv, client

    conv, client = asyncio.run(scenario())
    assert client.interrupts == 1


# --- pkm-rwwc: an unacknowledged interrupt leaves the harness state
# uncertain -- the conversation must be flagged unhealthy so the service
# retires it instead of reusing it for a later turn. ---


def test_wedged_interrupt_marks_conversation_unhealthy(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_engine, "INTERRUPT_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path, factory=HangingInterruptClient)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")

        async def consume():
            async for _ in conv.send("hi"):  # no messages fed: blocks forever
                pass

        task = asyncio.create_task(consume())
        for _ in range(3):
            await asyncio.sleep(0)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)
        await conv.close()
        return conv

    conv = asyncio.run(scenario())
    assert conv.healthy is False


def test_interrupt_that_raises_marks_conversation_unhealthy(tmp_path):
    engine = make_engine(tmp_path, factory=BrokenInterruptClient)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")

        async def consume():
            async for _ in conv.send("hi"):
                pass

        task = asyncio.create_task(consume())
        for _ in range(3):
            await asyncio.sleep(0)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)
        await conv.close()
        return conv

    conv = asyncio.run(scenario())
    assert conv.healthy is False


def test_interrupt_abandoned_by_a_second_cancellation_marks_unhealthy(tmp_path, caplog):
    # A cancellation landing in the bounded interrupt wait says as little
    # about the harness as a timeout does, and `except Exception` does not
    # catch it. Left unhandled it skipped the health verdict entirely, so the
    # service kept the conversation and handed it a later turn -- which is how
    # a real client disconnect behaved, because Starlette's cancel scope
    # re-delivers its cancellation on every loop cycle.
    engine = make_engine(tmp_path, factory=HangingInterruptClient)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")

        async def consume():
            async for _ in conv.send("hi"):  # no messages fed: blocks forever
                pass

        task = asyncio.create_task(consume())
        for _ in range(3):
            await asyncio.sleep(0)
        task.cancel()  # first cancellation: starts the abandon-turn protocol
        for _ in range(3):
            await asyncio.sleep(0)  # let it reach the interrupt that never lands
        assert FakeSDKClient.instances[0].interrupts == 1
        task.cancel()  # second cancellation: lands in the interrupt wait
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=2)
        await conv.close()
        return conv

    with caplog.at_level(logging.WARNING, logger="pkm.assistant"):
        conv = asyncio.run(scenario())
    assert conv.healthy is False
    assert any("abandoned by a cancellation" in r.message for r in caplog.records)


def test_acknowledged_interrupt_leaves_conversation_healthy(tmp_path):
    # a consumer drop that the harness *does* acknowledge promptly is not
    # terminal -- only a failed/timed-out interrupt should retire the
    # conversation.
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")

        async def consume():
            async for _ in conv.send("hi"):  # no messages fed: blocks forever
                pass

        task = asyncio.create_task(consume())
        for _ in range(3):
            await asyncio.sleep(0)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await conv.close()
        return conv

    conv = asyncio.run(scenario())
    assert conv.healthy is True


def test_send_does_not_interrupt_on_normal_completion(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        client.feed(make_result())
        _ = [ev async for ev in conv.send("hi")]
        await conv.close()
        return client

    client = asyncio.run(scenario())
    assert client.interrupts == 0


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
