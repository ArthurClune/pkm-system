import asyncio
import inspect
import json
import subprocess
import sys
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
from pkm.mcp import tools as mcp_tools
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


@pytest.mark.parametrize(("short", "raw", "key"), [
    # a Cyrillic i: the tool ignores this key, so a card row for it would
    # be a decoy uid beside the real one
    ("update_block", {"uid": "IMPORTANT01", "text": "x",
                      "u\u0456d": "junk123"}, "u\u0456d"),
    ("save_note", {"text": "t", "extra": "z"}, "extra"),
    # batch's only argument is `commands`; a `uid` beside it is ignored
    ("batch", {"commands": [{"command": "delete",
                             "params": {"uid": "IMPORTANT01"}}],
               "uid": "junk123"}, "uid"),
    ("batch", {"commands": [{"command": "create",
                             "params": {"page": "Secret", "text": "x"}}],
               "page": None}, "page"),
])
def test_unknown_key_is_refused(short, raw, key):
    r = _refusal(short, raw)
    assert r.message == f"{short}: unknown argument {json.dumps(key)}"


@pytest.mark.parametrize("brk", ["\n", "\r", "\u2028", "\u2029", "\x85"])
def test_unknown_key_refusal_is_one_line(brk):
    r = _refusal("save_note", {"text": "t", f"x{brk}fake": 1})
    assert len(r.message.splitlines()) == 1


def test_a_declared_alias_is_not_unknown(monkeypatch):
    from mcp.server.fastmcp.utilities.func_metadata import func_metadata

    from pkm.assistant import write_preview
    monkeypatch.setitem(write_preview.WRITE_PREVIEW_FIELDS, "stub",
                        ("stub", ("json",), ("text",)))
    monkeypatch.setitem(write_preview._ARG_MODELS, "stub",
                        func_metadata(_stub_tool))
    assert isinstance(build_write_preview("stub", {"text": "t", "json": "P"}),
                      WritePreview)
    assert isinstance(build_write_preview("stub", {"text": "t",
                                                   "field_json": "P"}),
                      WritePreview)


def test_a_declared_field_the_table_misses_is_still_a_target(monkeypatch):
    from pkm.assistant import write_preview
    monkeypatch.setitem(write_preview.WRITE_PREVIEW_FIELDS, "save_note",
                        ("save note", ("page",), ("text",)))
    p = _preview("save_note", {"text": "t", "parent": "## Log"})
    assert p.ops[0].targets == [("page", None), ("parent", "## Log"),
                                ("todo", False)]


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


@pytest.mark.parametrize("brk", ["\n", "\r", "\u2028", "\u2029", "\x85"])
def test_summary_is_one_line(brk):
    p = _preview("save_note", {"text": "a\nb", "page": f"In{brk}box"})
    assert len(p.summary.splitlines()) == 1
    assert p.summary.startswith("save_note")


def test_preview_is_a_snapshot_of_the_input():
    commands = [{"command": "move", "params": {"uid": "U1", "page": "P"}}]
    p = _preview("batch", {"commands": commands})
    commands[0]["params"]["uid"] = "SWAPPED"
    assert ("uid", "U1") in p.ops[0].targets


def test_merge_warning_quotes_the_titles_as_values():
    new_title = 'P" exists. (Merge disabled here; "'
    p = _preview("rename_page", {"title": "Inbox", "new_title": new_title,
                                 "allow_merge": True})
    (warning,) = p.ops[0].warnings
    assert json.dumps(new_title) in warning
    assert json.dumps("Inbox") in warning


def test_outline_leaf_newline_cannot_imitate_a_child():
    def shown(items):
        p = _preview("batch", {"commands": [
            {"command": "outline", "params": {"page": "P", "items": items}}]})
        return p.ops[0].content[0][1]
    assert shown(["a\n  b"]) != shown(["a", ["b"]])
    assert shown(["a\n  b"]) == "a\\n  b"


def test_outline_leaf_backslash_n_is_not_a_newline():
    """A leaf holding a literal backslash-n must not read the same as one
    holding a newline, so the backslash is escaped too."""
    def shown(items):
        p = _preview("batch", {"commands": [
            {"command": "outline", "params": {"page": "P", "items": items}}]})
        return p.ops[0].content[0][1]
    assert shown(["a\\nb"]) != shown(["a\nb"])
    assert shown(["a\\nb"]) == "a\\\\nb"
    assert shown(["a\nb"]) == "a\\nb"


def _stub_tool(text: str, json: str | None = None) -> str:
    return text


def test_param_shadowing_a_model_method_previews_its_value(monkeypatch):
    # FastMCP renames a param that shadows a BaseModel attribute (`json`)
    # to `field_json` with an alias; the preview must read it by the alias.
    from mcp.server.fastmcp.utilities.func_metadata import func_metadata

    from pkm.assistant import write_preview
    monkeypatch.setitem(write_preview.WRITE_PREVIEW_FIELDS, "stub",
                        ("stub", ("json",), ("text",)))
    monkeypatch.setitem(write_preview._ARG_MODELS, "stub",
                        func_metadata(_stub_tool))
    p = _preview("stub", {"text": "t", "json": "Inbox"})
    assert p.ops[0].targets == [("json", "Inbox")]


def test_importing_the_builder_leaves_logging_alone():
    # The web server imports this module; FastMCP() calls
    # logging.basicConfig, which would add a root handler that sends every
    # library's INFO lines to production's stderr file.
    probe = ("import logging\n"
             "root = logging.getLogger()\n"
             "before = (list(root.handlers), root.level)\n"
             "import pkm.assistant.write_preview\n"
             "after = (list(root.handlers), root.level)\n"
             "print(before == after, before, after)\n")
    out = subprocess.run([sys.executable, "-I", "-c", probe],
                         capture_output=True, text=True, check=True)
    assert out.stdout.startswith("True"), out.stdout + out.stderr


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
    batch_params = inspect.signature(mcp_tools.batch).parameters
    assert set(batch_params) == {"commands"}
    for short in WRITE_TOOLS:
        if short == "batch":
            continue
        _, targets, content = WRITE_PREVIEW_FIELDS[short]
        params = set(inspect.signature(getattr(mcp_tools, short)).parameters)
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
        monkeypatch.setattr(mcp_tools, "_client", lambda: fake_client)
        monkeypatch.setattr(mcp_tools, "save_blocks", self._save)
        monkeypatch.setattr(mcp_tools, "edit_block", self._edit)
        monkeypatch.setattr(mcp_tools, "apply_batch", self._batch)
        monkeypatch.setattr(mcp_tools, "render_ops_ack", lambda ack: "ok")
        monkeypatch.setattr(mcp_tools, "upload_and_link", self._upload)

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
