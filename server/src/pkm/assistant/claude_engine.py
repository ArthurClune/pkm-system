# pattern: Imperative Shell
"""Claude Agent SDK adapter: harness subprocess confined to the pkm MCP tools."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import sys
import tempfile
import time
from collections.abc import AsyncGenerator, Callable
from pathlib import Path
from typing import Any

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    StreamEvent,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from pkm.assistant.events import (
    AssistantEvent,
    ConfirmRequest,
    ErrorEvent,
    TextDelta,
    ToolFinished,
    ToolStarted,
    TurnDone,
)
from pkm.assistant.policy import (
    ZAI_MODELS,
    classify_tool,
    ops_preview,
    read_tool_names,
    short_tool_name,
    tool_summary,
)
from pkm.server.auth_core import sign_session

logger = logging.getLogger("pkm.assistant")

MAX_TURNS = 40

# z.ai's Anthropic-compatible endpoint (GLM Coding Plan). It maps the Claude
# model aliases to its plan-default GLM server-side, so requesting "sonnet"
# through it always gets the plan's current GLM — no version name to go stale.
ZAI_BASE_URL = "https://api.z.ai/api/anthropic"
ZAI_SDK_MODEL = "sonnet"

# A harness parked inside can_use_tool cannot acknowledge an interrupt until
# the permission decision arrives, and it may be wedged for other reasons
# too. Cleanup after a dropped consumer must never hang on it (pkm-mbcc).
INTERRUPT_TIMEOUT_S = 5.0


class TurnMapper:
    """Pure-ish mapping from SDK messages to AssistantEvents.

    Prefers partial text deltas; falls back to whole TextBlocks when no
    deltas were seen (older CLI versions).
    """

    def __init__(self) -> None:
        self._saw_delta = False
        self._tool_names: dict[str, str] = {}

    def map(self, msg: Any) -> list[AssistantEvent]:
        if isinstance(msg, StreamEvent):
            event = msg.event
            if event.get("type") == "content_block_delta":
                delta = event.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    self._saw_delta = True
                    return [TextDelta(text=delta["text"])]
            return []
        if isinstance(msg, AssistantMessage):
            out: list[AssistantEvent] = []
            for block in msg.content:
                if isinstance(block, TextBlock) and not self._saw_delta:
                    out.append(TextDelta(text=block.text))
                elif isinstance(block, ToolUseBlock):
                    short = short_tool_name(block.name)
                    self._tool_names[block.id] = short
                    out.append(ToolStarted(name=short, summary=tool_summary(short, block.input or {})))
            return out
        if isinstance(msg, UserMessage):
            content = msg.content
            if not isinstance(content, list):
                return []
            out = []
            for block in content:
                if isinstance(block, ToolResultBlock):
                    name = self._tool_names.get(block.tool_use_id, "tool")
                    out.append(ToolFinished(name=name))
            return out
        if isinstance(msg, ResultMessage):
            if msg.is_error:
                return [ErrorEvent(message=f"assistant error: {msg.subtype}")]
            return [TurnDone(usage=msg.usage)]
        return []


class ClaudeConversation:
    def __init__(self, config_path: Path) -> None:
        self._config_path = config_path
        self._client: Any = None
        self._queue: asyncio.Queue[AssistantEvent] = asyncio.Queue()
        self._pending: dict[str, asyncio.Future[bool]] = {}
        self._confirm_seq = 0
        self._pump_task: asyncio.Task[None] | None = None
        # Flips to False the moment an interrupt on this harness goes
        # unacknowledged (timed out or raised) -- see send()'s cleanup
        # below. The owner (AssistantService) checks this after the turn
        # ends and retires rather than reuses a handle gone unhealthy
        # (pkm-rwwc).
        self.healthy = True

    def attach(self, client: Any) -> None:
        self._client = client

    async def can_use_tool(self, tool_name: str, tool_input: dict, context: Any) -> Any:
        kind = classify_tool(tool_name)
        if kind == "read":
            return PermissionResultAllow()
        if kind != "write":
            logger.warning("assistant requested unexpected tool %s", tool_name)
            return PermissionResultDeny(message="Tool not permitted.")
        self._confirm_seq += 1
        tool_use_id = f"confirm-{self._confirm_seq}"
        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._pending[tool_use_id] = fut
        short = short_tool_name(tool_name)
        await self._queue.put(
            ConfirmRequest(tool_use_id=tool_use_id, ops_preview=ops_preview(short, tool_input or {}))
        )
        try:
            allowed = await fut
        finally:
            self._pending.pop(tool_use_id, None)
        if allowed:
            return PermissionResultAllow()
        return PermissionResultDeny(message="The user declined this action.")

    def resolve_confirm(self, tool_use_id: str, allow: bool) -> None:
        fut = self._pending.get(tool_use_id)
        if fut is not None and not fut.done():
            fut.set_result(allow)

    async def send(self, text: str) -> AsyncGenerator[AssistantEvent, None]:
        # a dropped SSE stream can abandon a turn mid-queue; leftovers must
        # not leak into the next turn
        while not self._queue.empty():
            self._queue.get_nowait()
        await self._client.query(text)
        mapper = TurnMapper()
        pump = asyncio.create_task(self._pump(mapper))
        self._pump_task = pump
        finished = False
        try:
            while True:
                event = await self._queue.get()
                yield event
                if isinstance(event, (TurnDone, ErrorEvent)):
                    finished = True
                    break
        finally:
            if not finished:
                await self._abandon_turn()
            # if the consumer went away mid-turn, don't block generator
            # close on a live harness turn
            if not pump.done():
                pump.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pump
            if self._pump_task is pump:
                self._pump_task = None

    def _decline_pending(self) -> None:
        """Answer every parked confirm with a decline.

        A `can_use_tool` hook may be awaiting a decision that will never
        arrive now -- the consumer is gone, or the conversation is closing --
        and an unresolved future leaves the harness wedged inside the hook.
        """
        for fut in self._pending.values():
            if not fut.done():
                fut.set_result(False)

    async def _abandon_turn(self) -> None:
        """Give up on the turn in flight: decline, interrupt, judge health.

        Runs when the consumer dropped mid-turn -- browser closed the tab,
        navigated away, or the fetch was aborted via the Stop button. The SSE
        layer closes this generator explicitly (`routes._abandon_stream`) so
        that this protocol runs on a schedule rather than whenever an orphaned
        generator is finalized.

        Decline FIRST. The harness cannot answer an interrupt while it sits in
        `can_use_tool` awaiting the very decision this supplies, so doing it
        after `interrupt()` left the decline unreachable in exactly the case
        it exists for (pkm-mbcc defect 2: a wedged harness, no tool_result,
        and a panel showing nothing at all, until the process restarted).
        """
        self._decline_pending()
        # Then stop the harness: cancelling our local pump task only stops us
        # from reading further messages, it does NOT stop the CLI subprocess
        # from continuing to execute the abandoned query. Bounded, because a
        # harness wedged for any other reason must not hold up this cleanup
        # either.
        try:
            await asyncio.wait_for(self._client.interrupt(), INTERRUPT_TIMEOUT_S)
        except TimeoutError:
            logger.warning(
                "assistant interrupt not acknowledged in %ss; abandoning the turn "
                "and retiring the harness",
                INTERRUPT_TIMEOUT_S,
            )
            # The subprocess may still be executing the abandoned turn: an
            # interrupt it never acknowledged is not proof it stopped. Mark
            # this handle unhealthy so the caller (AssistantService) tears it
            # down instead of handing it a later turn (pkm-rwwc).
            self.healthy = False
        except Exception:
            logger.exception("assistant interrupt failed; retiring the harness")
            self.healthy = False

    async def _pump(self, mapper: TurnMapper) -> None:
        try:
            async for msg in self._client.receive_response():
                for event in mapper.map(msg):
                    await self._queue.put(event)
        except Exception as exc:  # subprocess died, JSON decode, etc.
            logger.exception("assistant turn failed")
            await self._queue.put(ErrorEvent(message=str(exc)))

    async def close(self) -> None:
        self._decline_pending()
        try:
            if self._pump_task is not None and not self._pump_task.done():
                self._pump_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._pump_task
                self._pump_task = None
                # unblock any live send() consumer stuck on queue.get()
                await self._queue.put(ErrorEvent(message="conversation closed"))
            if self._client is not None:
                try:
                    await self._client.disconnect()
                except Exception:  # already dead is fine
                    logger.exception("assistant disconnect failed")
        finally:
            # A second cancellation landing anywhere above -- e.g. a
            # create_timeout cancellation (service.py's admission-lock
            # wait_for) followed by the enclosing request task itself being
            # cancelled -- is BaseException, not Exception, so the `except
            # Exception` guard on disconnect() does not catch it. The 0600
            # session-token file must still be removed even then, so the
            # unlink lives in this `finally` rather than as a trailing
            # statement a second cancellation could skip (pkm-4zq4 fix
            # round 1).
            self._config_path.unlink(missing_ok=True)


class ClaudeEngine:
    def __init__(
        self,
        *,
        base_url: str,
        session_secret_hex: str,
        client_factory: Callable[[ClaudeAgentOptions], Any] | None = None,
        config_dir: Path | None = None,
        zai_token: str | None = None,
    ) -> None:
        self._base_url = base_url
        self._secret = session_secret_hex
        self._client_factory = client_factory or (lambda opts: ClaudeSDKClient(options=opts))
        self._config_dir = config_dir
        self._zai_token = zai_token

    def _write_cli_config(self) -> Path:
        token = sign_session(bytes.fromhex(self._secret), int(time.time() * 1000))
        fd, raw_path = tempfile.mkstemp(prefix="pkm-assistant-", suffix=".json", dir=self._config_dir)
        path = Path(raw_path)
        with os.fdopen(fd, "w") as fh:  # mkstemp is already 0600
            json.dump({"url": self._base_url, "token": token}, fh)
        return path

    async def create_conversation(self, system_prompt: str, model: str) -> ClaudeConversation:
        # the CLI defers MCP tools behind ToolSearch by default, which
        # tools=[] would make unreachable -- disabling tool search loads
        # the pkm tools eagerly; verified live 2026-07-27
        env = {"ENABLE_TOOL_SEARCH": "false"}
        requested = model
        if model in ZAI_MODELS:
            # Reject before the credential file or any subprocess exists;
            # routes surface this as a 400. The models endpoint hides these
            # models from the picker in this state, so only a hand-crafted
            # request gets here.
            if not self._zai_token:
                raise ValueError(f"model {model!r} requires a z.ai key (zai_api_key_file)")
            env["ANTHROPIC_BASE_URL"] = ZAI_BASE_URL
            env["ANTHROPIC_AUTH_TOKEN"] = self._zai_token
            model = ZAI_SDK_MODEL
        config_path = self._write_cli_config()
        conversation = ClaudeConversation(config_path)
        try:
            options = ClaudeAgentOptions(
                model=model,
                system_prompt=system_prompt,
                tools=[],
                allowed_tools=read_tool_names(),
                can_use_tool=conversation.can_use_tool,
                mcp_servers={
                    "pkm": {
                        "type": "stdio",
                        "command": sys.executable,
                        "args": ["-m", "pkm.mcp.server"],
                        "env": {"PKM_CLI_CONFIG": str(config_path)},
                    }
                },
                setting_sources=[],
                include_partial_messages=True,
                max_turns=MAX_TURNS,
                env=env,
            )
            client = self._client_factory(options)
            conversation.attach(client)
            await client.connect()
        except BaseException:
            # A factory failure, a failed connect handshake, or cancellation
            # while awaiting connect (service.create()'s admission-lock
            # wait_for(create_timeout) times out on a wedged harness,
            # pkm-rovq) must not leave the 0600 credential file or a
            # half-started client behind for the next create() to trip over.
            # ClaudeConversation.close() already tolerates a client that
            # never connected (or was never attached) and a disconnect()
            # that itself raises, so reuse it instead of duplicating that
            # handling here (pkm-4zq4).
            await conversation.close()
            raise
        # the requested name, not the SDK alias: a glm harness must not log
        # as a real sonnet run
        logger.info("assistant harness started (model=%s)", requested)
        return conversation
