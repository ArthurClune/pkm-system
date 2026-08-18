# pattern: Imperative Shell
"""In-memory conversation registry: caps, idle reaping, per-conversation lock."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass

from pkm.assistant.engine import AgentEngine, ConversationHandle
from pkm.assistant.events import AssistantEvent
from pkm.assistant.policy import SYSTEM_PROMPT, resolve_model
from pkm.assistant.policy import available_models as _policy_available_models

logger = logging.getLogger("pkm.assistant")

# Bounds engine.create_conversation() (spawns the harness subprocess and
# waits for it to connect) while the admission lock is held, so one wedged
# harness fails one request instead of wedging every future create().
# pkm-rovq review round 1.
#
# The lock-hold story lives here, once, and is cross-referenced from the two
# places that used to retell it. This is not a ceiling on how long the lock is
# held: asyncio.wait_for does not return until the task it cancelled has
# finished unwinding, so a handshake still wedged at CREATE_TIMEOUT_S gets
# create_conversation's own cancellation-triggered cleanup (disconnecting the
# partially-connected client, pkm-4zq4) run to completion first, under the
# lock, before TimeoutError reaches create() below. That cleanup rides the SDK
# transport's own bounded close (~20s worst case per claude_agent_sdk's
# SubprocessCLITransport), so the true worst-case hold is CREATE_TIMEOUT_S
# plus that -- roughly 80s, not 60s. pkm-4zq4 fix round 1.
CREATE_TIMEOUT_S = 60.0


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
        create_timeout: float = CREATE_TIMEOUT_S,
        available_models: list[str] | None = None,
    ) -> None:
        # What the picker may offer AND what create() accepts: glm is only
        # in the list when the caller (create_app) resolved a z.ai key, so
        # an unconfigured deployment neither advertises nor accepts it. The
        # default hides it — a test double or bare service must opt in.
        self.available_models = (
            available_models if available_models is not None
            else _policy_available_models(zai_configured=False))
        self._engine = engine
        self._max = max_conversations
        self._idle_ttl = idle_ttl
        self._clock = clock
        self._create_timeout = create_timeout
        self._entries: dict[str, _Entry] = {}
        # Guards the whole admission path (reap + cap check + eviction +
        # engine.create_conversation + registration) so two concurrent
        # create() calls can't both observe free capacity and both proceed:
        # without this, each would read the same (not-yet-updated) entries
        # dict before either inserted, bypassing the cap or double-evicting.
        # `async with` releases the lock via try/finally on every exit path,
        # including exceptions from the engine and task cancellation, so a
        # failed or cancelled creation never leaves admission stuck.
        #
        # The lock spans a subprocess spawn: engine.create_conversation()
        # starts the Claude CLI harness and awaits its connect handshake,
        # bounded by CREATE_TIMEOUT_S -- see that constant's comment for what
        # the bound actually costs. The other await that used to run under
        # this lock, closing a reaped or evicted conversation's harness, is
        # deferred to create()'s outer finally: eviction correctness needs the
        # `_entries` pop to be atomic with the cap check, not the old
        # harness's teardown to finish before admission proceeds.
        self._admission_lock = asyncio.Lock()

    async def create(self, model: str | None) -> tuple[str, str]:
        resolved = resolve_model(model)
        if resolved not in self.available_models:
            raise ValueError(
                f"model {resolved!r} is not available (missing provider key?)")
        to_close: list[tuple[str, ConversationHandle]] = []
        try:
            async with self._admission_lock:
                to_close.extend(self._reap_idle())
                if len(self._entries) >= self._max:
                    # A page reload orphans the client's conversation id without
                    # deleting it server-side; repeated reloads would otherwise
                    # exhaust the cap and 409 every create for up to idle_ttl.
                    # Evicting the least-recently-used IDLE (non-busy) conversation
                    # avoids that lockout; if every conversation is actively
                    # streaming, fall through to the cap error below.
                    evicted = self._evict_oldest_idle()
                    if evicted is not None:
                        to_close.append(evicted)
                if len(self._entries) >= self._max:
                    raise ConversationLimitError(f"at most {self._max} concurrent conversations")
                try:
                    handle = await asyncio.wait_for(
                        self._engine.create_conversation(SYSTEM_PROMPT, resolved),
                        self._create_timeout,
                    )
                except TimeoutError:
                    logger.warning(
                        "assistant harness did not connect within %ss (model=%s); "
                        "abandoning admission so the lock is released",
                        self._create_timeout,
                        resolved,
                    )
                    raise
                cid = secrets.token_hex(8)
                self._entries[cid] = _Entry(handle=handle, model=resolved, last_used=self._clock())
                logger.info("assistant conversation %s created (model=%s)", cid, resolved)
                return cid, resolved
        finally:
            # The `async with` above has already exited, and so released the
            # lock, before control reaches this outer `finally`: a
            # slow-to-close harness delays only this request.
            #
            # Every entry here was already popped from `_entries` under the
            # lock (by _reap_idle/_evict_oldest_idle above) -- nothing else
            # will ever retry closing it. A cancellation landing while
            # parked in one handle's close() must not therefore abort this
            # loop: the remaining handles would leak their subprocess and
            # 0600 session-token config file (pkm-4zq4) until process exit,
            # the same class of leak pkm-4zq4 closes one layer down. Keep
            # closing every queued handle regardless, and only re-raise the
            # first cancellation once the whole queue has been attempted --
            # each close() is itself SDK-bounded (~20s worst case), so the
            # cancellation is delayed, not lost (pkm-4zq4 final-review fix
            # wave).
            first_cancel: asyncio.CancelledError | None = None
            for old_cid, old_handle in to_close:
                try:
                    await old_handle.close()
                    logger.info("assistant conversation %s closed", old_cid)
                except asyncio.CancelledError as exc:
                    logger.warning(
                        "assistant conversation %s close cancelled; still closing "
                        "the rest of the queued conversations",
                        old_cid,
                    )
                    if first_cancel is None:
                        first_cancel = exc
                except Exception:
                    logger.exception("assistant conversation %s close failed", old_cid)
            if first_cancel is not None:
                raise first_cancel

    def send(self, conversation_id: str, text: str) -> AsyncGenerator[AssistantEvent, None]:
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

    async def _stream(
        self, cid: str, entry: _Entry, text: str
    ) -> AsyncGenerator[AssistantEvent, None]:
        try:
            entry.last_used = self._clock()
            # aclosing, not a bare `async for`: when the SSE layer closes this
            # generator on a client disconnect, GeneratorExit lands at the
            # yield below -- not inside the handle's turn generator, which an
            # `async for` would simply drop. Its abandon-turn cleanup would
            # then run on async-generator finalization, i.e. *after* the
            # health check in the finally below, and an unacknowledged
            # interrupt would leave the conversation in the registry for a
            # later turn to reuse (pkm-f3mo, reopening pkm-rwwc).
            async with contextlib.aclosing(entry.handle.send(text)) as turn:
                async for event in turn:
                    yield event
            entry.last_used = self._clock()
        finally:
            entry.busy = False
            if not entry.handle.healthy:
                # An interrupt on this handle went unacknowledged: the
                # harness may still be running the abandoned turn, so its
                # state is uncertain. Popping happens synchronously here (no
                # `await` between the busy-flag reset above and this pop),
                # so no concurrent create()/reap/evict can observe this cid
                # as idle-and-reusable in between -- the next send() for it
                # raises UnknownConversationError instead of resuming a
                # possibly-still-running subprocess (pkm-rwwc). Only close if
                # this pop is the one that actually removed the entry: an
                # explicit delete() (e.g. the pagehide beacon) racing this
                # same cid may already have popped and closed it, and close()
                # is not free to call twice just because it happens to
                # tolerate it.
                removed = self._entries.pop(cid, None) is not None
                if removed:
                    logger.warning(
                        "assistant conversation %s retired after an unacknowledged interrupt", cid
                    )
                    await entry.handle.close()
                else:
                    logger.debug(
                        "assistant conversation %s already removed by a concurrent "
                        "delete() before the unacknowledged-interrupt retirement "
                        "could run", cid
                    )

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

    def _reap_idle(self) -> list[tuple[str, ConversationHandle]]:
        # Synchronous: only pops from `_entries` (atomic under the admission
        # lock). Closing the harness is the caller's job, done after the
        # lock is released -- see create()'s comment on _admission_lock.
        cutoff = self._clock() - self._idle_ttl
        stale = [cid for cid, e in self._entries.items() if e.last_used < cutoff and not e.busy]
        reaped = []
        for cid in stale:
            entry = self._entries.pop(cid)
            logger.info("assistant conversation %s reaped (idle)", cid)
            reaped.append((cid, entry.handle))
        return reaped

    def _evict_oldest_idle(self) -> tuple[str, ConversationHandle] | None:
        # Synchronous for the same reason as _reap_idle above.
        candidates = sorted(
            ((e.last_used, cid) for cid, e in self._entries.items() if not e.busy),
        )
        if not candidates:
            return None  # every conversation is busy; caller will 409
        _, oldest_cid = candidates[0]
        entry = self._entries.pop(oldest_cid)
        logger.info("assistant conversation %s evicted (cap reached, oldest idle)", oldest_cid)
        return oldest_cid, entry.handle
