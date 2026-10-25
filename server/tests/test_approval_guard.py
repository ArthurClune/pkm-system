"""Allow on the approval card applies a write only while every block the
card showed is still as the card showed it.

Each test parks a real card through `ClaudeConversation.can_use_tool`,
lets an editor write land while the card waits on the user, then allows
it and runs the real MCP tool with the input the SDK would send the CLI.
"""
import asyncio
from collections.abc import Callable, Sequence
from datetime import date

import pytest
from claude_agent_sdk import PermissionResultAllow
from fake_sdk_client import FakeSDKClient, make_engine, make_result
from tool_runner import run_tool, sdk_tool_input

from pkm.assistant.events import ConfirmRequest
from pkm.assistant.policy import SYSTEM_PROMPT
from pkm.assistant.target_reader import db_block_reader
from pkm.client.core import ApiError
from pkm.contracts.ops import BlockUid, text_hash
from pkm.contracts.responses import BlockNode
from pkm.contracts.titles import RawTitle
from pkm.mcp import tools as mcp_tools
from pkm.refs import canonical_daily_title
from pkm.test_data.ids import batch_id_of, raw_title_of, uid_of

_B2 = uid_of("uid_b2")
_B3 = uid_of("uid_b3")
_B4 = uid_of("uid_b4")
_B4_TEXT = "Studying [[Machine Learning]] today"
_EDITED = "Edited in the editor."

_NOT_YET = pytest.mark.xfail(
    strict=True, reason="Allow is not yet checked against the shown text")


@pytest.fixture()
def tools(pkm_client, monkeypatch):
    monkeypatch.setattr(mcp_tools, "_client_factory", lambda: pkm_client)
    monkeypatch.setattr(mcp_tools, "_cached_client", None)
    return mcp_tools


def _allow(tmp_path, db_path, short: str, tool_input: dict[str, object],
           meanwhile: Callable[[], object] = lambda: None
           ) -> dict[str, object]:
    """Park the card for `short`, run `meanwhile` while it waits on the
    user, then Allow it: the input the SDK would send the CLI."""
    engine = make_engine(tmp_path, read_blocks=db_block_reader(db_path))

    async def scenario():
        conv = await engine.create_conversation(SYSTEM_PROMPT, "sonnet")
        client = FakeSDKClient.instances[0]

        async def model_turn():
            decision = await conv.can_use_tool(
                f"mcp__pkm__{short}", tool_input, None)
            client.feed(make_result())
            return decision

        task = asyncio.create_task(model_turn())
        stream = conv.send("go")
        card = await asyncio.wait_for(anext(stream), timeout=5)
        assert isinstance(card, ConfirmRequest)
        await asyncio.to_thread(meanwhile)
        conv.resolve_confirm(card.confirm_id, True)
        decision = await asyncio.wait_for(task, timeout=5)
        _ = [ev async for ev in stream]
        await conv.close()
        return decision

    decision = asyncio.run(scenario())
    assert isinstance(decision, PermissionResultAllow)
    return sdk_tool_input(tool_input, decision)


def _edit(pkm_client, uid: BlockUid, old: str, new: str) -> None:
    """An editor's text edit, based on the text it last saw, as the web
    sends it."""
    pkm_client.post_ops([
        {"op": "update_text", "uid": uid, "text": new,
         "base_text_hash": text_hash(old)},
    ], batch_id=batch_id_of(f"editor-edit-{uid}"))


def _batch(*commands: tuple[str, dict[str, object]]) -> dict[str, object]:
    return {"commands": [{"command": c, "params": p} for c, p in commands]}


def _texts(blocks: Sequence[BlockNode]) -> list[str]:
    return [t for b in blocks for t in [b.text, *_texts(b.children)]]


def _page_texts(pkm_client, title: RawTitle) -> list[str]:
    blocks, _ = pkm_client.get_page_blocks(title)
    return _texts(blocks)


@_NOT_YET
def test_allow_refuses_an_update_whose_block_was_edited_after_the_card(
        tmp_path, seeded_config, pkm_client, tools):
    sent = _allow(tmp_path, seeded_config.db_path, "update_block",
                  {"uid": _B4, "text": "Replaced."},
                  lambda: _edit(pkm_client, _B4, _B4_TEXT, _EDITED))

    with pytest.raises(ApiError) as caught:
        run_tool("update_block", sent)
    assert caught.value.status == 412
    assert "changed after the approval card showed it" in caught.value.message
    assert pkm_client.get_block(_B4).block.text == _EDITED


@_NOT_YET
def test_allow_refuses_a_batch_update_whose_block_was_edited(
        tmp_path, seeded_config, pkm_client, tools):
    sent = _allow(tmp_path, seeded_config.db_path, "batch",
                  _batch(("update", {"uid": _B4, "text": "Replaced."})),
                  lambda: _edit(pkm_client, _B4, _B4_TEXT, _EDITED))

    with pytest.raises(ApiError) as caught:
        run_tool("batch", sent)
    assert caught.value.status == 412
    assert "changed after the approval card showed it" in caught.value.message
    assert pkm_client.get_block(_B4).block.text == _EDITED


@_NOT_YET
def test_allow_refuses_a_move_of_a_block_whose_text_changed(
        tmp_path, seeded_config, pkm_client, tools):
    sent = _allow(tmp_path, seeded_config.db_path, "batch",
                  _batch(("move", {"uid": _B4, "page": "AI"})),
                  lambda: _edit(pkm_client, _B4, _B4_TEXT, _EDITED))

    with pytest.raises(ApiError) as caught:
        run_tool("batch", sent)
    assert caught.value.status == 412
    assert "changed after the approval card showed it" in caught.value.message
    after = pkm_client.get_block(_B4)
    assert after.page.title == "July 7th, 2026"
    assert after.block.text == _EDITED


@_NOT_YET
def test_allow_refuses_a_delete_after_a_child_was_added(
        tmp_path, seeded_config, pkm_client, tools):
    child = uid_of("addedUnderB2")

    def add_child() -> None:
        pkm_client.post_ops([
            {"op": "create", "uid": child, "page_title": "Machine Learning",
             "parent_uid": _B2, "order_idx": 1, "text": "Added meanwhile."},
        ], batch_id=batch_id_of("editor-add-child"))

    sent = _allow(tmp_path, seeded_config.db_path, "batch",
                  _batch(("delete", {"uid": _B2})), add_child)

    with pytest.raises(ApiError) as caught:
        run_tool("batch", sent)
    assert caught.value.status == 412
    assert "or a block under it changed" in caught.value.message
    for uid in (_B2, _B3, child):
        assert pkm_client.get_block(uid).block.uid == uid


@_NOT_YET
def test_allow_refuses_a_write_to_a_block_deleted_after_the_card(
        tmp_path, seeded_config, pkm_client, tools):
    def delete_it() -> None:
        pkm_client.post_ops([{"op": "delete", "uid": _B4}],
                            batch_id=batch_id_of("editor-delete-b4"))

    sent = _allow(tmp_path, seeded_config.db_path, "batch",
                  _batch(("update", {"uid": _B4, "text": "Replaced."})),
                  delete_it)

    with pytest.raises(ApiError) as caught:
        run_tool("batch", sent)
    assert caught.value.status == 412
    assert "was deleted after" in caught.value.message
    today = raw_title_of(canonical_daily_title(date.today()))
    assert not any("Replaced." in t for t in _page_texts(pkm_client, today))


@_NOT_YET
def test_allow_refuses_a_block_that_appeared_after_the_card_said_none(
        tmp_path, seeded_config, pkm_client, tools):
    later = uid_of("appearsLater01")

    def create_it() -> None:
        pkm_client.post_ops([
            {"op": "create", "uid": later, "page_title": "AI",
             "parent_uid": None, "order_idx": 1, "text": "Made offline."},
        ], batch_id=batch_id_of("editor-create-later"))

    sent = _allow(tmp_path, seeded_config.db_path, "batch",
                  _batch(("update", {"uid": later, "text": "Replaced."})),
                  create_it)

    with pytest.raises(ApiError) as caught:
        run_tool("batch", sent)
    assert caught.value.status == 412
    assert "did not exist when" in caught.value.message
    assert pkm_client.get_block(later).block.text == "Made offline."


def test_allow_applies_when_nothing_changed(
        tmp_path, seeded_config, pkm_client, tools):
    sent = _allow(tmp_path, seeded_config.db_path, "update_block",
                  {"uid": _B4, "text": "Replaced."})

    run_tool("update_block", sent)
    assert pkm_client.get_block(_B4).block.text == "Replaced."


def test_an_alias_target_needs_no_expectation(
        tmp_path, seeded_config, pkm_client, tools):
    sent = _allow(tmp_path, seeded_config.db_path, "batch", _batch(
        ("create", {"page": "AI", "text": "Draft.", "as": "a"}),
        ("update", {"uid": "{{a}}", "text": "Replaced."})))

    run_tool("batch", sent)
    texts = _page_texts(pkm_client, raw_title_of("AI"))
    assert "Replaced." in texts
    assert "Draft." not in texts
