# pattern: Imperative Shell
"""Claude Agent SDK adapter: harness subprocess confined to the pkm MCP
tools."""

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
from dataclasses import replace
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
    ToolPermissionContext,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from pkm.assistant.events import (
    AssistantEvent,
    ConfirmRequest,
    ErrorEvent,
    Phase,
    TextDelta,
    ToolFinished,
    ToolStarted,
    TurnDone,
    tool_error_reason,
    tool_warning,
)
from pkm.assistant.harness_env import resolve_harness_env
from pkm.assistant.policy import (
    READ_TOOLS,
    WRITE_TOOLS,
    classify_tool,
    read_tool_names,
    short_tool_name,
    tool_summary,
)
from pkm.assistant.target_reader import BlockReader, preview_write
from pkm.assistant.write_preview import Refusal
from pkm.contracts.responses import ConfirmId
from pkm.server.auth_core import sign_session

logger = logging.getLogger("pkm.assistant")

MAX_TURNS = 40

# A harness parked inside can_use_tool cannot acknowledge an interrupt until
# the permission decision arrives, and it may be wedged for other reasons
# too. Cleanup after a dropped consumer must never hang on it.
INTERRUPT_TIMEOUT_S = 5.0

# The SDK's model request has no first-token timeout: on a dead network the
# turn waits forever and only the user's patience ends it (2026-07-31 outage:
# 7.5 minutes of "thinking..." dead air). Total SDK-message silence this long
# is unambiguously a stall -- during honest reasoning both harnesses emit a
# steady flow of thinking_delta stream events (verified live 2026-08-19)
# -- EXCEPT while a confirm is parked on the user, whose silence is
# never a stall (see _pump).
STALL_TIMEOUT_S = 300.0


def finished_tool_ids(msg: object) -> list[str]:
    """The tool calls whose results `msg` carries."""
    if not isinstance(msg, UserMessage) or not isinstance(msg.content, list):
        return []
    return [block.tool_use_id for block in msg.content
            if isinstance(block, ToolResultBlock)]


def stall_message(seconds: float) -> str:
    window = f"{int(seconds // 60)} minutes" if seconds >= 120 and seconds % 60 == 0 else f"{seconds:g} seconds"
    return f"No response from the model for {window} — network problem? The turn was stopped."


class TurnMapper:
    """Pure-ish mapping from SDK messages to AssistantEvents.

    Prefers partial text deltas; falls back to whole TextBlocks when no
    deltas were seen (older CLI versions).
    """

    def __init__(self, tools: dict[str, str] | None = None,
                 declined: set[str] | None = None) -> None:
        self._saw_delta = False
        # tool_use_id -> full SDK tool name and the ids whose card the user
        # declined; both shared with the conversation, so a result landing
        # in a later turn than its call still finds them.
        self._tools = tools if tools is not None else {}
        self._declined = declined if declined is not None else set()

    def map(self, msg: object) -> list[AssistantEvent]:
        if isinstance(msg, StreamEvent):
            event = msg.event
            if event.get("type") == "content_block_delta":
                delta = event.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    self._saw_delta = True
                    return [TextDelta(text=delta["text"])]
            elif event.get("type") == "content_block_start":
                # The block's start arrives tens of seconds before the SDK
                # assembles the whole block into an AssistantMessage -- for a
                # tool_use block that gap is the longest silent stretch of the
                # turn, so the phase label must come from here.
                block = event.get("content_block") or {}
                block_type = block.get("type")
                if block_type == "thinking":
                    return [Phase(label="reasoning")]
                if block_type == "tool_use" and block.get("name"):
                    return [Phase(label=f"preparing {short_tool_name(block['name'])}")]
                if block_type == "text":
                    return [Phase(label="replying")]
            return []
        if isinstance(msg, AssistantMessage):
            out: list[AssistantEvent] = []
            for block in msg.content:
                if isinstance(block, TextBlock) and not self._saw_delta:
                    out.append(TextDelta(text=block.text))
                elif isinstance(block, ToolUseBlock):
                    short = short_tool_name(block.name)
                    self._tools[block.id] = block.name
                    out.append(ToolStarted(
                        tool_use_id=block.id, name=short,
                        summary=tool_summary(short, block.input or {})))
            return out
        if isinstance(msg, UserMessage):
            content = msg.content
            if not isinstance(content, list):
                return []
            out = []
            for block in content:
                if isinstance(block, ToolResultBlock):
                    out.append(self._finished(block))
            return out
        if isinstance(msg, ResultMessage):
            if msg.is_error:
                return [ErrorEvent(message=f"assistant error: {msg.subtype}")]
            return [TurnDone(usage=msg.usage)]
        return []

    def _finished(self, block: ToolResultBlock) -> ToolFinished:
        tool_use_id = block.tool_use_id
        full_name = self._tools.pop(tool_use_id, None)
        declined = tool_use_id in self._declined
        self._declined.discard(tool_use_id)
        name = short_tool_name(full_name) if full_name else "tool"
        # Only a write's error or warning is shown: reads fail routinely while
        # the model probes, and its reply reports them.
        if full_name is None or classify_tool(full_name) != "write":
            return ToolFinished(tool_use_id=tool_use_id, name=name)
        if block.is_error is not True:
            return ToolFinished(tool_use_id=tool_use_id, name=name,
                                warning=tool_warning(block.content))
        if declined:
            return ToolFinished(tool_use_id=tool_use_id, name=name,
                                declined=True)
        return ToolFinished(tool_use_id=tool_use_id, name=name,
                            error=tool_error_reason(block.content))


class ClaudeConversation:
    def __init__(self, config_path: Path, read_blocks: BlockReader) -> None:
        self._config_path = config_path
        self._read_blocks = read_blocks
        self._client: ClaudeSDKClient | None = None
        self._queue: asyncio.Queue[AssistantEvent] = asyncio.Queue()
        self._pending: dict[ConfirmId, asyncio.Future[bool]] = {}
        self._confirm_seq = 0
        # The allowed writes whose results have not arrived, by tool_use_id
        # (the confirm id when the SDK gives none, which then counts as
        # running until a turn finishes). A stopped turn's writes carry
        # over into the next turn.
        self._running_writes: set[str] = set()
        # Bumped when a confirm parks or a write is allowed, so a read that
        # spans one is known to have.
        self._write_events = 0
        # Per tool_use_id, shared with each turn's TurnMapper: the full tool
        # name of calls without a result yet, and the calls whose card the
        # user declined. A stopped turn's call can report in the next turn.
        self._tool_names: dict[str, str] = {}
        self._declined: set[str] = set()
        self._pump_task: asyncio.Task[None] | None = None
        # Flips to False the moment an interrupt on this harness goes
        # unacknowledged (timed out or raised) -- see send()'s cleanup
        # below. The owner (AssistantService) checks this after the turn
        # ends and retires rather than reuses a handle gone unhealthy.
        self.healthy = True

    def attach(self, client: ClaudeSDKClient) -> None:
        self._client = client

    def _live_client(self) -> ClaudeSDKClient:
        if self._client is None:
            raise RuntimeError("no harness client attached")
        return self._client

    async def can_use_tool(
        self, tool_name: str, tool_input: dict[str, object], context: ToolPermissionContext | None
    ) -> PermissionResultAllow | PermissionResultDeny:
        kind = classify_tool(tool_name)
        if kind == "read":
            return PermissionResultAllow()
        if kind != "write":
            logger.warning("assistant requested unexpected tool %s", tool_name)
            return PermissionResultDeny(message="Tool not permitted.")
        short = short_tool_name(tool_name)
        # Whether another write could land after the read: one waits on
        # the user or runs as the read starts (a stopped turn's included),
        # or one parks or is allowed during it.
        in_flight = self._writes_in_flight()
        events = self._write_events
        approval = await preview_write(short, tool_input or {},
                                       self._read_blocks)
        if isinstance(approval, Refusal):
            # Input the tool's schema rejects is never shown as a card:
            # the user cannot approve what the tool would not run as shown.
            logger.warning("assistant write %s refused: %s", short,
                           approval.message)
            return PermissionResultDeny(message=approval.message)
        preview = replace(approval.preview, writes_in_flight=(
            in_flight or events != self._write_events))
        self._confirm_seq += 1
        # A local counter, not the SDK's own tool_use id (that id lives on
        # the ToolUseBlock/ToolResultBlock pair TurnMapper reads above, a
        # different concept entirely): this is only ever a key this process
        # mints and resolves for one pending confirm.
        confirm_id = ConfirmId(f"confirm-{self._confirm_seq}")
        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._pending[confirm_id] = fut
        self._write_events += 1
        await self._queue.put(
            ConfirmRequest(confirm_id=confirm_id, ops_preview=preview.summary,
                           preview=preview)
        )
        try:
            allowed = await fut
        finally:
            self._pending.pop(confirm_id, None)
        if allowed:
            tool_use_id = context.tool_use_id if context is not None else None
            self._running_writes.add(tool_use_id or confirm_id)
            self._write_events += 1
            # The SDK hands the tool `updated_input` in place of the
            # model's input, falling back to it only when this is None:
            # so the tool runs the call the card showed, carrying the
            # blocks it showed as `expect`, whatever the dict passed in
            # holds by now.
            return PermissionResultAllow(updated_input=approval.tool_input)
        if context is not None and context.tool_use_id:
            self._declined.add(context.tool_use_id)
        return PermissionResultDeny(message="The user declined this action.")

    def _writes_in_flight(self) -> bool:
        return bool(self._pending) or bool(self._running_writes)

    def resolve_confirm(self, confirm_id: ConfirmId, allow: bool) -> None:
        fut = self._pending.get(confirm_id)
        if fut is not None and not fut.done():
            fut.set_result(allow)

    async def send(self, text: str) -> AsyncGenerator[AssistantEvent, None]:
        # a dropped SSE stream can abandon a turn mid-queue; leftovers must
        # not leak into the next turn
        while not self._queue.empty():
            self._queue.get_nowait()
        await self._live_client().query(text)
        mapper = TurnMapper(self._tool_names, self._declined)
        pump = asyncio.create_task(self._pump(mapper))
        self._pump_task = pump
        finished = False
        try:
            while True:
                event = await self._queue.get()
                if isinstance(event, TurnDone):
                    # Every write of a finished turn has its result. A
                    # stopped or failed turn's stay running until theirs
                    # arrives in a later turn, or that turn finishes.
                    self._running_writes.clear()
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
        it exists for (a wedged harness, no tool_result,
        and a panel showing nothing at all, until the process restarted).
        """
        self._decline_pending()
        # Then stop the harness: cancelling our local pump task only stops us
        # from reading further messages, it does NOT stop the CLI subprocess
        # from continuing to execute the abandoned query. Bounded, because a
        # harness wedged for any other reason must not hold up this cleanup
        # either.
        try:
            await asyncio.wait_for(self._live_client().interrupt(), INTERRUPT_TIMEOUT_S)
        except TimeoutError:
            logger.warning(
                "assistant interrupt not acknowledged in %ss; abandoning the turn "
                "and retiring the harness",
                INTERRUPT_TIMEOUT_S,
            )
            # The subprocess may still be executing the abandoned turn: an
            # interrupt it never acknowledged is not proof it stopped. Mark
            # this handle unhealthy so the caller (AssistantService) tears it
            # down instead of handing it a later turn.
            self.healthy = False
        except asyncio.CancelledError:
            # An abandoned wait says as little about the harness as a
            # timed-out one, so the verdict is the same. The cancellation is
            # re-raised, never swallowed -- the caller keeps unwinding, and
            # sees a handle it must retire. The SSE layer runs this protocol
            # in a task of its own so cancellation is not the normal case
            # (routes._wait_out).
            logger.warning("assistant interrupt abandoned by a cancellation; "
                           "retiring the harness")
            self.healthy = False
            # Re-raising here skips send()'s own pump-cancel lines below this
            # call, which is safe only because healthy = False above sends
            # this handle to retirement, and close() cancels self._pump_task
            # itself.
            raise
        except Exception:
            logger.exception("assistant interrupt failed; retiring the harness")
            self.healthy = False

    async def _pump(self, mapper: TurnMapper) -> None:
        stream = self._live_client().receive_response()
        pending: asyncio.Task[Any] | None = None
        try:
            while True:
                if pending is None:
                    pending = asyncio.ensure_future(anext(stream))
                # asyncio.wait (unlike wait_for) leaves the read running on
                # timeout, so a suspended deadline never loses a message.
                done, _ = await asyncio.wait({pending}, timeout=STALL_TIMEOUT_S)
                if not done:
                    if self._pending:
                        # Parked on a confirm: the harness sits inside
                        # can_use_tool and cannot emit anything, so this
                        # silence is the user's, not the model's. Fresh
                        # window each pass; never a stall.
                        continue
                    await self._stall()
                    return
                settled, pending = pending, None
                try:
                    msg = settled.result()
                except StopAsyncIteration:
                    return
                self._running_writes.difference_update(
                    finished_tool_ids(msg))
                for event in mapper.map(msg):
                    await self._queue.put(event)
        except Exception as exc:  # subprocess died, JSON decode, etc.
            logger.exception("assistant turn failed")
            await self._queue.put(ErrorEvent(message=str(exc)))
        finally:
            if pending is not None and not pending.done():
                pending.cancel()
                with contextlib.suppress(Exception, asyncio.CancelledError):
                    await pending

    async def _stall(self) -> None:
        """Kill a turn the model has gone totally silent on.

        Interrupt FIRST, then report: the ErrorEvent ends the consumer's
        loop (send() treats it as the turn's end and cancels this pump), so
        reporting first would cancel the interrupt mid-flight.
        """
        logger.warning(
            "assistant turn stalled: no SDK message for %ss; interrupting", STALL_TIMEOUT_S
        )
        try:
            await asyncio.wait_for(self._live_client().interrupt(), INTERRUPT_TIMEOUT_S)
        except TimeoutError:
            # same verdict as _abandon_turn: an unacknowledged interrupt is
            # not proof the subprocess stopped, so retire the handle
            logger.warning(
                "assistant interrupt not acknowledged in %ss after a stall; "
                "retiring the harness",
                INTERRUPT_TIMEOUT_S,
            )
            self.healthy = False
        except Exception:
            logger.exception("assistant interrupt failed after a stall; retiring the harness")
            self.healthy = False
        await self._queue.put(ErrorEvent(message=stall_message(STALL_TIMEOUT_S)))

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
            # statement a second cancellation could skip.
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
        read_blocks: BlockReader,
    ) -> None:
        self._base_url = base_url
        self._read_blocks = read_blocks
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
        # Resolved first: a model this deployment has no key for must be
        # rejected before the credential file or any subprocess exists.
        harness = resolve_harness_env(model, self._zai_token)
        config_path = self._write_cli_config()
        conversation = ClaudeConversation(config_path, self._read_blocks)
        try:
            options = ClaudeAgentOptions(
                model=harness.sdk_model,
                system_prompt=system_prompt,
                tools=[],
                allowed_tools=read_tool_names(),
                can_use_tool=conversation.can_use_tool,
                mcp_servers={
                    "pkm": {
                        "type": "stdio",
                        "command": sys.executable,
                        # --require-expect: a guarded write without the
                        # card's `expect` is refused, never run unguarded
                        "args": ["-m", "pkm.mcp.server", "--tools",
                                 ",".join(READ_TOOLS + WRITE_TOOLS),
                                 "--require-expect"],
                        "env": {"PKM_CLI_CONFIG": str(config_path)},
                    }
                },
                setting_sources=[],
                # setting_sources=[] does not stop the account's claude.ai
                # connectors loading; without this their tools would sit
                # beside pkm's with can_use_tool as their only guard.
                strict_mcp_config=True,
                include_partial_messages=True,
                max_turns=MAX_TURNS,
                env=harness.env,
            )
            client = self._client_factory(options)
            conversation.attach(client)
            await client.connect()
        except BaseException:
            # A factory failure, a failed connect handshake, or cancellation
            # while awaiting connect (service.create()'s admission-lock
            # wait_for(create_timeout) times out on a wedged harness)
            # must not leave the 0600 credential file or a
            # half-started client behind for the next create() to trip over.
            # ClaudeConversation.close() already tolerates a client that
            # never connected (or was never attached) and a disconnect()
            # that itself raises, so reuse it instead of duplicating that
            # handling here.
            await conversation.close()
            raise
        # the requested name, not the SDK alias: a glm harness must not log
        # as a real sonnet run
        logger.info("assistant harness started (model=%s)", model)
        return conversation
