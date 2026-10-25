"""Allow on the approval card applies a write only while every block the
card showed is still as the card showed it.

Each test parks a real card through `ClaudeConversation.can_use_tool`,
lets an editor write land while the card waits on the user, then allows
it and runs the real MCP tool with the input the SDK would send the CLI.
"""
import asyncio
import json
from collections.abc import Callable, Sequence
from datetime import date

import pytest
from claude_agent_sdk import PermissionResultAllow
from fake_sdk_client import FakeSDKClient, make_engine, make_result
from tool_runner import run_tool, sdk_tool_input

from pkm.assistant.events import ConfirmRequest
from pkm.assistant.policy import SYSTEM_PROMPT
from pkm.assistant.write_preview import CURRENT_EXCERPT_CHARS
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



@pytest.fixture()
def tools(pkm_client, monkeypatch):
    """The MCP tools as the assistant's `pkm-mcp --require-expect` runs
    them."""
    monkeypatch.setattr(mcp_tools, "_client_factory", lambda: pkm_client)
    monkeypatch.setattr(mcp_tools, "_cached_client", None)
    monkeypatch.setattr(mcp_tools, "_require_expect", True)
    return mcp_tools


@pytest.fixture()
def posted_ops(anon_client) -> list[dict[str, object]]:
    """Every `/api/ops` body the in-process client sends, as sent."""
    bodies: list[dict[str, object]] = []

    def record(request) -> None:
        if request.method == "POST" and request.url.path == "/api/ops":
            bodies.append(json.loads(request.content))

    anon_client.event_hooks["request"].append(record)
    return bodies


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


@pytest.mark.parametrize("then", [
    (),
    (("update", {"uid": _B2, "text": "Replaced."}),),
    (("move", {"uid": _B2, "page": "AI"}),),
], ids=["delete", "delete-then-update", "delete-then-move"])
def test_allow_refuses_a_delete_after_a_child_was_added(
        tmp_path, seeded_config, pkm_client, tools, then):
    # a later update or move of the deleted block must not narrow its
    # subtree guard to its own text
    child = uid_of("addedUnderB2")

    def add_child() -> None:
        pkm_client.post_ops([
            {"op": "create", "uid": child, "page_title": "Machine Learning",
             "parent_uid": _B2, "order_idx": 1, "text": "Added meanwhile."},
        ], batch_id=batch_id_of("editor-add-child"))

    sent = _allow(tmp_path, seeded_config.db_path, "batch",
                  _batch(("delete", {"uid": _B2}), *then), add_child)

    with pytest.raises(ApiError) as caught:
        run_tool("batch", sent)
    assert caught.value.status == 412
    assert "or a block under it changed" in caught.value.message
    for uid in (_B2, _B3, child):
        assert pkm_client.get_block(uid).block.uid == uid


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


_LONG_UID = uid_of("longBlock001")
# Longer than the excerpt the card displays; the lone surrogate is stored
# as U+FFFD, and both the card and the check must hash what is stored.
_LONG_TEXTS = ["x" * (CURRENT_EXCERPT_CHARS + 100),
               "\ud800" + "x" * (CURRENT_EXCERPT_CHARS + 100)]


def _create_long(pkm_client, text: str) -> str:
    """Create the long block on AI; its text as stored."""
    pkm_client.post_ops([
        {"op": "create", "uid": _LONG_UID, "page_title": "AI",
         "parent_uid": None, "order_idx": 1, "text": text},
    ], batch_id=batch_id_of("create-long-block"))
    stored = pkm_client.get_block(_LONG_UID).block.text
    assert len(stored) > CURRENT_EXCERPT_CHARS
    return stored


@pytest.mark.parametrize("text", _LONG_TEXTS, ids=["long", "lone-surrogate"])
def test_allow_applies_to_an_unchanged_long_block(
        tmp_path, seeded_config, pkm_client, tools, text):
    # the card's hash of what it read equals the check's of the store
    _create_long(pkm_client, text)
    sent = _allow(tmp_path, seeded_config.db_path, "update_block",
                  {"uid": _LONG_UID, "text": "Replaced."})

    run_tool("update_block", sent)
    assert pkm_client.get_block(_LONG_UID).block.text == "Replaced."


@pytest.mark.parametrize("text", _LONG_TEXTS, ids=["long", "lone-surrogate"])
def test_allow_refuses_an_edit_past_the_excerpt(
        tmp_path, seeded_config, pkm_client, tools, text):
    # the excerpt the card displays is unchanged, but the block is not
    stored = _create_long(pkm_client, text)
    cut = CURRENT_EXCERPT_CHARS + 50
    edited = stored[:cut] + "EDIT" + stored[cut:]
    sent = _allow(tmp_path, seeded_config.db_path, "update_block",
                  {"uid": _LONG_UID, "text": "Replaced."},
                  lambda: _edit(pkm_client, _LONG_UID, stored, edited))

    with pytest.raises(ApiError) as caught:
        run_tool("update_block", sent)
    assert caught.value.status == 412
    assert pkm_client.get_block(_LONG_UID).block.text == edited


def test_an_alias_target_needs_no_expectation(
        tmp_path, seeded_config, pkm_client, tools):
    sent = _allow(tmp_path, seeded_config.db_path, "batch", _batch(
        ("create", {"page": "AI", "text": "Draft.", "as": "a"}),
        ("update", {"uid": "{{a}}", "text": "Replaced."})))

    run_tool("batch", sent)
    texts = _page_texts(pkm_client, raw_title_of("AI"))
    assert "Replaced." in texts
    assert "Draft." not in texts


@pytest.mark.parametrize("short,tool_input,shown", [
    ("update_block", {"uid": _B4, "text": "Replaced."}, [(_B4, "text")]),
    ("batch", _batch(("update", {"uid": _B4, "text": "Replaced."})),
     [(_B4, "text")]),
    ("batch", _batch(("move", {"uid": _B4, "page": "AI"})), [(_B4, "text")]),
    ("batch", _batch(("delete", {"uid": _B2})), [(_B2, "subtree")]),
    ("batch", _batch(("update", {"uid": _B4, "text": "Replaced."}),
                     ("delete", {"uid": _B2})),
     [(_B4, "text"), (_B2, "subtree")]),
])
def test_every_allowed_guarded_write_posts_its_expectations(
        tmp_path, seeded_config, pkm_client, tools, posted_ops,
        short, tool_input, shown):
    # OpBatch ignores a key it does not know, so a guard under any other
    # name, or none, would apply unchecked: read the body actually sent
    sent = _allow(tmp_path, seeded_config.db_path, short, tool_input)
    posted_ops.clear()

    run_tool(short, sent)
    (body,) = posted_ops
    expect = body["expect"]
    assert isinstance(expect, list) and expect
    assert expect == sent["expect"]
    assert [(e["uid"], e["kind"]) for e in expect] == shown
    assert all(e["shown_hash"] for e in expect)


@pytest.mark.parametrize("spec", ["((uid_b4))", " uid_b4", "uid_b4 "])
def test_a_uid_spelling_the_card_does_not_read_writes_nothing(
        tmp_path, seeded_config, pkm_client, tools, spec):
    # the card guards no stored block for it, so the write must not reach
    # one: the server refuses the uid no block can have
    sent = _allow(tmp_path, seeded_config.db_path, "batch",
                  _batch(("update", {"uid": spec, "text": "Replaced."})),
                  lambda: _edit(pkm_client, _B4, _B4_TEXT, _EDITED))

    assert sent["expect"] == []
    with pytest.raises(ApiError) as caught:
        run_tool("batch", sent)
    assert caught.value.status == 400
    assert pkm_client.get_block(_B4).block.text == _EDITED
    today = raw_title_of(canonical_daily_title(date.today()))
    assert not any("Replaced." in t for t in _page_texts(pkm_client, today))
