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
from collections.abc import AsyncIterator, Callable
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
    ToolUseBlock,
)

from pkm.assistant.events import (
    AssistantEvent,
    ConfirmRequest,
    ErrorEvent,
    TextDelta,
    ToolStarted,
    TurnDone,
)
from pkm.assistant.policy import (
    classify_tool,
    ops_preview,
    read_tool_names,
    short_tool_name,
    tool_summary,
)
from pkm.server.auth_core import sign_session

logger = logging.getLogger("pkm.assistant")

MAX_TURNS = 40


class TurnMapper:
    """Pure-ish mapping from SDK messages to AssistantEvents.

    Prefers partial text deltas; falls back to whole TextBlocks when no
    deltas were seen (older CLI versions).
    """

    def __init__(self) -> None:
        self._saw_delta = False

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
                    out.append(ToolStarted(name=short, summary=tool_summary(short, block.input or {})))
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

    async def send(self, text: str) -> AsyncIterator[AssistantEvent]:
        await self._client.query(text)
        mapper = TurnMapper()
        pump = asyncio.create_task(self._pump(mapper))
        try:
            while True:
                event = await self._queue.get()
                yield event
                if isinstance(event, (TurnDone, ErrorEvent)):
                    break
        finally:
            # if the consumer went away mid-turn (browser dropped the SSE
            # stream), don't block generator close on a live harness turn
            if not pump.done():
                pump.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pump

    async def _pump(self, mapper: TurnMapper) -> None:
        try:
            async for msg in self._client.receive_response():
                for event in mapper.map(msg):
                    await self._queue.put(event)
        except Exception as exc:  # subprocess died, JSON decode, etc.
            logger.exception("assistant turn failed")
            await self._queue.put(ErrorEvent(message=str(exc)))

    async def close(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_result(False)
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # already dead is fine
                logger.exception("assistant disconnect failed")
        self._config_path.unlink(missing_ok=True)


class ClaudeEngine:
    def __init__(
        self,
        *,
        base_url: str,
        session_secret_hex: str,
        client_factory: Callable[[ClaudeAgentOptions], Any] | None = None,
        config_dir: Path | None = None,
    ) -> None:
        self._base_url = base_url
        self._secret = session_secret_hex
        self._client_factory = client_factory or (lambda opts: ClaudeSDKClient(options=opts))
        self._config_dir = config_dir

    def _write_cli_config(self) -> Path:
        token = sign_session(bytes.fromhex(self._secret), int(time.time() * 1000))
        fd, raw_path = tempfile.mkstemp(prefix="pkm-assistant-", suffix=".json", dir=self._config_dir)
        path = Path(raw_path)
        with os.fdopen(fd, "w") as fh:  # mkstemp is already 0600
            json.dump({"url": self._base_url, "token": token}, fh)
        return path

    async def create_conversation(self, system_prompt: str, model: str) -> ClaudeConversation:
        config_path = self._write_cli_config()
        conversation = ClaudeConversation(config_path)
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
        )
        client = self._client_factory(options)
        conversation.attach(client)
        await client.connect()
        logger.info("assistant harness started (model=%s)", model)
        return conversation
