# pattern: Functional Core
"""AgentEngine / ConversationHandle protocols (types only, no I/O)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from pkm.assistant.events import AssistantEvent


class ConversationHandle(Protocol):
    def send(self, text: str) -> AsyncIterator[AssistantEvent]:
        """Send one user turn; yields events until TurnDone or ErrorEvent."""
        ...

    def resolve_confirm(self, tool_use_id: str, allow: bool) -> None:
        """Answer a pending ConfirmRequest. Unknown ids are ignored."""
        ...

    async def close(self) -> None: ...


class AgentEngine(Protocol):
    async def create_conversation(self, system_prompt: str, model: str) -> ConversationHandle: ...
