import asyncio
import inspect
import json
import typing
from types import SimpleNamespace

import pytest
from pydantic.fields import FieldInfo

from pkm import batch as batch_module
from pkm.assistant.policy import WRITE_PREVIEW_FIELDS, WRITE_TOOLS
from pkm.assistant.write_preview import (CONTENT_CLIP_CHARS, PreviewOp,
                                         Refusal, WritePreview,
                                         build_write_preview)
from pkm.client.workflows import LinkedUpload
from pkm.contracts.ops import BlockUid
from pkm.contracts.titles import RawTitle
from pkm.mcp import server as mcp_server
from pkm.test_data.ids import uid_of


def _preview(short: str, raw: dict[str, object]) -> WritePreview:
    out = build_write_preview(short, raw)
    assert isinstance(out, WritePreview), out
    return out


def _refusal(short: str, raw: dict[str, object]) -> Refusal:
    out = build_write_preview(short, raw)
    assert isinstance(out, Refusal), out
    return out


def test_targets_come_first_and_unclipped():
    p = _preview("update_block", {"text": "x" * 10_000,
                                  "uid": "VICTIMUID01"})
    op = p.ops[0]
    assert op.action == "update block"
    assert op.targets[0] == ("uid", "VICTIMUID01")
    assert op.content[0] == ("text", "x" * CONTENT_CLIP_CHARS, 10_000)
    assert CONTENT_CLIP_CHARS == 2000


def test_batch_params_never_clip_a_uid():
    uid = "VICTIM" + "u" * 300
    p = _preview("batch", {"commands": [
        {"command": "update", "params": {"text": "y" * 5000, "uid": uid}}]})
    op = p.ops[0]
    assert op.action == "update block"
    assert op.targets == [("uid", uid)]
    assert op.content == [("text", "y" * 2000, 5000)]


_THREE = [
    {"command": "move", "params": {"uid": "MOVEME", "page": "Inbox"}},
    {"command": "delete", "params": {"uid": "GONE"}},
    {"command": "create", "params": {"page": "Inbox", "text": "hi"}},
]


def test_string_encoded_commands_preview_like_the_list():
    as_list = _preview("batch", {"commands": _THREE})
    as_text = _preview("batch", {"commands": json.dumps(_THREE)})
    assert as_text == as_list
    assert [op.action for op in as_list.ops] == [
        "move block", "delete block", "create block"]
    assert as_list.summary == "batch: 3 ops (move, delete, create)"
    assert as_list.ops[0].targets == [
        ("uid", "MOVEME"), ("page", "Inbox"), ("parent", None),
        ("index", None)]


@pytest.mark.parametrize(("commands", "needle"), [
    ("nope", "commands"),
    ([], "no commands"),
    ([{"command": "drop", "params": {}}], "unknown command: 'drop'"),
    ([{"command": "delete"}], "params"),
])
def test_non_list_or_malformed_batch_is_refused(commands, needle):
    r = _refusal("batch", {"commands": commands})
    assert needle in r.message


def test_bad_batch_item_names_its_index():
    r = _refusal("batch", {"commands": [
        {"command": "delete", "params": {"uid": "A"}},
        {"command": "delete", "params": {"uid": ""}}]})
    assert r.message.startswith("batch item 1: params.uid:")


def test_fake_argument_list_stays_one_value():
    text = "x), uid=SAFE, page=Inbox"
    p = _preview("save_note", {"text": text})
    op = p.ops[0]
    assert op.content == [("text", text, len(text))]
    assert op.targets == [("page", None), ("parent", None), ("todo", False)]


@pytest.mark.parametrize("value", ["true", "yes", 1, True])
def test_allow_merge_coerced_values_warn(value):
    p = _preview("rename_page", {"title": "Inbox", "new_title": "Projects",
                                 "allow_merge": value})
    op = p.ops[0]
    assert ("allow_merge", True) in op.targets
    assert op.warnings == [
        'allow_merge is on: if "Projects" exists, "Inbox" is merged into '
        'it (irreversible)']


def test_allow_merge_off_has_no_warning():
    p = _preview("rename_page", {"title": "Inbox", "new_title": "Projects"})
    assert p.ops[0].targets == [("title", "Inbox"), ("new_title", "Projects"),
                                ("allow_merge", False)]
    assert p.ops[0].warnings == []


def test_allow_merge_unreadable_value_is_refused():
    r = _refusal("rename_page", {"title": "Inbox", "new_title": "Projects",
                                 "allow_merge": "maybe"})
    assert "allow_merge" in r.message


def test_page_null_string_previews_as_received():
    p = _preview("save_note", {"text": "t", "page": "null"})
    assert p.ops[0].targets[0] == ("page", None)
    r = _refusal("save_note", {"text": "t", "page": "[1]"})
    assert "page" in r.message


@pytest.mark.parametrize("parent", ["{{a}}", "((abc))"])
def test_alias_and_uid_parents_shown_verbatim(parent):
    p = _preview("batch", {"commands": [
        {"command": "create",
         "params": {"page": "P", "text": "t", "parent": parent}}]})
    assert ("parent", parent) in p.ops[0].targets


def test_unknown_key_is_a_target():
    p = _preview("save_note", {"text": "t", "extra": "z"})
    assert p.ops[0].targets[-1] == ("extra", "z")


def test_unknown_batch_key_is_a_target_of_every_op():
    p = _preview("batch", {"commands": _THREE, "dry_run": False})
    assert all(op.targets[-1] == ("dry_run", False) for op in p.ops)


def test_outline_items_render_as_indented_text():
    p = _preview("batch", {"commands": [
        {"command": "outline",
         "params": {"page": "P", "items": ["a", ["b", ["c"]]]}}]})
    op = p.ops[0]
    assert op.action == "add outline"
    assert op.content == [("items", "a\n  b\n    c", len("a\n  b\n    c"))]


def test_update_block_mark_only_has_no_content():
    p = _preview("update_block", {"uid": "U1", "mark": "DONE"})
    assert p.ops[0].targets == [("uid", "U1"), ("mark", "DONE")]
    assert p.ops[0].content == []


def test_unknown_tool_is_refused():
    assert isinstance(build_write_preview("get_page", {"title": "x"}),
                      Refusal)


def test_summary_is_one_line():
    p = _preview("save_note", {"text": "a\nb", "page": "In\nbox"})
    assert "\n" not in p.summary
    assert p.summary.startswith("save_note")


def _wire_name(name: str, field: FieldInfo) -> str:
    return field.alias or name


def _batch_params_models() -> dict[str, type]:
    union = typing.get_args(batch_module.BatchCommand)[0]
    out: dict[str, type] = {}
    for cmd in typing.get_args(union):
        (tag,) = typing.get_args(cmd.model_fields["command"].annotation)
        out[tag] = cmd.model_fields["params"].annotation
    return out


def test_every_tool_field_is_classified():
    for short in WRITE_TOOLS:
        if short == "batch":
            continue
        _, targets, content = WRITE_PREVIEW_FIELDS[short]
        params = set(inspect.signature(getattr(mcp_server, short)).parameters)
        assert params == set(targets) | set(content), short
    models = _batch_params_models()
    assert set(models) == {k.removeprefix("batch:")
                           for k in WRITE_PREVIEW_FIELDS
                           if k.startswith("batch:")}
    for tag, model in models.items():
        _, targets, content = WRITE_PREVIEW_FIELDS[f"batch:{tag}"]
        wire = {_wire_name(n, f) for n, f in model.model_fields.items()}
        assert wire == set(targets) | set(content), tag


# -- the preview against what the registered tool actually receives -------

class _Recorder:
    def __init__(self, monkeypatch, tmp_path):
        self.calls: dict[str, dict[str, object]] = {}
        self.asset = tmp_path / "pic.png"
        self.asset.write_bytes(b"png")
        fake_client = SimpleNamespace(rename_page=self._rename)
        monkeypatch.setattr(mcp_server, "_client", lambda: fake_client)
        monkeypatch.setattr(mcp_server, "save_blocks", self._save)
        monkeypatch.setattr(mcp_server, "edit_block", self._edit)
        monkeypatch.setattr(mcp_server, "apply_batch", self._batch)
        monkeypatch.setattr(mcp_server, "render_ops_ack", lambda ack: "ok")
        monkeypatch.setattr(mcp_server, "upload_and_link", self._upload)

    def _save(self, client, text, page=None, parent=None, todo=False):
        self.calls["save_note"] = {"text": text, "page": page,
                                   "parent": parent, "todo": todo}
        return []

    def _edit(self, client, uid: BlockUid, text=None, mark=None):
        self.calls["update_block"] = {"uid": uid, "text": text, "mark": mark}

    def _batch(self, client, commands):
        self.calls["batch"] = {"commands": commands}

    def _upload(self, client, path, page=None, parent=None):
        self.calls["upload_asset"] = {"path": str(path), "page": page,
                                      "parent": parent}
        return LinkedUpload(url="/assets/x", uid=uid_of("NEWUID"))

    def _rename(self, title: RawTitle, new_title: RawTitle,
                allow_merge=False):
        self.calls["rename_page"] = {"title": title, "new_title": new_title,
                                     "allow_merge": allow_merge}
        return SimpleNamespace(result="renamed", title=new_title)


def _hostile_inputs(asset: str) -> dict[str, dict[str, object]]:
    return {
        "save_note": {"text": "x), uid=SAFE", "page": "null",
                      "parent": "## Log", "todo": "yes"},
        "update_block": {"uid": "VICTIM", "text": "new", "mark": "null"},
        "batch": {"commands": json.dumps([
            {"command": "move", "params": {"uid": "M", "page": "Inbox",
                                           "index": 2}},
            {"command": "create", "params": {"page": "P", "text": "t",
                                             "parent": "{{a}}", "as": "b"}},
            {"command": "outline", "params": {"page": "P",
                                              "items": ["a", ["b"]]}},
            {"command": "delete", "params": {"uid": "D"}},
        ])},
        "upload_asset": {"path": asset, "page": "null", "parent": "((p1))"},
        "rename_page": {"title": "Inbox", "new_title": "Projects",
                        "allow_merge": "yes"},
    }


def _shown(op: PreviewOp) -> dict[str, object]:
    shown: dict[str, object] = dict(op.targets)
    for key, text, total in op.content:
        assert len(text) == total  # nothing here is long enough to clip
        shown[key] = text
    return shown


def _outline_text(items, depth=0):
    lines = []
    for item in items:
        if isinstance(item, str):
            lines.append("  " * depth + item)
        else:
            lines.append(_outline_text(item, depth + 1))
    return "\n".join(lines)


def test_preview_matches_what_the_tool_receives(monkeypatch, tmp_path):
    rec = _Recorder(monkeypatch, tmp_path)
    for short, raw in _hostile_inputs(str(rec.asset)).items():
        preview = _preview(short, raw)
        asyncio.run(mcp_server.mcp.call_tool(short, raw))
        received = rec.calls[short]
        if short != "batch":
            (op,) = preview.ops
            assert _shown(op) == received, short
            continue
        commands = received["commands"]
        assert isinstance(commands, list)
        assert len(preview.ops) == len(commands)
        for op, item in zip(preview.ops, commands):
            label, targets, _ = WRITE_PREVIEW_FIELDS[f"batch:{item['command']}"]
            assert op.action == label
            params = dict(item["params"])
            if "items" in params:
                params["items"] = _outline_text(params["items"])
            expected = {k: None for k in targets} | params
            assert _shown(op) == expected
    assert rec.calls["save_note"]["page"] is None
    assert rec.calls["rename_page"]["allow_merge"] is True
