# pattern: Functional Core
"""AgentEngine / ConversationHandle protocols (types only, no I/O)."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Protocol

from pkm.assistant.events import AssistantEvent
from pkm.contracts.responses import ConfirmId


class ConversationHandle(Protocol):
    @property
    def healthy(self) -> bool:
        """False once the harness cannot be trusted with another turn: an
        interrupt went unacknowledged, the aborted turn's result never
        came, or the process died or ended its output. The owner retires
        (closes and discards) such a handle rather than reuse it."""
        ...

    def send(self, text: str) -> AsyncGenerator[AssistantEvent, None]:
        """Send one user turn; yields events until TurnDone or ErrorEvent.

        A generator rather than a plain AsyncIterator on purpose: the caller
        closes it explicitly when the consumer disappears mid-turn, so an
        implementation's abandon-turn cleanup runs on a schedule instead of
        waiting for async-generator finalization.
        """
        ...

    def resolve_confirm(self, confirm_id: ConfirmId, allow: bool) -> None:
        """Answer a pending ConfirmRequest. Unknown ids are ignored."""
        ...

    def stop_turn(self) -> None:
        """The user's Stop: decline any parked confirm and end the open
        turn, whose stream then ends with TurnStopped once the harness can
        take the next one. Returns at once; a no-op with no turn reserved."""
        ...

    async def close(self) -> None: ...


class AgentEngine(Protocol):
    async def create_conversation(self, system_prompt: str, model: str) -> ConversationHandle: ...
