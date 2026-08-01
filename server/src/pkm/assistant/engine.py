# pattern: Functional Core
"""AgentEngine / ConversationHandle protocols (types only, no I/O)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from pkm.assistant.events import AssistantEvent


class ConversationHandle(Protocol):
    # False once an interrupt on this handle went unacknowledged (timed out
    # or raised): the underlying harness may still be running the abandoned
    # turn, so its state is uncertain and it must not be handed a later turn
    # (pkm-rwwc). The owner is expected to retire (close and discard) a
    # handle that goes unhealthy rather than reuse it.
    healthy: bool

    def send(self, text: str) -> AsyncIterator[AssistantEvent]:
        """Send one user turn; yields events until TurnDone or ErrorEvent."""
        ...

    def resolve_confirm(self, tool_use_id: str, allow: bool) -> None:
        """Answer a pending ConfirmRequest. Unknown ids are ignored."""
        ...

    async def close(self) -> None: ...


class AgentEngine(Protocol):
    async def create_conversation(self, system_prompt: str, model: str) -> ConversationHandle: ...
