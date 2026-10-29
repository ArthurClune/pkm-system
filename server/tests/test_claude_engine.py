import asyncio
import contextlib
import json
import logging
import os
import stat
import sys
from collections.abc import Collection, Sequence
from pathlib import Path

import pytest

from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    PermissionResultDeny,
    TextBlock,
    ToolPermissionContext,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
# FakeSDKClient, HangingInterruptClient, make_engine and make_result live in
# fake_sdk_client.py: the SSE-teardown tests drive the same real engine.
from fake_sdk_client import FakeSDKClient, HangingInterruptClient, make_engine, make_result

from pkm.assistant import claude_engine, harness_env
from pkm.assistant.claude_engine import TurnMapper
from pkm.assistant.events import (
    ConfirmRequest,
    ErrorEvent,
    Phase,
    TextDelta,
    ToolFinished,
    ToolStarted,
    TurnDone,
)
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from pkm.assistant.policy import READ_TOOLS, SYSTEM_PROMPT, WRITE_TOOLS
from pkm.assistant.write_preview import FoundBlock, StoredBlock
from pkm.contracts.ops import BlockUid, text_hash
from pkm.test_data.ids import canonical_title_of, confirm_id_of, uid_of


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
    on."""

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
    assert opts.strict_mcp_config is True
    assert opts.include_partial_messages is True
    assert opts.max_turns == 40
    assert opts.env == {"ENABLE_TOOL_SEARCH": "false"}
    assert set(opts.allowed_tools) == {
        f"mcp__pkm__{t}" for t in ("get_page", "get_block", "search", "query", "backlinks", "todos",
                                    "changed_blocks", "search_assets")
    }
    server_cfg = opts.mcp_servers["pkm"]
    assert server_cfg["command"] == "/usr/bin/env"
    assert "env" not in server_cfg
    args = server_cfg["args"]
    at = next(i for i, arg in enumerate(args)
              if arg.startswith("PKM_CLI_CONFIG="))
    assert args[at + 1:] == [sys.executable, "-m", "pkm.mcp.server", "--tools",
                             ",".join(READ_TOOLS + WRITE_TOOLS),
                             "--require-expect"]
    cfg_path = Path(args[at].removeprefix("PKM_CLI_CONFIG="))
    assert cfg_path.parent == tmp_path
    assert stat.S_IMODE(cfg_path.stat().st_mode) == 0o600
    cfg = json.loads(cfg_path.read_text())
    assert cfg["url"] == "http://127.0.0.1:8999"
    assert cfg["token"].startswith("v1.")
    launcher = Path(opts.cli_path)
    assert launcher.parent == tmp_path
    assert stat.S_IMODE(launcher.stat().st_mode) == 0o700
    asyncio.run(conv.close())
    assert not cfg_path.exists()  # config file removed on close
    assert not launcher.exists()
    # pyrefly's narrowing from the earlier assert survives the close() that
    # clears it
    assert client.connected is False  # pyrefly: ignore[unnecessary-comparison]


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
    # A client_factory failure must not leave the 0600 credential file
    # behind -- there is no client to disconnect, but the config still
    # needs cleanup.
    engine = make_engine(tmp_path, factory=failing_factory)

    async def scenario():
        with pytest.raises(RuntimeError, match="factory boom"):
            await engine.create_conversation(SYSTEM_PROMPT, "sonnet")

    asyncio.run(scenario())
    assert list(tmp_path.glob("pkm-assistant-*")) == []


def test_a_failed_launcher_write_leaves_no_credential_file(tmp_path,
                                                          monkeypatch):
    def refuse(cli, names):
        raise OSError("disk full")

    monkeypatch.setattr(claude_engine, "launcher_script", refuse)
    engine = make_engine(tmp_path)

    with pytest.raises(OSError, match="disk full"):
        asyncio.run(engine.create_conversation(SYSTEM_PROMPT, "sonnet"))
    assert FakeSDKClient.instances == []
    assert list(tmp_path.glob("pkm-assistant-*")) == []


def test_create_conversation_connect_failure_unlinks_and_disconnects(tmp_path):
    # connect() failing after the client was created must still disconnect
    # the partially-started client and unlink the config file.
    engine = make_engine(tmp_path, factory=FailingConnectClient)

    async def scenario():
        with pytest.raises(RuntimeError, match="connect failed"):
            await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        return FakeSDKClient.instances[0]

    client = asyncio.run(scenario())
    assert client.disconnect_calls == 1
    assert list(tmp_path.glob("pkm-assistant-*")) == []


def test_create_conversation_cancelled_during_connect_cleans_up(tmp_path):
    # This is what happens when service.create()'s
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
    assert list(tmp_path.glob("pkm-assistant-*")) == []


def test_close_cleanup_survives_a_second_cancellation_during_disconnect(tmp_path):
    # close() must guard client.disconnect() against BaseException, not just
    # Exception: CancelledError is a BaseException, so a second cancellation
    # delivered into that disconnect() await (e.g. uvicorn cancelling the
    # aborted POST, on top of the create_timeout cancellation that got us
    # into cleanup in the first place) must not skip the unlink and leak the
    # 0600 session-token file. No prior fake's disconnect() ever awaited
    # anything, which is why this needs a fake that actually blocks there.
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
    assert list(tmp_path.glob("pkm-assistant-*")) == []


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


def test_upload_asset_is_denied_without_a_card(tmp_path):
    # upload_asset reads host files as the server's service account; the
    # assistant must refuse it outright, never park on an approval card.
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        decision = await asyncio.wait_for(conv.can_use_tool(
            "mcp__pkm__upload_asset", {"path": "../../data/config.json"},
            None), 1)
        queued = conv._queue.qsize()
        await conv.close()
        return decision, queued

    decision, queued = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultDeny)
    assert queued == 0


def test_assistant_mcp_server_offers_exactly_the_policy_tools(tmp_path):
    """Starts the pkm MCP subprocess exactly as the harness would and lists
    what it offers: a tool the policy does not name must not exist there,
    whatever the permission gate would decide. That it is the harness's
    only MCP server is `strict_mcp_config`, asserted in the options test."""
    engine = make_engine(tmp_path)
    conv = asyncio.run(engine.create_conversation(SYSTEM_PROMPT, "sonnet"))
    cfg = FakeSDKClient.instances[0].options.mcp_servers["pkm"]

    async def listed():
        params = StdioServerParameters(
            command=cfg["command"], args=cfg["args"], env=dict(os.environ))
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return {t.name for t in (await session.list_tools()).tools}

    try:
        names = asyncio.run(asyncio.wait_for(listed(), 30))
    finally:
        asyncio.run(conv.close())
    assert names == set(READ_TOOLS) | set(WRITE_TOOLS)
    assert "upload_asset" not in names


def test_assistant_mcp_server_refuses_a_guarded_write_without_expect(
        tmp_path):
    """The subprocess the harness starts refuses an update_block or batch
    that arrives without `expect`, before any request: the card always sets
    it, so its absence means the card's input never reached the tool."""
    engine = make_engine(tmp_path)
    conv = asyncio.run(engine.create_conversation(SYSTEM_PROMPT, "sonnet"))
    cfg = FakeSDKClient.instances[0].options.mcp_servers["pkm"]

    async def called():
        params = StdioServerParameters(
            command=cfg["command"], args=cfg["args"], env=dict(os.environ))
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return [await session.call_tool(name, args) for name, args in (
                    ("update_block", {"uid": "AAAAAAAA", "text": "t"}),
                    ("batch", {"commands": [{"command": "delete",
                                             "params": {"uid": "AAAAAAAA"}}]}),
                )]

    try:
        results = asyncio.run(asyncio.wait_for(called(), 30))
    finally:
        asyncio.run(conv.close())
    for name, result in zip(("update_block", "batch"), results):
        assert result.isError
        text = " ".join(getattr(c, "text", "") for c in result.content)
        assert f"{name}: no expect argument" in text


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
                "mcp__pkm__save_note", {"text": "Demo", "page": "Demo"}, None
            )
            client.feed(make_result())

        task = asyncio.create_task(fake_model_turn())
        stream = conv.send("save it")
        ev1 = await asyncio.wait_for(anext(stream), timeout=5)  # ConfirmRequest via the queue
        assert isinstance(ev1, ConfirmRequest)
        assert "save_note" in ev1.ops_preview
        conv.resolve_confirm(ev1.confirm_id, True)
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
            decision = await conv.can_use_tool(
                "mcp__pkm__batch",
                {"commands": [{"command": "delete", "params": {"uid": "U1"}}]},
                None)
            client.feed(make_result())
            return decision

        task = asyncio.create_task(decide())
        stream = conv.send("go")
        ev = await asyncio.wait_for(anext(stream), timeout=5)
        assert isinstance(ev, ConfirmRequest)
        conv.resolve_confirm(ev.confirm_id, False)
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
    # An SSE consumer that disconnects mid-turn must not leave the CLI
    # subprocess still executing the abandoned query. A
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
            await conv.can_use_tool("mcp__pkm__save_note", {"text": "Demo"}, None)

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
    # The decline loop must not run *after* awaiting interrupt(), which
    # cannot return while the harness sits inside can_use_tool awaiting the
    # very decision that loop supplies -- otherwise a parked confirm is
    # never answered and the harness stays wedged until the process
    # restarts.
    engine = make_engine(tmp_path, factory=HangingInterruptClient)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        decisions = []

        async def fake_model_turn():
            decisions.append(
                await conv.can_use_tool("mcp__pkm__save_note", {"text": "Demo"}, None)
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
    # Even with nothing pending, cleanup must not hang forever on a harness
    # that never acknowledges the interrupt.
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


# --- an unacknowledged interrupt leaves the harness state uncertain -- the
# conversation must be flagged unhealthy so the service retires it instead
# of reusing it for a later turn. ---


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
    assert ToolStarted(tool_use_id="t1", name="search",
                       summary='searching "alpha"') in events
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


# --- a turn with NO SDK messages at all for the stall window is a dead
# network, not a thinking model: both harnesses emit a steady flow of
# thinking_delta stream events during honest reasoning, so total silence
# means the watchdog kills the turn instead of waiting on the user's
# patience. ---


def test_stalled_turn_times_out_with_an_error_event(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_engine, "STALL_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        events = [ev async for ev in conv.send("hi")]  # nothing ever fed
        await conv.close()
        return conv, client, events

    conv, client, events = asyncio.run(scenario())
    assert len(events) == 1
    assert isinstance(events[0], ErrorEvent)
    assert "no response from the model" in events[0].message.lower()
    # the abandoned query must not keep executing in the subprocess
    assert client.interrupts == 1
    # the interrupt was acknowledged, so the harness is still reusable
    assert conv.healthy is True


def test_stalled_turn_with_wedged_interrupt_marks_unhealthy(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_engine, "STALL_TIMEOUT_S", 0.05)
    monkeypatch.setattr(claude_engine, "INTERRUPT_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path, factory=HangingInterruptClient)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        events = [ev async for ev in conv.send("hi")]
        await conv.close()
        return conv, events

    conv, events = asyncio.run(scenario())
    assert len(events) == 1
    assert isinstance(events[0], ErrorEvent)
    assert conv.healthy is False


def test_sdk_messages_reset_the_stall_deadline(tmp_path, monkeypatch):
    from claude_agent_sdk import StreamEvent

    monkeypatch.setattr(claude_engine, "STALL_TIMEOUT_S", 0.25)
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]

        async def feed_slowly():
            # each gap is well inside the window, but the turn as a whole
            # outlives it -- only total silence may trip the watchdog
            for _ in range(4):
                await asyncio.sleep(0.1)
                client.feed(StreamEvent(uuid="u", session_id="s",
                                        event={"type": "content_block_delta",
                                               "delta": {"type": "text_delta", "text": "x"}}))
            await asyncio.sleep(0.1)
            client.feed(make_result())

        feeder = asyncio.create_task(feed_slowly())
        events = [ev async for ev in conv.send("hi")]
        await feeder
        await conv.close()
        return events

    events = asyncio.run(scenario())
    assert not any(isinstance(ev, ErrorEvent) for ev in events)
    assert isinstance(events[-1], TurnDone)


def test_stall_message_renders_minutes_for_the_production_window():
    assert claude_engine.stall_message(300.0) == (
        "No response from the model for 5 minutes — network problem? The turn was stopped."
    )
    # sub-minute windows (tests, tuning) render as seconds, not "0 minutes"
    assert "0.05 seconds" in claude_engine.stall_message(0.05)


def test_stall_watchdog_suspended_while_confirm_parked(tmp_path, monkeypatch):
    # A user sitting on an approval for ten minutes is normal, not a stall:
    # while a confirm is parked, no SDK messages can flow (the harness is
    # inside can_use_tool), and the watchdog must not kill the turn for it.
    monkeypatch.setattr(claude_engine, "STALL_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        events = []

        async def consume():
            async for ev in conv.send("hi"):
                events.append(ev)

        task = asyncio.create_task(consume())
        decision_task = asyncio.create_task(
            conv.can_use_tool("mcp__pkm__save_note", {"text": "x"}, None)
        )
        await asyncio.sleep(0.2)  # 4x the stall window, parked the whole time
        assert not task.done()
        confirm = next(ev for ev in events if isinstance(ev, ConfirmRequest))
        conv.resolve_confirm(confirm.confirm_id, True)
        await decision_task
        client.feed(make_result())
        await asyncio.wait_for(task, timeout=2)
        await conv.close()
        return events

    events = asyncio.run(scenario())
    assert not any(isinstance(ev, ErrorEvent) for ev in events)
    assert isinstance(events[-1], TurnDone)


def test_turn_mapper_emits_phase_on_content_block_start():
    """content_block_start opens the silent window before an assembled turn:
    the thinking/tool_use block's start arrives ~25-50s before the assembled
    AssistantMessage, so the phase label must come from here. Shapes match
    live dumps from both harnesses (claude + z.ai glm)."""
    from claude_agent_sdk import StreamEvent

    def start(content_block):
        return StreamEvent(uuid="u1", session_id="s1",
                           event={"type": "content_block_start", "content_block": content_block})

    mapper = TurnMapper()
    assert mapper.map(start({"type": "thinking", "thinking": "", "signature": ""})) == [
        Phase(label="reasoning")
    ]
    assert mapper.map(start({"type": "tool_use", "id": "t1", "name": "mcp__pkm__save_note",
                             "input": {}})) == [Phase(label="preparing save_note")]
    assert mapper.map(start({"type": "text", "text": ""})) == [Phase(label="replying")]
    # unknown block types (future API additions) map to nothing rather than
    # a nonsense label
    assert mapper.map(start({"type": "server_tool_use", "id": "t2", "name": "web_search"})) == []
    # a malformed frame with no content_block maps to nothing
    se = StreamEvent(uuid="u1", session_id="s1", event={"type": "content_block_start"})
    assert mapper.map(se) == []


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
    assert mapper.map(assistant_msg) == [
        ToolStarted(tool_use_id="t1", name="search",
                    summary='searching "alpha"')]

    user_msg = UserMessage(content=[ToolResultBlock(tool_use_id="t1", content="ok")])
    assert mapper.map(user_msg) == [
        ToolFinished(tool_use_id="t1", name="search")]

    # an unrecognised tool_use_id (e.g. mapper created fresh mid-turn) falls
    # back to "tool"
    unknown_msg = UserMessage(content=[ToolResultBlock(tool_use_id="unknown", content="ok")])
    assert mapper.map(unknown_msg) == [
        ToolFinished(tool_use_id="unknown", name="tool")]

    # a plain string UserMessage (no tool results) maps to nothing
    assert mapper.map(UserMessage(content="hi")) == []


async def _next_card(conv) -> ConfirmRequest:
    card = await asyncio.wait_for(conv._queue.get(), timeout=5)
    assert isinstance(card, ConfirmRequest)
    return card


async def _two_parked_writes(conv):
    """Park two write-tool approvals: (task_a, task_b, card_a, card_b)."""
    ta = asyncio.create_task(conv.can_use_tool("mcp__pkm__update_block", {"uid": "AAA"}, None))
    tb = asyncio.create_task(conv.can_use_tool("mcp__pkm__update_block", {"uid": "BBB"}, None))
    card_a = await _next_card(conv)
    card_b = await _next_card(conv)
    return ta, tb, card_a, card_b


def test_concurrent_confirms_resolve_only_their_own_card(tmp_path):
    """Each parked write gets its own confirm id, and an approval, a replay
    or an unknown id can only ever release the call the id was minted for."""
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        ta, tb, card_a, card_b = await _two_parked_writes(conv)
        assert "AAA" in card_a.ops_preview
        assert "BBB" in card_b.ops_preview
        assert card_a.confirm_id != card_b.confirm_id

        conv.resolve_confirm(confirm_id_of("confirm-99"), True)
        await asyncio.sleep(0)
        assert not ta.done()
        assert not tb.done()

        conv.resolve_confirm(card_b.confirm_id, True)
        decision_b = await asyncio.wait_for(tb, timeout=5)
        assert isinstance(decision_b, PermissionResultAllow)
        assert not ta.done()

        conv.resolve_confirm(card_b.confirm_id, True)  # replay of a spent id
        await asyncio.sleep(0)
        assert not ta.done()

        conv.resolve_confirm(card_a.confirm_id, False)
        decision_a = await asyncio.wait_for(ta, timeout=5)
        await conv.close()
        return decision_a

    assert isinstance(asyncio.run(scenario()), PermissionResultDeny)


def test_late_confirm_after_resolution_is_a_no_op(tmp_path):
    """Resolving an id whose call already finished neither raises nor
    changes the decision the call returned."""
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        task = asyncio.create_task(conv.can_use_tool("mcp__pkm__update_block", {"uid": "AAA"}, None))
        card = await _next_card(conv)
        conv.resolve_confirm(card.confirm_id, True)
        decision = await asyncio.wait_for(task, timeout=5)
        conv.resolve_confirm(card.confirm_id, False)
        await conv.close()
        return decision

    assert isinstance(asyncio.run(scenario()), PermissionResultAllow)


@pytest.mark.parametrize("tool", ["mcp__other__get_page", "mcp__pkm__delete_everything"])
def test_foreign_and_unknown_tools_are_denied_without_a_card(tmp_path, tool):
    """A tool outside the pkm read/write sets is refused outright, never
    offered to the user as a card to approve."""
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        decision = await asyncio.wait_for(conv.can_use_tool(tool, {}, None), timeout=5)
        queued = conv._queue.qsize()
        await conv.close()
        return decision, queued

    decision, queued = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultDeny)
    assert queued == 0


def test_confirm_card_preview_is_a_snapshot_of_the_input(tmp_path):
    """Mutating the tool input after the card is emitted must not change
    what the user was shown to approve."""
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        params = {"uid": "CCC", "text": "original"}
        tool_input: dict[str, object] = {
            "commands": [{"command": "update", "params": params}]}
        task = asyncio.create_task(conv.can_use_tool("mcp__pkm__batch", tool_input, None))
        card = await _next_card(conv)
        params["text"] = "swapped"
        params["uid"] = "DDD"
        conv.resolve_confirm(card.confirm_id, True)
        await asyncio.wait_for(task, timeout=5)
        await conv.close()
        return card

    card = asyncio.run(scenario())
    assert card.preview.ops[0].content == [("text", "original", 8)]
    assert card.preview.ops[0].targets == [("uid", "CCC")]


def test_refused_write_is_denied_without_a_confirm(tmp_path, caplog):
    """Input the tool's own schema rejects is never offered as a card:
    the model gets the reason, the user sees nothing to approve."""
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        decision = await asyncio.wait_for(
            conv.can_use_tool("mcp__pkm__batch", {"commands": "nope"}, None),
            timeout=5)
        queued = conv._queue.qsize()
        pending = len(conv._pending)
        await conv.close()
        return decision, queued, pending

    with caplog.at_level(logging.WARNING, logger="pkm.assistant"):
        decision, queued, pending = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultDeny)
    assert "batch" in decision.message
    assert queued == 0
    assert pending == 0
    refusals = [r for r in caplog.records if "refused" in r.getMessage()]
    assert refusals and refusals[0].levelno == logging.WARNING
    assert "batch" in refusals[0].getMessage()


def test_confirm_request_carries_structured_preview(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        task = asyncio.create_task(conv.can_use_tool(
            "mcp__pkm__update_block",
            {"text": "x" * 3000, "uid": "VICTIMUID01"}, None))
        card = await _next_card(conv)
        conv.resolve_confirm(card.confirm_id, False)
        await asyncio.wait_for(task, timeout=5)
        await conv.close()
        return card

    card = asyncio.run(scenario())
    assert card.preview.ops[0].targets[0] == ("uid", "VICTIMUID01")
    assert card.ops_preview == card.preview.summary


def test_confirm_card_shows_the_blocks_current_text(tmp_path):
    victim = uid_of("VICTIMUID01")
    inbox = canonical_title_of("Inbox")
    reads: list[list[str]] = []

    def read_blocks(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
            ancestors_of: Collection[BlockUid]):
        reads.append(list(uids))
        return {victim: StoredBlock(inbox, "old")}

    engine = make_engine(tmp_path, read_blocks=read_blocks)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        task = asyncio.create_task(conv.can_use_tool(
            "mcp__pkm__update_block", {"text": "new", "uid": victim}, None))
        card = await _next_card(conv)
        conv.resolve_confirm(card.confirm_id, False)
        await asyncio.wait_for(task, timeout=5)
        await conv.close()
        return card

    card = asyncio.run(scenario())
    assert card.preview.ops[0].current == FoundBlock(inbox, "old", 3)
    assert reads == [[victim]]


def test_an_unreadable_target_is_refused_not_shown(tmp_path):
    def read_blocks(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
            ancestors_of: Collection[BlockUid]):
        raise OSError("disk gone")

    engine = make_engine(tmp_path, read_blocks=read_blocks)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        decision = await asyncio.wait_for(conv.can_use_tool(
            "mcp__pkm__update_block",
            {"text": "new", "uid": "VICTIMUID01"}, None), timeout=5)
        queued = conv._queue.qsize()
        await conv.close()
        return decision, queued

    decision, queued = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultDeny)
    assert decision.message == (
        "update_block: the blocks this write changes could not be read")
    assert queued == 0


# -- what Allow hands the tool ---------------------------------------------

def _no_blocks(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
               ancestors_of: Collection[BlockUid]):
    return {}


def _allowed(tmp_path, short: str, tool_input: dict[str, object],
             read_blocks=_no_blocks, before_allow=lambda: None
             ) -> PermissionResultAllow:
    """Park the card for write `short`, run `before_allow`, then Allow it:
    the decision the SDK receives."""
    engine = make_engine(tmp_path, read_blocks=read_blocks)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        task = asyncio.create_task(conv.can_use_tool(
            f"mcp__pkm__{short}", tool_input, None))
        card = await _next_card(conv)
        before_allow()
        conv.resolve_confirm(card.confirm_id, True)
        decision = await asyncio.wait_for(task, timeout=5)
        await conv.close()
        return decision

    decision = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultAllow)
    return decision


def _inbox_old(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
               ancestors_of: Collection[BlockUid]):
    return {uid_of("AAAAAAAA"): StoredBlock(canonical_title_of("Inbox"),
                                            "old")}


def test_allow_hands_the_tool_the_carded_input_with_expect(tmp_path):
    a = uid_of("AAAAAAAA")
    decision = _allowed(tmp_path, "update_block", {"uid": a, "text": "new"},
                        _inbox_old)
    assert decision.updated_input == {
        "uid": a, "text": "new",
        "expect": [{"uid": a, "kind": "text",
                    "shown_hash": text_hash("old")}]}


@pytest.mark.parametrize("short,tool_input", [
    ("save_note", {"text": "Demo", "page": "Demo"}),
    ("rename_page", {"title": "Old", "new_title": "New"}),
])
def test_allow_carries_updated_input_for_every_write_tool(
        tmp_path, short, tool_input):
    # never None: the SDK would then send the model's own input
    decision = _allowed(tmp_path, short, dict(tool_input))
    assert decision.updated_input == tool_input


def test_allow_input_ignores_a_change_to_the_dict_after_the_card(tmp_path):
    a = uid_of("AAAAAAAA")
    tool_input: dict[str, object] = {"uid": a, "text": "new"}

    def tamper() -> None:
        tool_input["text"] = "swapped"
        tool_input["uid"] = uid_of("BBBBBBBB")
        tool_input["expect"] = []

    decision = _allowed(tmp_path, "update_block", tool_input, _inbox_old,
                        tamper)
    assert decision.updated_input == {
        "uid": a, "text": "new",
        "expect": [{"uid": a, "kind": "text",
                    "shown_hash": text_hash("old")}]}


@pytest.mark.parametrize("short,tool_input", [
    ("update_block", {"uid": "AAAAAAAA", "text": "t", "expect": []}),
    ("batch", {"commands": [{"command": "delete",
                             "params": {"uid": "AAAAAAAA"}}],
               "expect": None}),
])
def test_a_model_expect_is_denied_without_a_card(tmp_path, short,
                                                  tool_input):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        decision = await asyncio.wait_for(conv.can_use_tool(
            f"mcp__pkm__{short}", tool_input, None), timeout=5)
        queued = conv._queue.qsize()
        await conv.close()
        return decision, queued

    decision, queued = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultDeny)
    assert decision.message == (
        f"{short}: expect is set by the approval card, never by the caller")
    assert queued == 0


# -- whether another write of the turn could land after a card's read -----

_UPDATE = "mcp__pkm__update_block"


def _ctx(tool_use_id: str) -> ToolPermissionContext:
    return ToolPermissionContext(tool_use_id=tool_use_id)


def test_a_lone_card_has_no_write_in_flight(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        task = asyncio.create_task(conv.can_use_tool(
            _UPDATE, {"uid": "AAAAAAAA", "text": "t"}, _ctx("t1")))
        card = await _next_card(conv)
        conv.resolve_confirm(card.confirm_id, False)
        await asyncio.wait_for(task, timeout=5)
        await conv.close()
        return card

    assert asyncio.run(scenario()).preview.writes_in_flight is False


def test_a_card_read_while_another_waits_on_the_user_is_stamped(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        ta = asyncio.create_task(conv.can_use_tool(
            _UPDATE, {"uid": "AAAAAAAA", "text": "t"}, _ctx("t1")))
        card_a = await _next_card(conv)
        tb = asyncio.create_task(conv.can_use_tool(
            _UPDATE, {"uid": "BBBBBBBB", "text": "t"}, _ctx("t2")))
        card_b = await _next_card(conv)
        for card in (card_a, card_b):
            conv.resolve_confirm(card.confirm_id, False)
        await asyncio.wait_for(asyncio.gather(ta, tb), timeout=5)
        await conv.close()
        return card_a, card_b

    card_a, card_b = asyncio.run(scenario())
    assert card_a.preview.writes_in_flight is False
    assert card_b.preview.writes_in_flight is True


async def _drain_into(stream, seen: asyncio.Queue) -> None:
    async for ev in stream:
        await seen.put(ev)


async def _next_of(seen: asyncio.Queue, kind: type):
    while True:
        ev = await asyncio.wait_for(seen.get(), timeout=5)
        if isinstance(ev, kind):
            return ev


def test_a_card_read_while_an_allowed_write_runs_is_stamped(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        seen: asyncio.Queue = asyncio.Queue()
        consumer = asyncio.create_task(_drain_into(conv.send("go"), seen))

        async def card_for(target: str, tool_use_id: str, allow: bool):
            task = asyncio.create_task(conv.can_use_tool(
                _UPDATE, {"uid": target, "text": "t"}, _ctx(tool_use_id)))
            card = await _next_of(seen, ConfirmRequest)
            conv.resolve_confirm(card.confirm_id, allow)
            await asyncio.wait_for(task, timeout=5)
            return card

        first = await card_for("AAAAAAAA", "t1", True)
        # t1 is allowed and has not finished: it may land after this read
        running = await card_for("BBBBBBBB", "t2", False)
        client.feed(UserMessage(content=[
            ToolResultBlock(tool_use_id="t1", content="ok")]))
        await _next_of(seen, ToolFinished)
        # t1 has finished and t2 was denied: nothing else can land
        after = await card_for("CCCCCCCC", "t3", False)
        client.feed(make_result())
        await asyncio.wait_for(consumer, timeout=5)
        await conv.close()
        return first, running, after

    first, running, after = asyncio.run(scenario())
    assert first.preview.writes_in_flight is False
    assert running.preview.writes_in_flight is True
    assert after.preview.writes_in_flight is False


def test_an_allowed_write_without_a_tool_use_id_runs_until_the_turn_ends(
        tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        cards = []
        for uid in ("AAAAAAAA", "BBBBBBBB"):
            task = asyncio.create_task(conv.can_use_tool(
                _UPDATE, {"uid": uid, "text": "t"}, None))
            card = await _next_card(conv)
            conv.resolve_confirm(card.confirm_id, True)
            await asyncio.wait_for(task, timeout=5)
            cards.append(card)
        await conv.close()
        return cards

    first, second = asyncio.run(scenario())
    assert first.preview.writes_in_flight is False
    assert second.preview.writes_in_flight is True


def test_a_write_that_lands_during_a_read_stamps_the_card(tmp_path):
    import threading
    gate = threading.Event()

    def reader(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
               ancestors_of: Collection[BlockUid]):
        if uid_of("BBBBBBBB") in uids:
            gate.wait(5)
        return {}

    engine = make_engine(tmp_path, read_blocks=reader)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        seen: asyncio.Queue = asyncio.Queue()
        consumer = asyncio.create_task(_drain_into(conv.send("go"), seen))
        # B starts reading first and is held there
        tb = asyncio.create_task(conv.can_use_tool(
            _UPDATE, {"uid": "BBBBBBBB", "text": "t"}, _ctx("t2")))
        await asyncio.sleep(0.05)
        ta = asyncio.create_task(conv.can_use_tool(
            _UPDATE, {"uid": "AAAAAAAA", "text": "t"}, _ctx("t1")))
        card_a = await _next_of(seen, ConfirmRequest)
        conv.resolve_confirm(card_a.confirm_id, True)
        await asyncio.wait_for(ta, timeout=5)
        client.feed(UserMessage(content=[
            ToolResultBlock(tool_use_id="t1", content="ok")]))
        await _next_of(seen, ToolFinished)
        # A was allowed and finished while B was reading
        gate.set()
        card_b = await _next_of(seen, ConfirmRequest)
        conv.resolve_confirm(card_b.confirm_id, False)
        await asyncio.wait_for(tb, timeout=5)
        client.feed(make_result())
        await asyncio.wait_for(consumer, timeout=5)
        await conv.close()
        return card_a, card_b

    card_a, card_b = asyncio.run(scenario())
    assert card_a.preview.writes_in_flight is False
    assert card_b.preview.writes_in_flight is True


def test_a_write_running_when_a_read_starts_stamps_the_card(tmp_path):
    import threading
    gate = threading.Event()

    def reader(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
               ancestors_of: Collection[BlockUid]):
        if uid_of("BBBBBBBB") in uids:
            gate.wait(5)
        return {}

    engine = make_engine(tmp_path, read_blocks=reader)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        seen: asyncio.Queue = asyncio.Queue()
        consumer = asyncio.create_task(_drain_into(conv.send("go"), seen))
        ta = asyncio.create_task(conv.can_use_tool(
            _UPDATE, {"uid": "AAAAAAAA", "text": "t"}, _ctx("t1")))
        card_a = await _next_of(seen, ConfirmRequest)
        conv.resolve_confirm(card_a.confirm_id, True)
        await asyncio.wait_for(ta, timeout=5)
        # B starts reading while t1 runs; t1 finishes before B's read ends
        tb = asyncio.create_task(conv.can_use_tool(
            _UPDATE, {"uid": "BBBBBBBB", "text": "t"}, _ctx("t2")))
        await asyncio.sleep(0.05)
        client.feed(UserMessage(content=[
            ToolResultBlock(tool_use_id="t1", content="ok")]))
        await _next_of(seen, ToolFinished)
        gate.set()
        card_b = await _next_of(seen, ConfirmRequest)
        conv.resolve_confirm(card_b.confirm_id, False)
        await asyncio.wait_for(tb, timeout=5)
        client.feed(make_result())
        await asyncio.wait_for(consumer, timeout=5)
        await conv.close()
        return card_b

    assert asyncio.run(scenario()).preview.writes_in_flight is True


async def _stop_with_an_allowed_write(conv) -> None:
    """Turn one: allow t1's write, then Stop before its result arrives."""
    one = conv.send("one")
    task = asyncio.create_task(conv.can_use_tool(
        _UPDATE, {"uid": "AAAAAAAA", "text": "t"}, _ctx("t1")))
    card = await asyncio.wait_for(anext(one), timeout=5)
    assert isinstance(card, ConfirmRequest)
    conv.resolve_confirm(card.confirm_id, True)
    await asyncio.wait_for(task, timeout=5)
    await one.aclose()  # Stop: t1 allowed, no result yet


async def _declined_card(conv, seen: asyncio.Queue, target: str,
                         tool_use_id: str) -> ConfirmRequest:
    t = asyncio.create_task(conv.can_use_tool(
        _UPDATE, {"uid": target, "text": "t"}, _ctx(tool_use_id)))
    c = await _next_of(seen, ConfirmRequest)
    conv.resolve_confirm(c.confirm_id, False)
    await asyncio.wait_for(t, timeout=5)
    return c


def test_a_stopped_turns_running_write_stamps_the_next_turns_cards(
        tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        await _stop_with_an_allowed_write(conv)

        seen: asyncio.Queue = asyncio.Queue()
        consumer = asyncio.create_task(_drain_into(conv.send("two"), seen))
        stamped = await _declined_card(conv, seen, "BBBBBBBB", "t2")
        client.feed(UserMessage(content=[
            ToolResultBlock(tool_use_id="t1", content="ok")]))
        await _next_of(seen, ToolFinished)
        clear = await _declined_card(conv, seen, "CCCCCCCC", "t3")
        client.feed(make_result())
        await asyncio.wait_for(consumer, timeout=5)
        await conv.close()
        return stamped, clear

    stamped, clear = asyncio.run(scenario())
    assert stamped.preview.writes_in_flight is True
    assert clear.preview.writes_in_flight is False


def test_a_stopped_turns_write_with_no_result_ends_with_the_next_turn(
        tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        await _stop_with_an_allowed_write(conv)
        cards = []
        for turn, target, tool_use_id in (("two", "BBBBBBBB", "t2"),
                                          ("three", "CCCCCCCC", "t3")):
            seen: asyncio.Queue = asyncio.Queue()
            consumer = asyncio.create_task(_drain_into(conv.send(turn), seen))
            cards.append(
                await _declined_card(conv, seen, target, tool_use_id))
            client.feed(make_result())
            await asyncio.wait_for(consumer, timeout=5)
        await conv.close()
        return cards

    second, third = asyncio.run(scenario())
    assert second.preview.writes_in_flight is True
    assert third.preview.writes_in_flight is False


def test_an_errored_turns_running_write_stamps_the_next_turns_card(
        tmp_path, monkeypatch):
    monkeypatch.setattr(claude_engine, "STALL_TIMEOUT_S", 0.05)
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        seen: asyncio.Queue = asyncio.Queue()
        consumer = asyncio.create_task(_drain_into(conv.send("one"), seen))
        task = asyncio.create_task(conv.can_use_tool(
            _UPDATE, {"uid": "AAAAAAAA", "text": "t"}, _ctx("t1")))
        card = await _next_of(seen, ConfirmRequest)
        conv.resolve_confirm(card.confirm_id, True)
        await asyncio.wait_for(task, timeout=5)
        # no result for t1, then silence: the turn ends in an error
        await _next_of(seen, ErrorEvent)
        await asyncio.wait_for(consumer, timeout=5)
        monkeypatch.setattr(claude_engine, "STALL_TIMEOUT_S", 30)

        seen = asyncio.Queue()
        consumer = asyncio.create_task(_drain_into(conv.send("two"), seen))
        stamped = await _declined_card(conv, seen, "BBBBBBBB", "t2")
        client.feed(make_result())
        await asyncio.wait_for(consumer, timeout=5)
        await conv.close()
        return stamped

    assert asyncio.run(scenario()).preview.writes_in_flight is True


def test_the_last_turns_writes_are_not_in_flight(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        cards = []
        for turn, uid in (("one", "AAAAAAAA"), ("two", "BBBBBBBB")):
            seen: asyncio.Queue = asyncio.Queue()
            consumer = asyncio.create_task(_drain_into(conv.send(turn), seen))
            # no tool_use_id: the write counts as running until the turn ends
            task = asyncio.create_task(conv.can_use_tool(
                _UPDATE, {"uid": uid, "text": "t"}, None))
            card = await _next_of(seen, ConfirmRequest)
            conv.resolve_confirm(card.confirm_id, True)
            await asyncio.wait_for(task, timeout=5)
            client.feed(make_result())
            await asyncio.wait_for(consumer, timeout=5)
            cards.append(card)
        await conv.close()
        return cards

    first, second = asyncio.run(scenario())
    assert first.preview.writes_in_flight is False
    assert second.preview.writes_in_flight is False


# -- a write's error and decline reach the tool event ---------------------

_REFUSED = ("Error executing tool update_block: block ((AAAAAAAA)) changed "
            "after the approval card showed it, so nothing was written")
_REASON = _REFUSED.removeprefix("Error executing tool update_block: ")


def _use(tool_id: str, name: str = _UPDATE) -> AssistantMessage:
    return AssistantMessage(content=[ToolUseBlock(
        id=tool_id, name=name, input={"uid": "AAAAAAAA", "text": "t"})],
        model="sonnet")


def _result(tool_id: str, is_error: bool | None,
            text: str = _REFUSED) -> UserMessage:
    return UserMessage(content=[ToolResultBlock(
        tool_use_id=tool_id, content=[{"type": "text", "text": text}],
        is_error=is_error)])


def test_turn_mapper_carries_a_write_tools_error():
    mapper = TurnMapper()
    mapper.map(_use("t1"))
    assert mapper.map(_result("t1", True)) == [ToolFinished(
        tool_use_id="t1", name="update_block", error=_REASON)]


def test_turn_mapper_ignores_read_errors_and_write_successes():
    mapper = TurnMapper()
    mapper.map(_use("r1", "mcp__pkm__search"))
    assert mapper.map(_result("r1", True)) == [
        ToolFinished(tool_use_id="r1", name="search")]
    for tool_id, flag in (("w1", None), ("w2", False)):
        mapper.map(_use(tool_id))
        assert mapper.map(_result(tool_id, flag)) == [
            ToolFinished(tool_use_id=tool_id, name="update_block")]


def test_turn_mappers_sharing_a_map_carry_a_write_across_turns():
    tools: dict[str, str] = {}
    TurnMapper(tools).map(_use("t1"))
    assert TurnMapper(tools).map(_result("t1", True)) == [ToolFinished(
        tool_use_id="t1", name="update_block", error=_REASON)]
    assert tools == {}  # the result popped its id


_SKIPPED = ("warning: skipped 1 of 3 ops; the rest were applied\n"
            "- op 2: block ((AAAAAAAA)) not found")


def test_turn_mapper_carries_a_skipped_batch_warning_first_line():
    mapper = TurnMapper()
    mapper.map(_use("t1"))
    assert mapper.map(_result("t1", False, _SKIPPED)) == [ToolFinished(
        tool_use_id="t1", name="update_block",
        warning="warning: skipped 1 of 3 ops; the rest were applied")]


def test_turn_mapper_shows_no_warning_on_an_error_or_declined_result():
    mapper = TurnMapper(declined={"t2"})
    mapper.map(_use("t1"))
    mapper.map(_use("t2"))
    [failed] = mapper.map(_result("t1", True, _SKIPPED))
    [declined] = mapper.map(_result("t2", True, _SKIPPED))
    assert isinstance(failed, ToolFinished)
    assert failed.error is not None and failed.warning is None
    assert isinstance(declined, ToolFinished)
    assert declined.declined is True and declined.warning is None


def test_turn_mapper_clips_a_long_warning_like_an_error_reason():
    mapper = TurnMapper()
    mapper.map(_use("t1"))
    text = "warning: " + "x" * 400
    clipped = text[:300] + f"… ({len(text):,} characters)"
    assert mapper.map(_result("t1", None, text)) == [ToolFinished(
        tool_use_id="t1", name="update_block", warning=clipped)]


def test_turn_mapper_leaves_warning_unset_without_the_prefix_or_on_reads():
    mapper = TurnMapper()
    mapper.map(_use("w1"))
    assert mapper.map(_result("w1", False, "ok: applied 3 ops")) == [
        ToolFinished(tool_use_id="w1", name="update_block")]
    mapper.map(_use("r1", "mcp__pkm__search"))
    assert mapper.map(_result("r1", False, _SKIPPED)) == [
        ToolFinished(tool_use_id="r1", name="search")]


def test_turn_mapper_marks_a_declined_write_not_failed():
    tools: dict[str, str] = {}
    mapper = TurnMapper(tools, declined={"t1"})
    mapper.map(_use("t1"))
    assert mapper.map(_result("t1", True, "The user declined this action.")
                      ) == [ToolFinished(tool_use_id="t1",
                                         name="update_block",
                                         declined=True)]


def test_a_decline_is_recorded_per_call_by_the_conversation(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        seen: asyncio.Queue = asyncio.Queue()
        consumer = asyncio.create_task(_drain_into(conv.send("one"), seen))
        await _declined_card(conv, seen, "AAAAAAAA", "t1")
        client.feed(_use("t1"), _use("t2"),
                    _result("t1", True, "The user declined this action."),
                    _result("t2", True), make_result())
        await asyncio.wait_for(consumer, timeout=5)
        await conv.close()
        out = []
        while not seen.empty():
            out.append(seen.get_nowait())
        return out

    finished = [e for e in asyncio.run(scenario())
                if isinstance(e, ToolFinished)]
    assert finished == [
        ToolFinished(tool_use_id="t1", name="update_block", declined=True),
        ToolFinished(tool_use_id="t2", name="update_block", error=_REASON)]


def test_a_stopped_turns_refused_write_shows_its_error_next_turn(tmp_path):
    engine = make_engine(tmp_path)

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]
        one = conv.send("one")
        task = asyncio.create_task(anext(one))
        client.feed(_use("t1"))
        started = await asyncio.wait_for(task, timeout=5)
        assert isinstance(started, ToolStarted)
        await one.aclose()  # Stop
        seen: asyncio.Queue = asyncio.Queue()
        consumer = asyncio.create_task(_drain_into(conv.send("two"), seen))
        client.feed(_result("t1", True), make_result())
        finished = await _next_of(seen, ToolFinished)
        await asyncio.wait_for(consumer, timeout=5)
        await conv.close()
        return finished

    assert asyncio.run(scenario()) == ToolFinished(
        tool_use_id="t1", name="update_block", error=_REASON)
