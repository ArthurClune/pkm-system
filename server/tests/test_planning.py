import itertools

import pytest

from pkm.batch import (delete_uids, plan_batch, referenced_pages,
                       validate_batch)
from pkm.contracts.ops import (CreateOp, CreatePageOp, DeleteOp, MoveOp,
                               OrderIdx, SetHeadingOp, UpdateTextOp,
                               subtree_hash, text_hash)
from pkm.contracts.responses import BlockNode, PagePayload
from pkm.planning import (BuildError, asset_block_text, create_page_ops,
                          next_child_order_idx, order_idx_at_position,
                          parse_outline, plan_mark, plan_save, plan_update,
                          resolve_parent, split_heading)
from pkm.render import render_page


def _node(uid, text, children=(), heading=None, order_idx=0) -> BlockNode:
    return BlockNode(uid=uid, text=text, heading=heading, view_type=None,
                     collapsed=False, order_idx=order_idx, created_at=None,
                     updated_at=None, children=list(children))


# The planners take a page's blocks, not a whole payload -- blocks are all
# they read, and a page that doesn't exist yet has nothing else to offer.
# order_idx values are sequential (no gaps), so an append landing one past
# the last sibling's order_idx agrees with the older dense-count numbers
# these tests already assert.
BLOCKS = [
    _node("u1", "Tags:: #AI", order_idx=0),
    _node("u2", "Papers", heading=2, order_idx=1,
          children=[_node("u3", "existing child", order_idx=0)]),
]

# Same shape as BLOCKS, but with a gap in both the top-level and the child
# order keys -- as a delete leaves behind (ShiftSiblings never renumbers).
# An append must land after the last real order_idx, not at the dense
# position a count would give.
BLOCKS_WITH_GAP = [
    _node("g1", "Tags:: #AI", order_idx=0),
    _node("g2", "Papers", heading=2, order_idx=5,
          children=[_node("g3", "existing child", order_idx=0),
                    _node("g4", "second child", order_idx=5)]),
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


def test_next_child_order_idx():
    assert next_child_order_idx(BLOCKS, None) == 2
    assert next_child_order_idx(BLOCKS, "u2") == 1


def test_next_child_order_idx_lands_after_the_last_sibling_when_keys_have_a_gap():
    # Top level holds order_idx 0 and 5 (a delete left the gap): the append
    # must get 6, one past the last real key -- not 2, the dense count,
    # which `ShiftSiblings` would then splice between the existing siblings
    # instead of after them.
    assert next_child_order_idx(BLOCKS_WITH_GAP, None) == 6


def test_next_child_order_idx_lands_after_the_last_child_when_keys_have_a_gap():
    # Same bug, one level down: g2's children hold order_idx 0 and 5.
    assert next_child_order_idx(BLOCKS_WITH_GAP, "g2") == 6


def _siblings(*pairs: tuple[str, int]) -> list[tuple[str, OrderIdx]]:
    return [(uid, OrderIdx(idx)) for uid, idx in pairs]


def test_order_idx_at_position_returns_the_sibling_at_that_slot():
    siblings = _siblings(("u1", 0), ("u2", 5), ("u3", 6))
    assert order_idx_at_position(siblings, 0) == 0
    assert order_idx_at_position(siblings, 1) == 5
    assert order_idx_at_position(siblings, 2) == 6


def test_order_idx_at_position_past_the_end_appends_after_the_last_key():
    siblings = _siblings(("u1", 0), ("u2", 5))
    assert order_idx_at_position(siblings, 2) == 6
    assert order_idx_at_position(siblings, 50) == 6


def test_order_idx_at_position_with_no_siblings_is_zero():
    assert order_idx_at_position([], 0) == 0
    assert order_idx_at_position([], 3) == 0


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
    # (Planner._headings.setdefault).
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


def test_plan_save_appends_after_the_last_sibling_when_keys_have_a_gap():
    ops = plan_save(BLOCKS_WITH_GAP, "Machine Learning", None, "new note",
                    todo=False, uids=uid_gen())
    assert ops[0].order_idx == 6


def test_create_page_ops():
    assert create_page_ops(["Brand New Page", "Another New Page"]) == [
        CreatePageOp(op="create_page", page_title="Brand New Page"),
        CreatePageOp(op="create_page", page_title="Another New Page")]


def test_create_page_ops_empty():
    assert create_page_ops([]) == []


def test_asset_block_text_image_embeds():
    assert asset_block_text("cat.png", "image/png", "/api/assets/1") == \
        "![cat.png](/api/assets/1)"


def test_asset_block_text_pdf_uses_the_pdf_macro():
    assert asset_block_text("report.pdf", "application/pdf",
                            "/api/assets/2") == \
        "{{[[pdf]]: /api/assets/2}}"


def test_asset_block_text_other_mimes_are_a_plain_link():
    assert asset_block_text("notes.txt", "text/plain", "/api/assets/3") == \
        "[notes.txt](/api/assets/3)"


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


def test_plan_batch_move_under_a_block_created_in_the_same_batch():
    # The move target is a uid created earlier in the same batch, so it is
    # on no fetched page: the append position has to start at 0 instead of
    # asking the page for that block's child count, which would raise.
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "New home",
                    "as": "home"}},
        {"command": "move",
         "params": {"uid": "u1", "page": "Machine Learning",
                    "parent": "{{home}}"}},
    ]
    ops = plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen())
    home = as_create(ops[0]).uid
    assert ops[1] == MoveOp(op="move", uid="u1", parent_uid=home,
                            order_idx=0, page_title=None)


def test_plan_batch_indexed_creates_under_an_off_page_parent_compose():
    # "home" is created earlier in this same batch, so it's on no fetched
    # page -- its children still have to compose like any other parent's:
    # an index counts against what this batch has put under it so far, not
    # an empty group reset on every call.
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "Home", "as": "home"}},
        {"command": "create",
         "params": {"page": "Machine Learning", "parent": "{{home}}",
                    "text": "second", "index": 0}},
        {"command": "create",
         "params": {"page": "Machine Learning", "parent": "{{home}}",
                    "text": "appended"}},
        {"command": "create",
         "params": {"page": "Machine Learning", "parent": "{{home}}",
                    "text": "first", "index": 0}},
    ]
    ops = creates(plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen()))
    home = ops[0].uid
    assert [o.parent_uid for o in ops[1:]] == [home, home, home]
    # The plain append counts the earlier indexed create as a real child --
    # order_idx 1, not 0 as it would if the off-page group reset to empty
    # for this call.
    assert ops[2].order_idx == 1
    # The second indexed create, also at position 0, lands on whatever key
    # is there now (the first indexed create's) rather than restarting
    # from an empty group.
    assert ops[3].order_idx == ops[1].order_idx


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


def test_plan_batch_indexed_create_composes_with_later_appends():
    # `index` is a position counted against the page as the batch has left
    # it so far: an indexed create's shift is part of that state, so a
    # plain append right after it still lands last -- after the spliced-in
    # block too, not interleaved with it (the old order-key-verbatim bug).
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "spliced in",
                    "index": 0}},
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "appended first"}},
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "appended second"}},
    ]
    ops = creates(plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen()))
    assert [o.parent_uid for o in ops] == [None, None, None]
    # The spliced-in block shifts the page's two blocks (0, 1) to 1, 2, so
    # the appends land at 3 and 4 -- not 2 and 3, mid-list.
    assert [o.order_idx for o in ops] == [0, 3, 4]


def test_plan_batch_create_appends_after_the_last_sibling_when_keys_have_a_gap():
    cmds = [{"command": "create",
             "params": {"page": "Machine Learning", "text": "appended"}}]
    ops = creates(plan_batch(cmds, {"Machine Learning": BLOCKS_WITH_GAP},
                             uid_gen()))
    assert ops[0].order_idx == 6
    assert ops[0].order_idx > max(n.order_idx for n in BLOCKS_WITH_GAP)


def test_plan_batch_move_append_lands_after_the_last_sibling_when_keys_have_a_gap():
    cmds = [{"command": "move",
             "params": {"uid": "g3", "page": "Machine Learning",
                        "parent": "((g2))"}}]
    ops = plan_batch(cmds, {"Machine Learning": BLOCKS_WITH_GAP}, uid_gen())
    assert ops[0] == MoveOp(op="move", uid="g3", parent_uid="g2",
                            order_idx=6, page_title=None)


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


# -- guarded batch delete: a delete of a fetched block carries the hash of
# that block's subtree, advanced through the batch's earlier ops, so the
# server can tell whether another device edited it since the fetch.

SUBTREE = _node("r0000001", "root", children=[_node("c0000001", "child")])


def _delete_of(ops, uid) -> DeleteOp:
    [op] = [o for o in ops if isinstance(o, DeleteOp) and o.uid == uid]
    return op


def test_batch_delete_is_stamped_from_its_fetched_subtree():
    ops = plan_batch([{"command": "delete", "params": {"uid": "r0000001"}}],
                     {}, uid_gen(), subtrees={"r0000001": SUBTREE})
    assert ops == [DeleteOp(
        op="delete", uid="r0000001",
        base_subtree_hash=subtree_hash([("r0000001", "root"),
                                        ("c0000001", "child")]))]


def test_batch_delete_of_an_alias_is_unhashed():
    cmds = [
        {"command": "create",
         "params": {"page": "Machine Learning", "text": "x", "as": "n"}},
        {"command": "delete", "params": {"uid": "{{n}}"}},
    ]
    ops = plan_batch(cmds, {"Machine Learning": BLOCKS}, uid_gen(),
                     subtrees={"r0000001": SUBTREE})
    assert ops[1] == DeleteOp(op="delete", uid=as_create(ops[0]).uid)


def test_batch_delete_without_a_fetched_subtree_is_unhashed():
    # A uid whose fetch 404'd arrives as None; one never fetched is absent.
    cmds = [{"command": "delete", "params": {"uid": "gone0001"}},
            {"command": "delete", "params": {"uid": "never001"}}]
    ops = plan_batch(cmds, {}, uid_gen(), subtrees={"gone0001": None})
    assert ops == [DeleteOp(op="delete", uid="gone0001"),
                   DeleteOp(op="delete", uid="never001")]


def test_batch_update_then_delete_hashes_the_updated_text():
    cmds = [{"command": "update",
             "params": {"uid": "c0000001", "text": "edited"}},
            {"command": "delete", "params": {"uid": "r0000001"}}]
    ops = plan_batch(cmds, {}, uid_gen(), subtrees={"r0000001": SUBTREE})
    assert _delete_of(ops, "r0000001").base_subtree_hash == subtree_hash(
        [("r0000001", "root"), ("c0000001", "edited")])


def test_batch_create_under_then_delete_includes_the_created_block():
    cmds = [{"command": "create",
             "params": {"page": "Machine Learning", "text": "new",
                        "parent": "((c0000001))", "index": 0}},
            {"command": "delete", "params": {"uid": "r0000001"}}]
    blocks = [*BLOCKS, SUBTREE]
    ops = plan_batch(cmds, {"Machine Learning": blocks}, uid_gen(),
                     subtrees={"r0000001": SUBTREE})
    created = as_create(ops[0])
    assert _delete_of(ops, "r0000001").base_subtree_hash == subtree_hash(
        [("r0000001", "root"), ("c0000001", "child"), (created.uid, "new")])


def test_batch_move_into_the_subtree_leaves_the_delete_unhashed():
    # u1's own subtree was never fetched, so the delete cannot know what
    # the server's copy of it holds: no stamp, a plain delete as before.
    cmds = [{"command": "move",
             "params": {"uid": "u1", "page": "Machine Learning",
                        "parent": "((r0000001))", "index": 0}},
            {"command": "delete", "params": {"uid": "r0000001"}}]
    ops = plan_batch(cmds, {"Machine Learning": [*BLOCKS, SUBTREE]},
                     uid_gen(), subtrees={"r0000001": SUBTREE})
    assert _delete_of(ops, "r0000001").base_subtree_hash is None


def test_batch_move_out_of_the_subtree_drops_it_from_the_hash():
    deep = _node("r0000001", "root", children=[
        _node("c0000001", "child", children=[_node("g0000001", "grand")]),
        _node("c0000002", "other")])
    cmds = [{"command": "move",
             "params": {"uid": "c0000001", "page": "Machine Learning",
                        "parent": "((u2))", "index": 0}},
            {"command": "delete", "params": {"uid": "r0000001"}}]
    ops = plan_batch(cmds, {"Machine Learning": [*BLOCKS, deep]}, uid_gen(),
                     subtrees={"r0000001": deep})
    assert _delete_of(ops, "r0000001").base_subtree_hash == subtree_hash(
        [("r0000001", "root"), ("c0000002", "other")])


def test_batch_move_within_the_subtree_keeps_the_moved_block_in_the_hash():
    deep = _node("r0000001", "root", children=[
        _node("c0000001", "child", children=[_node("g0000001", "grand")]),
        _node("c0000002", "other")])
    cmds = [{"command": "move",
             "params": {"uid": "g0000001", "page": "Machine Learning",
                        "parent": "((c0000002))", "index": 0}},
            {"command": "move",
             "params": {"uid": "c0000001", "page": "Machine Learning",
                        "parent": "((u2))", "index": 0}},
            {"command": "delete", "params": {"uid": "r0000001"}}]
    ops = plan_batch(cmds, {"Machine Learning": [*BLOCKS, deep]}, uid_gen(),
                     subtrees={"r0000001": deep})
    assert _delete_of(ops, "r0000001").base_subtree_hash == subtree_hash(
        [("r0000001", "root"), ("c0000002", "other"),
         ("g0000001", "grand")])


def test_batch_move_of_the_deleted_root_keeps_its_subtree():
    # The root moves with its children wherever it goes, so moving it off
    # the page changes nothing the delete's hash covers.
    cmds = [{"command": "move",
             "params": {"uid": "r0000001", "page": "Machine Learning",
                        "parent": "((u2))", "index": 0}},
            {"command": "delete", "params": {"uid": "r0000001"}}]
    ops = plan_batch(cmds, {"Machine Learning": [*BLOCKS, SUBTREE]},
                     uid_gen(), subtrees={"r0000001": SUBTREE})
    assert _delete_of(ops, "r0000001").base_subtree_hash == subtree_hash(
        [("r0000001", "root"), ("c0000001", "child")])


def test_batch_delete_of_a_child_then_its_parent_hashes_without_the_child():
    child = SUBTREE.children[0]
    cmds = [{"command": "delete", "params": {"uid": "c0000001"}},
            {"command": "delete", "params": {"uid": "r0000001"}}]
    ops = plan_batch(cmds, {}, uid_gen(),
                     subtrees={"r0000001": SUBTREE, "c0000001": child})
    assert ops == [
        DeleteOp(op="delete", uid="c0000001",
                 base_subtree_hash=subtree_hash([("c0000001", "child")])),
        DeleteOp(op="delete", uid="r0000001",
                 base_subtree_hash=subtree_hash([("r0000001", "root")]))]


def test_batch_second_delete_of_the_same_uid_is_unhashed():
    cmds = [{"command": "delete", "params": {"uid": "r0000001"}},
            {"command": "delete", "params": {"uid": "r0000001"}}]
    ops = plan_batch(cmds, {}, uid_gen(), subtrees={"r0000001": SUBTREE})
    assert ops == [
        DeleteOp(op="delete", uid="r0000001",
                 base_subtree_hash=subtree_hash([("r0000001", "root"),
                                                 ("c0000001", "child")])),
        DeleteOp(op="delete", uid="r0000001")]


def test_delete_uids_skips_aliases():
    parsed = validate_batch([
        {"command": "create", "params": {"page": "P", "text": "x", "as": "n"}},
        {"command": "delete", "params": {"uid": "{{n}}"}},
        {"command": "delete", "params": {"uid": "b0000002"}},
        {"command": "update", "params": {"uid": "b0000009", "text": "y"}},
        {"command": "delete", "params": {"uid": "b0000001"}},
        {"command": "delete", "params": {"uid": "b0000002"}},
    ])
    assert delete_uids(parsed) == ["b0000002", "b0000001"]


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


def test_plan_update_carries_page_title_hint():
    ops = plan_update("uid_a1", "x", "y", None, page_title="AI")
    assert ops == [UpdateTextOp(op="update_text", uid="uid_a1", text="x",
                                base_text_hash=text_hash("y"),
                                page_title="AI")]


def test_plan_mark_carries_page_title_hint():
    ops = plan_mark("u3", "buy milk", "TODO", page_title="AI")
    assert ops[0].page_title == "AI"
