import asyncio
from collections.abc import Collection, Sequence
from dataclasses import replace

from fake_engine import FakeEngine
from pkm.assistant.engine import AgentEngine
from pkm.assistant.events import ConfirmRequest, TextDelta, ToolFinished, ToolStarted, TurnDone
from pkm.assistant.policy import SYSTEM_PROMPT
from pkm.assistant.write_preview import (FoundBlock, MissingBlock,
                                         StoredBlock, WritePreview,
                                         build_write_preview)
from pkm.contracts.ops import BlockUid
from pkm.test_data.ids import canonical_title_of, confirm_id_of, uid_of


def test_fake_engine_satisfies_protocol():
    engine: AgentEngine = FakeEngine()  # type-checks under pyrefly
    assert isinstance(engine, FakeEngine)


def test_echo_turn():
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        return [ev async for ev in conv.send("hello")]

    events = asyncio.run(scenario())
    assert events == [TextDelta(text="echo: hello"), TurnDone(usage={"input_tokens": 1})]


def test_confirm_flow_allow():
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        events = []

        async def consume():
            async for ev in conv.send("please write"):
                events.append(ev)
                if isinstance(ev, ConfirmRequest):
                    conv.resolve_confirm(ev.confirm_id, True)

        await asyncio.wait_for(consume(), timeout=5)
        return events

    events = asyncio.run(scenario())
    assert events[0] == ToolStarted(name="save_note", summary="saving a note")
    preview = build_write_preview("save_note",
                                  {"text": "Demo", "page": "Demo"},
                                  blocks={})
    assert isinstance(preview, WritePreview)
    assert events[1] == ConfirmRequest(
        confirm_id=confirm_id_of("fake-confirm-1"),
        ops_preview=preview.summary,
        preview=replace(preview, writes_in_flight=False))
    assert ToolFinished(name="save_note") in events
    assert TextDelta(text="Saved.") in events
    assert isinstance(events[-1], TurnDone)


def test_confirm_flow_deny():
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        events = []
        async for ev in conv.send("please write"):
            events.append(ev)
            if isinstance(ev, ConfirmRequest):
                conv.resolve_confirm(ev.confirm_id, False)
        return events

    events = asyncio.run(scenario())
    assert TextDelta(text="Okay, not saving.") in events
    assert ToolFinished(name="save_note") not in events


def test_hang_scenario_parks_until_cancelled():
    # backs the e2e Stop-button test: "please hang" is the only scripted
    # scenario that stays "busy" long enough to click Stop on.
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        events = []

        async def consume():
            async for ev in conv.send("please hang"):
                events.append(ev)  # pragma: no cover - never runs

        task = asyncio.create_task(consume())
        for _ in range(3):
            await asyncio.sleep(0)  # let it reach the blocking Event().wait()
        assert not task.done()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return events, task.cancelled()

    events, cancelled = asyncio.run(scenario())
    assert events == []
    assert cancelled is True


def test_close_marks_closed():
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "haiku")
        events = []

        async def consume():
            async for ev in conv.send("please write"):
                events.append(ev)
                if isinstance(ev, ConfirmRequest):
                    break

        await asyncio.wait_for(consume(), timeout=5)
        await conv.close()
        return conv

    conv = asyncio.run(scenario())
    assert conv.closed is True
    assert conv.model == "haiku"


def test_write_twice_queues_both_confirms_before_either_answer():
    # backs the e2e confirm-queue test: the second card arrives while the
    # first is still unanswered, and each decision gets its own reply.
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        conv._confirm_seq = 4
        stream = conv.send("please write twice")
        events = []
        while len([e for e in events if isinstance(e, ConfirmRequest)]) < 2:
            events.append(await asyncio.wait_for(anext(stream), timeout=5))
        first, second = [e for e in events if isinstance(e, ConfirmRequest)]
        conv.resolve_confirm(second.confirm_id, False)
        conv.resolve_confirm(first.confirm_id, True)
        rest = [ev async for ev in stream]
        return first, second, rest

    first, second, rest = asyncio.run(scenario())
    assert first.confirm_id == confirm_id_of("fake-confirm-5")
    assert second.confirm_id == confirm_id_of("fake-confirm-6")
    assert first.preview.ops[0].targets[0] == ("page", "Demo")
    assert second.preview.ops[0].targets[0] == ("page", "Demo 2")
    # the second card was read while the first waited on the user
    assert first.preview.writes_in_flight is False
    assert second.preview.writes_in_flight is True
    texts = [e.text for e in rest if isinstance(e, TextDelta)]
    assert texts == ["Saved 1.", "Not saving 2."]
    assert isinstance(rest[-1], TurnDone)


def test_write_twice_both_allowed_says_saved_two():
    async def scenario():
        engine = FakeEngine()
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        events = []
        async for ev in conv.send("please write twice"):
            events.append(ev)
            if isinstance(ev, ConfirmRequest):
                conv.resolve_confirm(ev.confirm_id, True)
        return events

    events = asyncio.run(asyncio.wait_for(scenario(), timeout=5))
    texts = [e.text for e in events if isinstance(e, TextDelta)]
    assert texts == ["Saved 2."]
    assert events.count(ToolFinished(name="save_note")) == 2


def _update_turn(text: str, allow: bool, read_blocks=None):
    async def scenario():
        engine = FakeEngine(read_blocks=read_blocks)
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        events = []
        async for ev in conv.send(text):
            events.append(ev)
            if isinstance(ev, ConfirmRequest):
                conv.resolve_confirm(ev.confirm_id, allow)
        return events

    return asyncio.run(asyncio.wait_for(scenario(), timeout=5))


_VICTIM = uid_of("VICTIMUID01")
_INBOX = canonical_title_of("Inbox")


def test_update_trigger_parks_a_card_with_the_blocks_current_text():
    reads = []

    def read_blocks(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
            ancestors_of: Collection[BlockUid]):
        reads.append((list(uids), list(count_under)))
        return {_VICTIM: StoredBlock(_INBOX, "old")}

    events = _update_turn(f"please update {_VICTIM} now", True, read_blocks)
    assert reads == [([_VICTIM], [])]
    assert events[0] == ToolStarted(name="update_block",
                                    summary="updating a block")
    card = events[1]
    assert isinstance(card, ConfirmRequest)
    assert card.confirm_id == confirm_id_of("fake-confirm-1")
    assert card.preview.ops[0].targets[0] == ("uid", _VICTIM)
    assert card.preview.ops[0].content == [("text", "Replaced.", 9)]
    assert card.preview.ops[0].current == FoundBlock(_INBOX, "old", 3)
    assert ToolFinished(name="update_block") in events
    assert TextDelta(text="Updated.") in events
    assert isinstance(events[-1], TurnDone)


def test_update_trigger_deny():
    events = _update_turn(f"please update {_VICTIM}", False)
    assert TextDelta(text="Not updating.") in events
    assert ToolFinished(name="update_block") not in events
    # no database: no block has the uid
    card = events[1]
    assert isinstance(card, ConfirmRequest)
    assert card.preview.ops[0].current == MissingBlock()


def test_update_trigger_unreadable_target_is_refused():
    def failing(uids: Sequence[BlockUid], count_under: Collection[BlockUid],
            ancestors_of: Collection[BlockUid]):
        raise OSError("disk gone")

    events = _update_turn(f"please update {_VICTIM}", True, failing)
    assert not any(isinstance(e, ConfirmRequest) for e in events)
    assert TextDelta(text="update_block: the blocks this write changes "
                          "could not be read") in events
    assert isinstance(events[-1], TurnDone)
