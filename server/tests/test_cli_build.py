import itertools

import pytest

from pkm.cli.build import (BuildError, create_page_ops, next_child_idx,
                           parse_outline, plan_batch, plan_mark, plan_save,
                           plan_update, referenced_pages, resolve_parent,
                           split_heading, validate_batch)
from pkm.cli.render import render_page
from pkm.contracts.ops import (CreateOp, CreatePageOp, DeleteOp, MoveOp,
                               SetHeadingOp, UpdateTextOp, text_hash)
from pkm.contracts.responses import BlockNode, PagePayload


def _node(uid, text, children=(), heading=None) -> BlockNode:
    return BlockNode(uid=uid, text=text, heading=heading, view_type=None,
                     collapsed=False, order_idx=0, created_at=None,
                     updated_at=None, children=list(children))


# The planners take a page's blocks, not a whole payload -- blocks are all
# they read, and a page that doesn't exist yet has nothing else to offer.
BLOCKS = [
    _node("u1", "Tags:: #AI"),
    _node("u2", "Papers", heading=2,
          children=[_node("u3", "existing child")]),
]


def uid_gen():
    return (f"gen_uid_{i}" for i in itertools.count())


def as_create(op) -> CreateOp:
    """One planned op as the CreateOp it must be. `plan_batch` returns the
    heterogeneous BlockOp union, so reading a create-only field (text,
    parent_uid, order_idx, heading) has to narrow first -- which is the
    point: an op that turned out to be a move or a delete fails here."""
    assert isinstance(op, CreateOp), op
    return op


def creates(ops) -> list[CreateOp]:
    """Same, for a batch the planner should have turned entirely into
    creates."""
    return [as_create(o) for o in ops]


def test_parse_outline_depths():
    assert parse_outline("a\n  b\n    c\nd\n") == [
        (0, "a"), (1, "b"), (2, "c"), (0, "d")]


def test_parse_outline_tabs_and_blank_lines():
    assert parse_outline("a\n\tb\n\n\tc") == [(0, "a"), (1, "b"), (1, "c")]


def test_parse_outline_clamps_depth_jumps():
    assert parse_outline("a\n      too deep") == [(0, "a"), (1, "too deep")]


def test_next_child_idx():
    assert next_child_idx(BLOCKS, None) == 2
    assert next_child_idx(BLOCKS, "u2") == 1


def test_resolve_parent_forms():
    assert resolve_parent(BLOCKS, None) == (None, None)
    assert resolve_parent(BLOCKS, "((u3))") == ("u3", None)
    assert resolve_parent(BLOCKS, "## Papers") == ("u2", None)
    assert resolve_parent(BLOCKS, "## Notes") == (None, (2, "Notes"))


def test_resolve_parent_unknown_uid_raises():
    with pytest.raises(BuildError, match="not on page"):
        resolve_parent(BLOCKS, "((zzz999))")


def test_resolve_parent_ignores_plain_block_with_matching_text():
    # A plain (non-heading) block whose text happens to equal "Notes" must
    # not be selected for a "## Notes" (level 2) parent spec -- the heading
    # is missing, so the caller should create it, not nest under prose.
    assert resolve_parent([_node("u9", "Notes")], "## Notes") == \
        (None, (2, "Notes"))


def test_resolve_parent_requires_matching_level():
    # A level-3 heading with matching text must not satisfy a level-2 spec.
    blocks = [_node("u9", "Notes", heading=3)]
    assert resolve_parent(blocks, "## Notes") == (None, (2, "Notes"))
    assert resolve_parent(blocks, "### Notes") == ("u9", None)


def test_resolve_parent_duplicate_headings_picks_first_in_document_order():
    # Two level-2 "Notes" headings on the same page, but the first is
    # nested as a child of an earlier top-level block and the second sits
    # at page top level after that block -- pinning pre-order (depth
    # first) document order, not top-level list order, as the tie-break.
    # This matches the in-batch memoization's first-write rule
    # (_Planner._headings.setdefault).
    blocks = [
        _node("container", "Some section",
              children=[_node("first", "Notes", heading=2)]),
        _node("second", "Notes", heading=2),
    ]
    assert resolve_parent(blocks, "## Notes") == ("first", None)


def test_plan_save_appends_at_end_of_page():
    ops = plan_save(BLOCKS, "Machine Learning", None, "new note",
                    todo=False, uids=uid_gen())
    assert ops == [CreateOp(op="create", uid="gen_uid_0",
                            page_title="Machine Learning", parent_uid=None,
                            order_idx=2, text="new note")]


def test_plan_save_outline_nests():
    ops = plan_save(BLOCKS, "Machine Learning", "((u2))",
                    "item\n  sub item", todo=False, uids=uid_gen())
    assert [o.parent_uid for o in ops] == ["u2", "gen_uid_0"]
    assert [o.order_idx for o in ops] == [1, 0]


def test_plan_save_todo_marks_top_level_items_only():
    ops = plan_save(BLOCKS, "Machine Learning", None,
                    "task\n  detail", todo=True, uids=uid_gen())
    assert ops[0].text == "{{TODO}} task"
    assert ops[1].text == "detail"


def test_plan_save_creates_missing_heading_first():
    ops = plan_save(BLOCKS, "Machine Learning", "## Notes", "under it",
                    todo=False, uids=uid_gen())
    assert ops[0] == CreateOp(op="create", uid="gen_uid_0",
                              page_title="Machine Learning", parent_uid=None,
                              order_idx=2, text="Notes", heading=2)
    assert ops[1].parent_uid == "gen_uid_0"
    assert ops[1].order_idx == 0


def test_plan_save_multiple_appends_increment_order():
    ops = plan_save(BLOCKS, "Machine Learning", None, "a\nb",
                    todo=False, uids=uid_gen())
    assert [o.order_idx for o in ops] == [2, 3]


def test_create_page_ops():
    assert create_page_ops(["Brand New Page", "Another New Page"]) == [
        CreatePageOp(op="create_page", page_title="Brand New Page"),
        CreatePageOp(op="create_page", page_title="Another New Page")]


def test_create_page_ops_empty():
    assert create_page_ops([]) == []


def test_referenced_pages():
    # Reads validated commands: `delete` (like `update`) addresses a block
    # by uid and names no page, so it contributes nothing to fetch.
    cmds = validate_batch(
        [{"command": "create", "params": {"page": "A", "text": "x"}},
         {"command": "delete", "params": {"uid": "u9"}},
         {"command": "outline", "params": {"page": "B", "items": ["y"]}},
         {"command": "move", "params": {"uid": "u9", "page": "A"}}])
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
    ops = creates(plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen()))
    assert ops[0].text == "[[Meeting]] notes"
    assert ops[1].parent_uid == ops[0].uid
    assert ops[2].parent_uid == ops[0].uid
    assert [o.order_idx for o in ops] == [2, 0, 1]


def test_plan_batch_todo_update_move_delete():
    cmds = [
        {"command": "todo", "params": {"page": "Machine Learning",
                                       "text": "follow up"}},
        {"command": "update", "params": {"uid": "u3", "text": "edited"}},
        {"command": "move", "params": {"uid": "u1", "page": "Machine Learning",
                                       "parent": "((u2))"}},
        {"command": "delete", "params": {"uid": "u3"}},
    ]
    ops = plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen())
    assert as_create(ops[0]).text == "{{TODO}} follow up"
    assert ops[1] == UpdateTextOp(op="update_text", uid="u3", text="edited")
    assert ops[2] == SetHeadingOp(op="set_heading", uid="u3", heading=None)
    assert ops[3] == MoveOp(op="move", uid="u1", parent_uid="u2",
                            order_idx=1, page_title=None)
    assert ops[4] == DeleteOp(op="delete", uid="u3")


def test_plan_batch_unknown_command_and_alias():
    with pytest.raises(BuildError, match="unknown command"):
        plan_batch([{"command": "zap", "params": {}}], {}, uid_gen())
    with pytest.raises(BuildError, match="unknown alias"):
        plan_batch([{"command": "create",
                     "params": {"page": "Machine Learning", "text": "x",
                                "parent": "{{nope}}"}}],
                   {"Machine Learning": BLOCKS}, uid_gen())


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
    ops = creates(plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen()))
    heading_ops = [o for o in ops if o.heading is not None]
    content_ops = [o for o in ops if o.heading is None]
    assert len(heading_ops) == 1
    assert [o.parent_uid for o in content_ops] == [heading_ops[0].uid] * 2
    assert [o.order_idx for o in content_ops] == [0, 1]


def test_plan_batch_move_rejects_wrong_level_heading():
    # A level-3 "Notes" heading on the page must not satisfy a move to
    # "## Notes" (level 2) -- move never creates a missing heading, so
    # this must fail during planning rather than silently landing under
    # the wrong-level block.
    blocks = [*BLOCKS, _node("u9", "Notes", heading=3)]
    cmds = [{"command": "move",
             "params": {"uid": "u1", "page": "Machine Learning",
                        "parent": "## Notes"}}]
    with pytest.raises(BuildError, match="move target heading does not exist"):
        plan_batch(cmds, {"Machine Learning": blocks}, uid_gen())


def test_plan_batch_create_with_index():
    cmds = [{"command": "create",
             "params": {"page": "Machine Learning", "text": "top",
                        "index": 0}}]
    ops = creates(plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen()))
    assert ops[0].order_idx == 0
    assert ops[0].parent_uid is None


def test_plan_batch_todo_with_index_under_parent():
    cmds = [{"command": "todo",
             "params": {"page": "Machine Learning", "parent": "((u2))",
                        "text": "urgent", "index": 0}}]
    ops = creates(plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen()))
    assert ops[0].order_idx == 0
    assert ops[0].parent_uid == "u2"
    assert ops[0].text == "{{TODO}} urgent"


def test_plan_batch_alias_as_uid():
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "x", "as": "n"}},
        {"command": "move",
         "params": {"uid": "{{n}}", "page": "Machine Learning",
                    "parent": "((u2))", "index": 0}},
        {"command": "update", "params": {"uid": "{{n}}", "text": "y"}},
    ]
    ops = plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen())
    new_uid = as_create(ops[0]).uid
    assert ops[1] == MoveOp(op="move", uid=new_uid, parent_uid="u2",
                            order_idx=0, page_title=None)
    assert ops[2] == UpdateTextOp(op="update_text", uid=new_uid, text="y")
    assert ops[3] == SetHeadingOp(op="set_heading", uid=new_uid,
                                  heading=None)


def test_plan_batch_alias_as_uid_unknown_raises():
    with pytest.raises(BuildError, match="unknown alias"):
        plan_batch([{"command": "delete", "params": {"uid": "{{ghost}}"}}],
                   {}, uid_gen())


# -- validate_batch: schema validation of the raw envelope, before any page
# discovery or I/O. plan_batch runs the same per-item parse internally (see
# tests below), so a malformed batch fails identically whether caught here
# or by calling plan_batch directly -- one stable error contract.

def test_validate_batch_rejects_non_list():
    with pytest.raises(BuildError, match="JSON array"):
        validate_batch("not a list")


def test_validate_batch_rejects_non_object_item():
    with pytest.raises(BuildError, match=r"batch\[0\].*object"):
        validate_batch(["not a dict"])


def test_validate_batch_rejects_missing_command():
    with pytest.raises(BuildError, match=r"batch\[0\].*command"):
        validate_batch([{"params": {}}])


def test_validate_batch_rejects_unknown_command():
    with pytest.raises(BuildError, match=r"batch\[0\]: unknown command: 'zap'"):
        validate_batch([{"command": "zap", "params": {}}])


def test_validate_batch_rejects_non_object_params():
    with pytest.raises(BuildError, match=r"batch\[0\].*params"):
        validate_batch([{"command": "create", "params": "oops"}])


def test_validate_batch_rejects_missing_field():
    with pytest.raises(BuildError, match=r"batch\[0\].*page"):
        validate_batch([{"command": "create", "params": {"text": "x"}}])


def test_validate_batch_rejects_wrong_typed_field():
    with pytest.raises(BuildError, match=r"batch\[0\].*text"):
        validate_batch([{"command": "create",
                         "params": {"page": "A", "text": 123}}])


def test_validate_batch_rejects_negative_index():
    with pytest.raises(BuildError, match=r"batch\[0\].*index"):
        validate_batch([{"command": "create",
                         "params": {"page": "A", "text": "x", "index": -1}}])


def test_validate_batch_rejects_unparseable_index():
    with pytest.raises(BuildError, match=r"batch\[0\].*index"):
        validate_batch([{"command": "create",
                         "params": {"page": "A", "text": "x",
                                    "index": "abc"}}])


def test_validate_batch_rejects_bad_nested_outline_item():
    with pytest.raises(BuildError, match=r"batch\[0\]"):
        validate_batch([{"command": "outline",
                         "params": {"page": "A", "items": ["x", 5]}}])


def test_validate_batch_rejects_empty_outline_items():
    with pytest.raises(BuildError, match=r"batch\[0\].*items"):
        validate_batch([{"command": "outline",
                         "params": {"page": "A", "items": []}}])


def test_validate_batch_rejects_nested_but_empty_outline_items():
    # items=[[]] passes a top-level min_length=1 check but flattens to zero
    # leaf strings -- must be rejected the same as items=[], not silently
    # produce a no-op batch.
    with pytest.raises(BuildError, match=r"batch\[0\].*items"):
        validate_batch([{"command": "outline",
                         "params": {"page": "A", "items": [[]]}}])


def test_validate_batch_rejects_all_empty_nested_outline_items():
    with pytest.raises(BuildError, match=r"batch\[0\].*items"):
        validate_batch([{"command": "outline",
                         "params": {"page": "A", "items": [[], [[]]]}}])


def test_validate_batch_rejects_unknown_param_key():
    # A typo'd/extra key must be caught, not silently ignored.
    with pytest.raises(BuildError, match=r"batch\[0\]"):
        validate_batch([{"command": "create",
                         "params": {"page": "A", "txt": "x"}}])


def test_validate_batch_reports_the_offending_index():
    cmds = [{"command": "create", "params": {"page": "A", "text": "ok"}},
            {"command": "create", "params": {"page": "A", "text": 123}}]
    with pytest.raises(BuildError, match=r"batch\[1\]"):
        validate_batch(cmds)


def test_validate_batch_returns_parsed_commands_for_a_valid_batch():
    cmds = [{"command": "create", "params": {"page": "A", "text": "x"}},
            {"command": "delete", "params": {"uid": "u1"}}]
    parsed = validate_batch(cmds)
    assert [c.command for c in parsed] == ["create", "delete"]


# -- plan_batch now runs the same schema parse as its first step, so the
# malformed-input cases above must also raise BuildError (never
# AttributeError/KeyError) when plan_batch is called directly.

def test_plan_batch_rejects_non_object_item():
    with pytest.raises(BuildError, match=r"batch\[0\]"):
        plan_batch(["not a dict"], {}, uid_gen())


def test_plan_batch_rejects_missing_field():
    with pytest.raises(BuildError, match=r"batch\[0\].*page"):
        plan_batch([{"command": "create", "params": {"text": "x"}}],
                   {}, uid_gen())


def test_plan_batch_rejects_negative_index():
    with pytest.raises(BuildError, match=r"batch\[0\].*index"):
        plan_batch([{"command": "create",
                    "params": {"page": "Machine Learning", "text": "x",
                               "index": -1}}],
                   {"Machine Learning": BLOCKS}, uid_gen())


def test_split_heading_levels():
    assert split_heading("# One") == ("One", 1)
    assert split_heading("## Two") == ("Two", 2)
    assert split_heading("### Three") == ("Three", 3)


@pytest.mark.parametrize("text", [
    "#Tag",                  # no space after the hash: a tag, not a heading
    "#[[Page]]",
    "#### Four",             # blocks carry levels 1-3 only
    "# ",                    # no body
    "plain text",
    "## Doc\n\nbody line",   # multi-line stays verbatim in one block
])
def test_split_heading_leaves_non_headings_alone(text):
    assert split_heading(text) == (text, None)


def test_plan_save_outline_sets_heading_levels():
    ops = plan_save(BLOCKS, "Machine Learning", None,
                    "## Overview\n  detail\n### Deeper", todo=False,
                    uids=uid_gen())
    assert [(o.text, o.heading) for o in ops] == [
        ("Overview", 2), ("detail", None), ("Deeper", 3)]


def test_plan_save_todo_marker_rides_on_a_heading():
    ops = plan_save(BLOCKS, "Machine Learning", None, "## Do it",
                    todo=True, uids=uid_gen())
    assert ops[0].text == "{{TODO}} Do it"
    assert ops[0].heading == 2


def test_plan_batch_create_and_outline_set_headings():
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "# Top"}},
        {"command": "outline",
         "params": {"page": "Machine Learning",
                    "items": ["## Section", ["body"]]}},
    ]
    ops = creates(plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen()))
    assert [(o.text, o.heading) for o in ops] == [
        ("Top", 1), ("Section", 2), ("body", None)]


def test_plan_batch_created_heading_resolves_as_a_later_parent():
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "## Notes"}},
        {"command": "create",
         "params": {"page": "Machine Learning", "parent": "## Notes",
                    "text": "beneath"}},
    ]
    ops = creates(plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen()))
    assert len(ops) == 2                  # no duplicate "Notes" heading
    assert ops[1].parent_uid == ops[0].uid


def test_render_then_save_round_trips_a_heading():
    page = PagePayload.model_validate(
        {"page": {"id": 1, "title": "Machine Learning", "created_at": None,
                  "updated_at": None},
         "blocks": BLOCKS,
         "backlinks": {"groups": [], "total_pages": 0, "offset": 0,
                       "limit": 100},
         "block_ref_texts": {}, "block_ref_counts": {}})
    line = next(ln for ln in render_page(page).splitlines()
                if "Papers" in ln)
    assert line == "- ## Papers"
    ops = plan_save([], "P", None, line.removeprefix("- "),
                    todo=False, uids=uid_gen())
    assert (ops[0].text, ops[0].heading) == ("Papers", 2)


def test_plan_update_sets_heading_from_text():
    assert plan_update("u3", "## Overview", "old text") == [
        UpdateTextOp(op="update_text", uid="u3", text="Overview",
                     base_text_hash=text_hash("old text")),
        SetHeadingOp(op="set_heading", uid="u3", heading=2)]


def test_plan_update_clears_heading_for_plain_text():
    ops = plan_update("u3", "Overview", "old text")
    assert ops[1] == SetHeadingOp(op="set_heading", uid="u3", heading=None)


def test_plan_update_without_base_text_has_no_hash_guard():
    ops = plan_update("u3", "edited")
    assert ops[0] == UpdateTextOp(op="update_text", uid="u3", text="edited")


def test_plan_update_same_plain_text_emits_a_single_op():
    # current_heading=None is a real, meaningful level (plain text), not
    # "unknown" -- the guarded path must still skip set_heading when it
    # matches the new level.
    ops = plan_update("u3", "same text", "same text", current_heading=None)
    assert ops == [UpdateTextOp(op="update_text", uid="u3", text="same text",
                                base_text_hash=text_hash("same text"))]


def test_plan_update_same_heading_level_emits_a_single_op():
    ops = plan_update("u3", "## Overview", "old text", current_heading=2)
    assert ops == [UpdateTextOp(op="update_text", uid="u3", text="Overview",
                                base_text_hash=text_hash("old text"))]


def test_plan_update_changing_level_still_sets_heading():
    ops = plan_update("u3", "## Overview", "old text", current_heading=1)
    assert ops[1] == SetHeadingOp(op="set_heading", uid="u3", heading=2)


def test_plan_update_clearing_heading_still_sets_heading():
    ops = plan_update("u3", "Overview", "old text", current_heading=2)
    assert ops[1] == SetHeadingOp(op="set_heading", uid="u3", heading=None)


def test_plan_update_batch_path_omits_current_heading_stays_unconditional():
    # No current_heading passed (the batch path) -- always both ops, even
    # when the text has no heading change at all.
    ops = plan_update("u3", "same text", "same text")
    assert ops == [
        UpdateTextOp(op="update_text", uid="u3", text="same text",
                     base_text_hash=text_hash("same text")),
        SetHeadingOp(op="set_heading", uid="u3", heading=None)]


def test_plan_mark_applies_marker_and_hash_guard_no_heading_op():
    # A bare update_text with the task marker applied plus a base_text_hash
    # guard -- and deliberately no set_heading, since `current_text` is
    # already bare (the heading level lives in its own column).
    ops = plan_mark("u3", "buy milk", "TODO")
    assert ops == [
        UpdateTextOp(op="update_text", uid="u3", text="{{TODO}} buy milk",
                     base_text_hash=text_hash("buy milk"))]


def test_plan_mark_done_toggles_existing_marker():
    ops = plan_mark("u3", "{{TODO}} buy milk", "DONE")
    assert ops == [
        UpdateTextOp(op="update_text", uid="u3", text="{{DONE}} buy milk",
                     base_text_hash=text_hash("{{TODO}} buy milk"))]


def test_plan_mark_never_emits_set_heading():
    # Even when current_text looks like it has hashes, plan_mark must not
    # interpret them as a heading marker -- it never splits the text at all.
    ops = plan_mark("u3", "## Overview", "TODO")
    assert all(op.op != "set_heading" for op in ops)
    assert ops[0].text == "{{TODO}} ## Overview"
