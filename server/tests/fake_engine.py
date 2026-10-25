# pattern: Imperative Shell
"""Scripted AgentEngine double for unit/route tests and the e2e server.

Behavior is keyed on the user text so Playwright can drive it:
- "please write"  -> ToolStarted + ConfirmRequest (id "fake-confirm-1")
                     carrying the real preview of a save_note to "Demo",
                     then Saved./Okay, not saving. after resolve_confirm.
- "please write twice"
                  -> two ToolStarted + ConfirmRequest pairs (pages "Demo"
                     and "Demo 2", consecutive ids) before awaiting either,
                     so the panel must queue the second card; then
                     "Saved 2." if both are allowed, else one line per
                     write: "Saved <n>." or "Not saving <n>.".
- "please update <uid>"
                  -> ToolStarted + ConfirmRequest for update_block of the
                     first word after the trigger to "Replaced.", its card
                     built by the real `preview_write` over the engine's
                     reader (so it shows the block's current text), then
                     ToolFinished + "Updated." or "Not updating."; a
                     refused card is its message as text instead.
- "please hang"   -> parks forever (never yields, never finishes) until the
                     consumer stops iterating (e2e drive for the Stop
                     button: nothing else in this double can keep a turn
                     "busy" indefinitely to click Stop on).
- anything else   -> TextDelta("echo: <text>") + TurnDone.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Collection, Mapping, Sequence
from dataclasses import replace

from pkm.assistant.events import (
    AssistantEvent,
    ConfirmRequest,
    TextDelta,
    ToolFinished,
    ToolStarted,
    TurnDone,
)
from pkm.assistant.target_reader import BlockReader, preview_write
from pkm.assistant.write_preview import Refusal, StoredBlock
from pkm.contracts.ops import BlockUid
from pkm.contracts.responses import ConfirmId
from pkm.test_data.ids import confirm_id_of


def _no_rows(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
             ancestors_of: Collection[BlockUid]
             ) -> Mapping[BlockUid, StoredBlock]:
    """The reader of an engine with no database: no block has any uid."""
    return {}


class FakeConversation:
    def __init__(self, system_prompt: str, model: str,
                 read_blocks: BlockReader) -> None:
        self.system_prompt = system_prompt
        self._read_blocks = read_blocks
        self.model = model
        self.closed = False
        self.healthy = True
        self.sent: list[str] = []
        self._decisions: dict[ConfirmId, asyncio.Future[bool]] = {}
        self._confirm_seq = 0

    async def send(self, text: str) -> AsyncGenerator[AssistantEvent, None]:
        self.sent.append(text)
        if "please hang" in text:
            await asyncio.Event().wait()  # never set: blocks until cancelled
            return  # pragma: no cover - unreachable
        if "please write twice" in text:
            futs: list[asyncio.Future[bool]] = []
            for page in ("Demo", "Demo 2"):
                card, fut = await self._park_save_note(page)
                futs.append(fut)
                yield ToolStarted(name="save_note", summary="saving a note")
                yield card
            decisions = [await fut for fut in futs]
            for allowed in decisions:
                if allowed:
                    yield ToolFinished(name="save_note")
            if all(decisions):
                yield TextDelta(text="Saved 2.")
            else:
                for n, allowed in enumerate(decisions, start=1):
                    word = "Saved" if allowed else "Not saving"
                    yield TextDelta(text=f"{word} {n}.")
            yield TurnDone(usage={"input_tokens": 1})
            return
        if "please update" in text:
            async for event in self._update(text):
                yield event
            return
        if "please write" in text:
            card, fut = await self._park_save_note("Demo")
            yield ToolStarted(name="save_note", summary="saving a note")
            yield card
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

    async def _update(self, text: str) -> AsyncGenerator[AssistantEvent, None]:
        words = text.split("please update", 1)[1].split()
        uid = words[0] if words else ""
        parked = await self._park("update_block",
                                  {"uid": uid, "text": "Replaced."})
        yield ToolStarted(name="update_block", summary="updating a block")
        if isinstance(parked, Refusal):
            yield TextDelta(text=parked.message)
            yield TurnDone(usage={"input_tokens": 1})
            return
        card, fut = parked
        yield card
        if await fut:
            yield ToolFinished(name="update_block")
            yield TextDelta(text="Updated.")
        else:
            yield TextDelta(text="Not updating.")
        yield TurnDone(usage={"input_tokens": 1})

    async def _park_save_note(
            self, page: str) -> tuple[ConfirmRequest, asyncio.Future[bool]]:
        """A confirm card for save_note("Demo", page=`page`), with the
        future its decision lands in."""
        parked = await self._park("save_note", {"text": "Demo", "page": page})
        assert not isinstance(parked, Refusal)
        return parked

    async def _park(self, short: str, tool_input: dict[str, object]
                    ) -> tuple[ConfirmRequest, asyncio.Future[bool]] | Refusal:
        """A confirm card for write `short`, built as the real engine
        builds it, with the future its decision lands in; or the refusal
        the real engine would send the model instead. Its stamp says
        whether another card of this double was undecided at the read: its
        writes finish when decided."""
        in_flight = self._undecided()
        preview = await preview_write(short, tool_input, self._read_blocks)
        if isinstance(preview, Refusal):
            return preview
        preview = replace(preview,
                          writes_in_flight=in_flight or self._undecided())
        self._confirm_seq += 1
        confirm_id = confirm_id_of(f"fake-confirm-{self._confirm_seq}")
        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._decisions[confirm_id] = fut
        card = ConfirmRequest(confirm_id=confirm_id,
                              ops_preview=preview.summary, preview=preview)
        return card, fut

    def _undecided(self) -> bool:
        return any(not fut.done() for fut in self._decisions.values())

    def resolve_confirm(self, confirm_id: ConfirmId, allow: bool) -> None:
        fut = self._decisions.get(confirm_id)
        if fut is not None and not fut.done():
            fut.set_result(allow)

    async def close(self) -> None:
        self.closed = True
        for fut in self._decisions.values():
            if not fut.done():
                fut.set_result(False)


class FakeEngine:
    def __init__(self, read_blocks: BlockReader | None = None) -> None:
        self.conversations: list[FakeConversation] = []
        self._read_blocks = read_blocks or _no_rows

    async def create_conversation(self, system_prompt: str, model: str) -> FakeConversation:
        conv = FakeConversation(system_prompt, model, self._read_blocks)
        self.conversations.append(conv)
        return conv
