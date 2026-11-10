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
from collections.abc import AsyncGenerator, Callable, Sequence
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
from claude_agent_sdk._internal.transport.subprocess_cli import (
    SubprocessCLITransport,
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
    TurnStopped,
    tool_error_reason,
    tool_warning,
)
from pkm.assistant.harness_env import (
    MCP_MAX_CHARS,
    harness_env_names,
    launcher_script,
    mcp_server_config,
    resolve_harness_env,
)
from pkm.assistant.policy import (
    READ_TOOLS,
    WRITE_TOOLS,
    classify_tool,
    read_tool_names,
    short_tool_name,
    tool_summary,
)
from pkm.assistant.target_reader import BlockReader, preview_write
from pkm.assistant.turn_phase import PhaseEvent, TurnPhase, next_phase
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

# The CLI acknowledges an interrupt and only then writes the aborted turn's
# ResultMessage (6 ms later in a live run of CLI 2.1.301). The SDK buffers
# it, so if nobody drains it the next turn reads it as its own result.
DRAIN_TIMEOUT_S = 10.0

HARNESS_LOST = "The assistant stopped responding. Start a new chat."

# Why a turn was interrupted: the pump's last event follows from it.
STALLED = "stalled"
STOPPED_BY_USER = "stopped by the user"
ABANDONED = "the turn was abandoned"


def harness_cli() -> str:
    """The Claude Code CLI the SDK would run itself, bundled binary first.

    `_find_cli` is private to the SDK; test_assistant_harness_spawn.py
    patches the `_find_bundled_cli` beneath it.
    """
    return SubprocessCLITransport(prompt="", options=ClaudeAgentOptions())._find_cli()


def finished_tool_ids(msg: object) -> list[str]:
    """The tool calls whose results `msg` carries."""
    if not isinstance(msg, UserMessage) or not isinstance(msg.content, list):
        return []
    return [block.tool_use_id for block in msg.content
            if isinstance(block, ToolResultBlock)]


def _now() -> float:
    """The loop's clock, which every asyncio timeout here is measured on."""
    return asyncio.get_running_loop().time()


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
    def __init__(self, config_path: Path, read_blocks: BlockReader,
                 launcher_path: Path) -> None:
        self._config_path = config_path
        self._launcher_path = launcher_path
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
        # user declined. A stopped turn's call reports during its drain.
        self._tool_names: dict[str, str] = {}
        self._declined: set[str] = set()
        self._pump_task: asyncio.Task[None] | None = None
        self._phase: TurnPhase = "idle"
        self._drain_deadline = 0.0
        # True from a turn's end until the next send(): a confirm then has
        # no consumer to show its card, so it is declined, never parked.
        self._consumer_gone = False
        # The open turn's stop request, its result the reason. Only the
        # pump interrupts, so a Stop asks it to rather than racing it.
        self._stop_request: asyncio.Future[str] | None = None
        # Why the open turn was interrupted, once it was.
        self._stop_why: str | None = None

    @property
    def phase(self) -> TurnPhase:
        return self._phase

    @property
    def healthy(self) -> bool:
        return self._phase != "dead"

    def _move(self, event: PhaseEvent) -> None:
        self._phase = next_phase(self._phase, event)

    def _lose(self, reason: str) -> None:
        if self._phase != "dead":
            logger.warning("assistant harness retired: %s", reason)
        self._move("lost")

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
        if self._consumer_gone or self._stopping():
            # A card parked now would also hold the harness where it
            # cannot answer the interrupt that ends its turn.
            logger.warning("assistant write %s arrived with no turn to show "
                           "its card; declined", short)
            return self._decline(context)
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
        self._queue.put_nowait(
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
        return self._decline(context)

    def _decline(self, context: ToolPermissionContext | None) -> PermissionResultDeny:
        if context is not None and context.tool_use_id:
            self._declined.add(context.tool_use_id)
        return PermissionResultDeny(message="The user declined this action.")

    def _writes_in_flight(self) -> bool:
        return bool(self._pending) or bool(self._running_writes)

    def _stopping(self) -> bool:
        return (self._phase in ("interrupting", "draining")
                or (self._stop_request is not None
                    and self._stop_request.done()))

    def resolve_confirm(self, confirm_id: ConfirmId, allow: bool) -> None:
        fut = self._pending.get(confirm_id)
        if fut is not None and not fut.done():
            fut.set_result(allow)

    async def send(self, text: str) -> AsyncGenerator[AssistantEvent, None]:
        # Whatever an ended turn left behind is not this turn's. A confirm
        # in it has no card on screen, so its future is declined, not
        # dropped: an open one would also hold off the stall watchdog.
        self._decline_pending()
        while not self._queue.empty():
            self._queue.get_nowait()
        if self._phase != "idle":
            self._lose(f"send() found the harness {self._phase}")
            yield ErrorEvent(message=HARNESS_LOST)
            return
        stop_request: asyncio.Future[str] = (
            asyncio.get_running_loop().create_future())
        self._stop_request = stop_request
        self._stop_why = None
        self._consumer_gone = False
        # Before the query, not after: the prompt may reach the harness
        # before query() returns, and a turn nobody reads would be read by
        # the next one as its own.
        self._move("query")
        pump: asyncio.Task[None] | None = None
        finished = False
        try:
            try:
                await self._live_client().query(text)
            except asyncio.CancelledError:
                self._lose("query abandoned by a cancellation")
                raise
            except Exception as exc:
                logger.exception("assistant query failed")
                self._lose("query failed")
                yield ErrorEvent(message=str(exc))
                return
            self._move("query_sent")
            mapper = TurnMapper(self._tool_names, self._declined)
            pump = asyncio.create_task(self._pump(mapper, stop_request))
            self._pump_task = pump
            while True:
                event = await self._queue.get()
                if isinstance(event, TurnDone):
                    # Every write of a finished turn has its result. A
                    # stopped or failed turn's stay running until theirs
                    # arrives, or a later turn finishes.
                    self._running_writes.clear()
                yield event
                if isinstance(event, (TurnDone, ErrorEvent, TurnStopped)):
                    finished = True
                    break
        finally:
            self._consumer_gone = True
            if pump is not None:
                if finished:
                    # a turn that ended in error may leave the harness
                    # parked
                    self._decline_pending()
                else:
                    await self._abandon_turn(pump)
                # if the consumer went away mid-turn, don't block generator
                # close on a live harness turn
                if not pump.done():
                    pump.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await pump
                if self._pump_task is pump:
                    self._pump_task = None

    def stop_turn(self) -> None:
        """The user's Stop. Returns at once: the pump interrupts the turn
        and drains its aborted result, then ends the stream with
        `TurnStopped`. A no-op when no turn is open."""
        self._decline_pending()
        self._request_stop(STOPPED_BY_USER)

    def _request_stop(self, why: str) -> None:
        """Ask the pump to stop the open turn; the first reason given is
        the one acted on. A turn already being stopped keeps its own."""
        request = self._stop_request
        if (self._phase in ("querying", "streaming") and request is not None
                and not request.done()):
            request.set_result(why)

    def _decline_pending(self) -> None:
        """Answer every parked confirm with a decline.

        A `can_use_tool` hook may be awaiting a decision that will never
        arrive now -- the consumer is gone, or the conversation is closing --
        and an unresolved future leaves the harness wedged inside the hook.
        """
        for fut in self._pending.values():
            if not fut.done():
                fut.set_result(False)

    async def _abandon_turn(self, pump: asyncio.Task[None]) -> None:
        """Give up on the turn in flight: decline, stop, wait for the pump.

        Runs when the consumer dropped mid-turn -- browser closed the tab,
        navigated away, or the fetch was aborted. The SSE layer closes this
        generator explicitly (`routes._abandon_stream`) so that this
        protocol runs on a schedule rather than whenever an orphaned
        generator is finalized.

        Decline FIRST. The harness cannot answer an interrupt while it sits in
        `can_use_tool` awaiting the very decision this supplies, so doing it
        after `interrupt()` left the decline unreachable in exactly the case
        it exists for (a wedged harness, no tool_result,
        and a panel showing nothing at all, until the process restarted).

        The pump sends the interrupt, unless one is already in flight, and
        reads the aborted turn's ResultMessage here, not in the next turn.
        """
        self._decline_pending()
        self._request_stop(ABANDONED)
        await self._await_pump(pump, INTERRUPT_TIMEOUT_S + DRAIN_TIMEOUT_S)

    async def _await_pump(self, pump: asyncio.Task[None], bound: float) -> None:
        """Let the pump read the turn to its end; dead if it cannot in
        `bound`, or if the wait is abandoned."""
        try:
            await asyncio.wait({pump}, timeout=bound)
        except asyncio.CancelledError:
            self._lose("the wait for the interrupted turn was abandoned "
                       "by a cancellation")
            raise
        if not pump.done():
            self._lose(f"the interrupted turn did not end in {bound}s")

    async def _stop_turn(self, why: str) -> None:
        """Interrupt the open turn and open its drain.

        Only the pump calls this, and it reads nothing while the interrupt
        is in flight, so one interrupt at most is ever sent per turn and the
        aborted result is read only once the ack has moved the phase to
        `draining`. A turn already interrupted keeps its interrupt.
        """
        if self._phase != "streaming":
            return
        self._move("interrupt")
        self._stop_why = why
        if not await self._interrupt(why):
            return
        self._move("interrupt_acked")
        self._drain_deadline = _now() + DRAIN_TIMEOUT_S

    async def _interrupt(self, why: str) -> bool:
        """Interrupt the harness, bounded; False (and dead) unless it acks.

        An interrupt the harness never acknowledged is not proof it
        stopped: it may still be running the turn.
        """
        try:
            await asyncio.wait_for(self._live_client().interrupt(), INTERRUPT_TIMEOUT_S)
        except TimeoutError:
            self._lose(f"interrupt not acknowledged in {INTERRUPT_TIMEOUT_S}s "
                       f"({why})")
            return False
        except asyncio.CancelledError:
            # An abandoned wait says as little about the harness as a
            # timed-out one, so the verdict is the same. The cancellation is
            # re-raised, never swallowed: the caller keeps unwinding, and
            # sees a handle it must retire. close() cancels the pump, and
            # so this wait, itself.
            self._lose(f"interrupt abandoned by a cancellation ({why})")
            raise
        except Exception:
            logger.exception("assistant interrupt failed (%s)", why)
            self._lose("interrupt failed")
            return False
        return True

    def _read_timeout(self) -> float:
        if self._phase == "draining":
            return max(0.0, self._drain_deadline - _now())
        return STALL_TIMEOUT_S

    async def _pump(self, mapper: TurnMapper,
                    stop_request: asyncio.Future[str]) -> None:
        stream = self._live_client().receive_response()
        pending: asyncio.Task[Any] | None = None
        heard_stop = False
        failure: str | None = None
        try:
            while True:
                if pending is None:
                    pending = asyncio.ensure_future(anext(stream))
                waits: set[asyncio.Future[Any]] = {pending}
                if not heard_stop:
                    waits.add(stop_request)
                # asyncio.wait (unlike wait_for) leaves the read running on
                # timeout, so a suspended deadline never loses a message.
                done, _ = await asyncio.wait(
                    waits, timeout=self._read_timeout(),
                    return_when=asyncio.FIRST_COMPLETED)
                if stop_request in done:
                    # before any message read with it: after a Stop no
                    # output of the turn reaches the consumer
                    heard_stop = True
                    await self._stop_turn(stop_request.result())
                    if self._phase == "dead":
                        break
                    continue
                if pending not in done:
                    if self._phase == "draining":
                        if _now() >= self._drain_deadline:
                            self._lose("no result for the interrupted turn "
                                       f"in {DRAIN_TIMEOUT_S}s")
                            break
                        continue
                    if self._pending:
                        # Parked on a confirm: the harness sits inside
                        # can_use_tool and cannot emit anything, so this
                        # silence is the user's, not the model's. Fresh
                        # window each pass; never a stall.
                        continue
                    logger.warning("assistant turn stalled: no SDK message "
                                   "for %ss; interrupting", STALL_TIMEOUT_S)
                    await self._stop_turn(STALLED)
                    if self._phase == "dead":
                        break
                    continue
                settled, pending = pending, None
                try:
                    msg = settled.result()
                except StopAsyncIteration:
                    self._lose("the harness's output ended before the "
                               "turn's result")
                    failure = HARNESS_LOST
                    break
                self._running_writes.difference_update(
                    finished_tool_ids(msg))
                # A drained message still updates the shared tool maps, but
                # its events are for a consumer that has gone or is about to
                # be told why the turn ended.
                events = mapper.map(msg)
                if self._phase == "streaming" and not self._consumer_gone:
                    for event in events:
                        self._queue.put_nowait(event)
                if isinstance(msg, ResultMessage):
                    self._move("result")
                    break
        except Exception as exc:  # subprocess died, JSON decode, etc.
            logger.exception("assistant turn failed")
            self._lose("the harness stream failed")
            failure = str(exc)
        finally:
            if pending is not None and not pending.done():
                pending.cancel()
                with contextlib.suppress(Exception, asyncio.CancelledError):
                    await pending
        # Interrupt and drain FIRST, then report: the last event ends the
        # consumer's loop, and send() then cancels this pump. A stopped
        # turn ends on its stop whatever became of its harness; a dead one
        # is retired when its stream ends.
        if self._stop_why == STALLED:
            self._queue.put_nowait(ErrorEvent(message=stall_message(STALL_TIMEOUT_S)))
        elif self._stop_why == STOPPED_BY_USER:
            self._queue.put_nowait(TurnStopped())
        elif failure is not None:
            self._queue.put_nowait(ErrorEvent(message=failure))

    async def close(self) -> None:
        self._decline_pending()
        self._move("lost")
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
            self._launcher_path.unlink(missing_ok=True)


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
        try:
            with os.fdopen(fd, "w") as fh:  # mkstemp is already 0600
                json.dump({"url": self._base_url, "token": token}, fh)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return path

    def _write_launcher(self, names: Sequence[str]) -> Path:
        fd, raw_path = tempfile.mkstemp(prefix="pkm-assistant-", suffix=".py", dir=self._config_dir)
        path = Path(raw_path)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(launcher_script(harness_cli(), names, sys.executable))
            os.chmod(path, 0o700)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return path

    async def create_conversation(self, system_prompt: str, model: str) -> ClaudeConversation:
        # Resolved first: a model this deployment has no key for must be
        # rejected before the credential file or any subprocess exists.
        harness = resolve_harness_env(model, self._zai_token)
        config_path = self._write_cli_config()
        try:
            launcher_path = self._write_launcher(harness_env_names(harness))
        except BaseException:
            config_path.unlink(missing_ok=True)
            raise
        conversation = ClaudeConversation(config_path, self._read_blocks,
                                          launcher_path)
        try:
            options = ClaudeAgentOptions(
                model=harness.sdk_model,
                system_prompt=system_prompt,
                tools=[],
                allowed_tools=read_tool_names(),
                can_use_tool=conversation.can_use_tool,
                cli_path=launcher_path,
                mcp_servers={
                    "pkm": mcp_server_config(
                        sys.executable, str(config_path),
                        # --require-expect: a guarded write without the
                        # card's `expect` is refused, never run unguarded
                        ["--tools", ",".join(READ_TOOLS + WRITE_TOOLS),
                         "--require-expect",
                         "--max-chars", str(MCP_MAX_CHARS)]),
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
