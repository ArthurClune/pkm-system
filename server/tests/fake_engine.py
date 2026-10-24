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
- "please hang"   -> parks forever (never yields, never finishes) until the
                     consumer stops iterating (e2e drive for the Stop
                     button: nothing else in this double can keep a turn
                     "busy" indefinitely to click Stop on).
- anything else   -> TextDelta("echo: <text>") + TurnDone.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator

from pkm.assistant.events import (
    AssistantEvent,
    ConfirmRequest,
    TextDelta,
    ToolFinished,
    ToolStarted,
    TurnDone,
)
from pkm.assistant.write_preview import WritePreview, build_write_preview
from pkm.contracts.responses import ConfirmId
from pkm.test_data.ids import confirm_id_of


class FakeConversation:
    def __init__(self, system_prompt: str, model: str) -> None:
        self.system_prompt = system_prompt
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
                card, fut = self._park_save_note(page)
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
        if "please write" in text:
            card, fut = self._park_save_note("Demo")
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

    def _park_save_note(
            self, page: str) -> tuple[ConfirmRequest, asyncio.Future[bool]]:
        """A confirm card for save_note("Demo", page=`page`), with the
        future its decision lands in."""
        self._confirm_seq += 1
        confirm_id = confirm_id_of(f"fake-confirm-{self._confirm_seq}")
        fut: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._decisions[confirm_id] = fut
        preview = build_write_preview("save_note",
                                      {"text": "Demo", "page": page},
                                      blocks={})
        assert isinstance(preview, WritePreview)
        card = ConfirmRequest(confirm_id=confirm_id,
                              ops_preview=preview.summary, preview=preview)
        return card, fut

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
    def __init__(self) -> None:
        self.conversations: list[FakeConversation] = []

    async def create_conversation(self, system_prompt: str, model: str) -> FakeConversation:
        conv = FakeConversation(system_prompt, model)
        self.conversations.append(conv)
        return conv
