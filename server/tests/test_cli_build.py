import itertools

import pytest

from pkm.cli.build import (BuildError, next_child_idx, parse_outline,
                           plan_batch, plan_save, referenced_pages,
                           resolve_parent)


def _node(uid, text, children=(), heading=None):
    return {"uid": uid, "text": text, "heading": heading, "view_type": None,
            "collapsed": False, "order_idx": 0, "created_at": None,
            "updated_at": None, "children": list(children)}


PAYLOAD = {
    "page": {"id": 1, "title": "Machine Learning", "created_at": None,
             "updated_at": None},
    "blocks": [
        _node("u1", "Tags:: #AI"),
        _node("u2", "Papers", heading=2,
              children=[_node("u3", "existing child")]),
    ],
    "backlinks": {"groups": [], "total_pages": 0, "offset": 0, "limit": 100},
    "block_ref_texts": {},
}


def uid_gen():
    return (f"gen_uid_{i}" for i in itertools.count())


def test_parse_outline_depths():
    assert parse_outline("a\n  b\n    c\nd\n") == [
        (0, "a"), (1, "b"), (2, "c"), (0, "d")]


def test_parse_outline_tabs_and_blank_lines():
    assert parse_outline("a\n\tb\n\n\tc") == [(0, "a"), (1, "b"), (1, "c")]


def test_parse_outline_clamps_depth_jumps():
    assert parse_outline("a\n      too deep") == [(0, "a"), (1, "too deep")]


def test_next_child_idx():
    assert next_child_idx(PAYLOAD["blocks"], None) == 2
    assert next_child_idx(PAYLOAD["blocks"], "u2") == 1


def test_resolve_parent_forms():
    assert resolve_parent(PAYLOAD, None) == (None, None)
    assert resolve_parent(PAYLOAD, "((u3))") == ("u3", None)
    assert resolve_parent(PAYLOAD, "## Papers") == ("u2", None)
    assert resolve_parent(PAYLOAD, "## Notes") == (None, (2, "Notes"))


def test_resolve_parent_unknown_uid_raises():
    with pytest.raises(BuildError, match="not on page"):
        resolve_parent(PAYLOAD, "((zzz999))")


def test_plan_save_appends_at_end_of_page():
    ops = plan_save(PAYLOAD, "Machine Learning", None, "new note",
                    todo=False, uids=uid_gen())
    assert ops == [{"op": "create", "uid": "gen_uid_0",
                    "page_title": "Machine Learning", "parent_uid": None,
                    "order_idx": 2, "text": "new note"}]


def test_plan_save_outline_nests():
    ops = plan_save(PAYLOAD, "Machine Learning", "((u2))",
                    "item\n  sub item", todo=False, uids=uid_gen())
    assert [o["parent_uid"] for o in ops] == ["u2", "gen_uid_0"]
    assert [o["order_idx"] for o in ops] == [1, 0]


def test_plan_save_todo_marks_top_level_items_only():
    ops = plan_save(PAYLOAD, "Machine Learning", None,
                    "task\n  detail", todo=True, uids=uid_gen())
    assert ops[0]["text"] == "{{TODO}} task"
    assert ops[1]["text"] == "detail"


def test_plan_save_creates_missing_heading_first():
    ops = plan_save(PAYLOAD, "Machine Learning", "## Notes", "under it",
                    todo=False, uids=uid_gen())
    assert ops[0] == {"op": "create", "uid": "gen_uid_0",
                      "page_title": "Machine Learning", "parent_uid": None,
                      "order_idx": 2, "text": "Notes", "heading": 2}
    assert ops[1]["parent_uid"] == "gen_uid_0"
    assert ops[1]["order_idx"] == 0


def test_plan_save_multiple_appends_increment_order():
    ops = plan_save(PAYLOAD, "Machine Learning", None, "a\nb",
                    todo=False, uids=uid_gen())
    assert [o["order_idx"] for o in ops] == [2, 3]


def test_referenced_pages():
    cmds = [{"command": "create", "params": {"page": "A", "text": "x"}},
            {"command": "delete", "params": {"uid": "u9"}},
            {"command": "outline", "params": {"page": "B", "items": ["y"]}}]
    assert referenced_pages(cmds) == ["A", "B"]


def test_plan_batch_create_with_alias_parent():
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning",
                    "text": "[[Meeting]] notes", "as": "mtg"}},
        {"command": "outline",
         "params": {"page": "Machine Learning", "parent": "{{mtg}}",
                    "items": ["Attendees", "Actions"]}},
    ]
    ops = plan_batch(cmds, {"Machine Learning": PAYLOAD}, uid_gen())
    assert ops[0]["text"] == "[[Meeting]] notes"
    assert ops[1]["parent_uid"] == ops[0]["uid"]
    assert ops[2]["parent_uid"] == ops[0]["uid"]
    assert [o["order_idx"] for o in ops] == [2, 0, 1]


def test_plan_batch_todo_update_move_delete():
    cmds = [
        {"command": "todo", "params": {"page": "Machine Learning",
                                       "text": "follow up"}},
        {"command": "update", "params": {"uid": "u3", "text": "edited"}},
        {"command": "move", "params": {"uid": "u1", "page": "Machine Learning",
                                       "parent": "((u2))"}},
        {"command": "delete", "params": {"uid": "u3"}},
    ]
    ops = plan_batch(cmds, {"Machine Learning": PAYLOAD}, uid_gen())
    assert ops[0]["text"] == "{{TODO}} follow up"
    assert ops[1] == {"op": "update_text", "uid": "u3", "text": "edited"}
    assert ops[2] == {"op": "move", "uid": "u1", "parent_uid": "u2",
                      "order_idx": 1, "page_title": None}
    assert ops[3] == {"op": "delete", "uid": "u3"}


def test_plan_batch_unknown_command_and_alias():
    with pytest.raises(BuildError, match="unknown command"):
        plan_batch([{"command": "zap", "params": {}}], {}, uid_gen())
    with pytest.raises(BuildError, match="unknown alias"):
        plan_batch([{"command": "create",
                     "params": {"page": "Machine Learning", "text": "x",
                                "parent": "{{nope}}"}}],
                   {"Machine Learning": PAYLOAD}, uid_gen())


def test_plan_batch_missing_page_payload():
    with pytest.raises(BuildError, match="page not fetched"):
        plan_batch([{"command": "create", "params": {"page": "X", "text": "x"}}],
                   {}, uid_gen())


def test_plan_batch_reuses_repeated_missing_heading():
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "parent": "## Notes",
                    "text": "first"}},
        {"command": "create",
         "params": {"page": "Machine Learning", "parent": "## Notes",
                    "text": "second"}},
    ]
    ops = plan_batch(cmds, {"Machine Learning": PAYLOAD}, uid_gen())
    heading_ops = [o for o in ops if o.get("heading") is not None]
    content_ops = [o for o in ops if o.get("heading") is None]
    assert len(heading_ops) == 1
    assert [o["parent_uid"] for o in content_ops] == [heading_ops[0]["uid"]] * 2
    assert [o["order_idx"] for o in content_ops] == [0, 1]
