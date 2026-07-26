# pattern: Imperative Shell
"""Scripted AgentEngine double for unit/route tests and the e2e server.

Behavior is keyed on the user text so Playwright can drive it:
- "please write"  -> ToolStarted + ConfirmRequest (id "fake-confirm-1"),
                     then Saved./Okay, not saving. after resolve_confirm.
- anything else   -> TextDelta("echo: <text>") + TurnDone.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from pkm.assistant.events import (
    AssistantEvent,
    ConfirmRequest,
    TextDelta,
    ToolFinished,
    ToolStarted,
    TurnDone,
)


class FakeConversation:
    def __init__(self, system_prompt: str, model: str) -> None:
        self.system_prompt = system_prompt
        self.model = model
        self.closed = False
        self.sent: list[str] = []
        self._decisions: dict[str, asyncio.Future[bool]] = {}
        self._confirm_seq = 0

    async def send(self, text: str) -> AsyncIterator[AssistantEvent]:
        self.sent.append(text)
        if "please write" in text:
            self._confirm_seq += 1
            tool_use_id = f"fake-confirm-{self._confirm_seq}"
            fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
            self._decisions[tool_use_id] = fut
            yield ToolStarted(name="save_note", summary="saving a note")
            yield ConfirmRequest(tool_use_id=tool_use_id, ops_preview='save_note(title="Demo")')
            allowed = await fut
            if allowed:
                yield ToolFinished(name="save_note")
                yield TextDelta(text="Saved.")
            else:
                yield TextDelta(text="Okay, not saving.")
            yield TurnDone(usage={"input_tokens": 1})
            return
        yield TextDelta(text=f"echo: {text}")
        yield TurnDone(usage={"input_tokens": 1})

    def resolve_confirm(self, tool_use_id: str, allow: bool) -> None:
        fut = self._decisions.get(tool_use_id)
        if fut is not None and not fut.done():
            fut.set_result(allow)

    async def close(self) -> None:
        self.closed = True
        for fut in self._decisions.values():
            if not fut.done():
                fut.set_result(False)


class FakeEngine:
    def __init__(self) -> None:
        self.conversations: list[FakeConversation] = []

    async def create_conversation(self, system_prompt: str, model: str) -> FakeConversation:
        conv = FakeConversation(system_prompt, model)
        self.conversations.append(conv)
        return conv
