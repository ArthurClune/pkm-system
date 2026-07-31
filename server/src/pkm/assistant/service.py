# pattern: Imperative Shell
"""In-memory conversation registry: caps, idle reaping, per-conversation lock."""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

from pkm.assistant.engine import AgentEngine, ConversationHandle
from pkm.assistant.events import AssistantEvent
from pkm.assistant.policy import SYSTEM_PROMPT, resolve_model

logger = logging.getLogger("pkm.assistant")


class ConversationLimitError(Exception):
    pass


class UnknownConversationError(Exception):
    pass


class BusyError(Exception):
    pass


@dataclass
class _Entry:
    handle: ConversationHandle
    model: str
    last_used: float
    busy: bool = False


class AssistantService:
    def __init__(
        self,
        engine: AgentEngine,
        *,
        max_conversations: int = 3,
        idle_ttl: float = 900.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._engine = engine
        self._max = max_conversations
        self._idle_ttl = idle_ttl
        self._clock = clock
        self._entries: dict[str, _Entry] = {}
        # Guards the whole admission path (reap + cap check + eviction +
        # engine.create_conversation + registration) so two concurrent
        # create() calls can't both observe free capacity and both proceed:
        # without this, each would read the same (not-yet-updated) entries
        # dict before either inserted, bypassing the cap or double-evicting.
        # `async with` releases the lock via try/finally on every exit path,
        # including exceptions from the engine and task cancellation, so a
        # failed or cancelled creation never leaves admission stuck.
        self._admission_lock = asyncio.Lock()

    async def create(self, model: str | None) -> tuple[str, str]:
        resolved = resolve_model(model)
        async with self._admission_lock:
            await self._reap_idle()
            if len(self._entries) >= self._max:
                # A page reload orphans the client's conversation id without
                # deleting it server-side; repeated reloads would otherwise
                # exhaust the cap and 409 every create for up to idle_ttl.
                # Evicting the least-recently-used IDLE (non-busy) conversation
                # avoids that lockout; if every conversation is actively
                # streaming, fall through to the cap error below.
                await self._evict_oldest_idle()
            if len(self._entries) >= self._max:
                raise ConversationLimitError(f"at most {self._max} concurrent conversations")
            handle = await self._engine.create_conversation(SYSTEM_PROMPT, resolved)
            cid = secrets.token_hex(8)
            self._entries[cid] = _Entry(handle=handle, model=resolved, last_used=self._clock())
            logger.info("assistant conversation %s created (model=%s)", cid, resolved)
            return cid, resolved

    def send(self, conversation_id: str, text: str) -> AsyncIterator[AssistantEvent]:
        entry = self._get(conversation_id)
        if entry.busy:
            raise BusyError("a turn is already in progress")
        # Reserve synchronously, before returning the (lazy) async generator
        # below: two near-simultaneous calls to send() must not both observe
        # "free", which they could if the flag were only set once the
        # generator starts running (its first iteration may happen well
        # after this function returns). No `await` occurs between the check
        # above and this assignment, so no other coroutine can interleave.
        entry.busy = True
        return self._stream(conversation_id, entry, text)

    async def _stream(self, cid: str, entry: _Entry, text: str) -> AsyncIterator[AssistantEvent]:
        try:
            entry.last_used = self._clock()
            async for event in entry.handle.send(text):
                yield event
            entry.last_used = self._clock()
        finally:
            entry.busy = False

    def confirm(self, conversation_id: str, tool_use_id: str, allow: bool) -> None:
        self._get(conversation_id).handle.resolve_confirm(tool_use_id, allow)

    async def delete(self, conversation_id: str) -> None:
        entry = self._entries.pop(conversation_id, None)
        if entry is not None:
            await entry.handle.close()
            logger.info("assistant conversation %s closed", conversation_id)

    async def close_all(self) -> None:
        for cid in list(self._entries):
            await self.delete(cid)

    def _get(self, conversation_id: str) -> _Entry:
        entry = self._entries.get(conversation_id)
        if entry is None:
            raise UnknownConversationError(conversation_id)
        return entry

    async def _reap_idle(self) -> None:
        cutoff = self._clock() - self._idle_ttl
        stale = [cid for cid, e in self._entries.items() if e.last_used < cutoff and not e.busy]
        for cid in stale:
            logger.info("assistant conversation %s reaped (idle)", cid)
            await self.delete(cid)

    async def _evict_oldest_idle(self) -> None:
        candidates = sorted(
            ((e.last_used, cid) for cid, e in self._entries.items() if not e.busy),
        )
        if not candidates:
            return  # every conversation is busy; caller will 409
        _, oldest_cid = candidates[0]
        logger.info("assistant conversation %s evicted (cap reached, oldest idle)", oldest_cid)
        await self.delete(oldest_cid)
