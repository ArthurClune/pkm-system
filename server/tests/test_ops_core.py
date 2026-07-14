import pytest
from pydantic import ValidationError

from pkm.server.ops_core import (BlockInfo, CreateOp, DeleteBlocks,
                                 DeleteOp, InsertBlock, MoveOp, OpBatch,
                                 OpContext, OpError, ReindexRefs,
                                 SetCollapsed, SetCollapsedOp, SetHeading,
                                 SetHeadingOp, SetPageId, SetParent,
                                 SetViewType, SetViewTypeOp,
                                 ShiftSiblings, TouchPage, UpdateText,
                                 UpdateTextOp, plan_op, text_hash)

B = BlockInfo(uid="uid_b3", page_id=1, parent_uid="uid_b2")


def test_batch_parses_discriminated_ops():
    batch = OpBatch.model_validate({"client_id": "c1", "ops": [
        {"op": "create", "uid": "newuid1", "page_title": "P",
         "order_idx": 0, "text": "hi"},
        {"op": "delete", "uid": "uid_b3"},
    ]})
    assert isinstance(batch.ops[0], CreateOp)
    assert isinstance(batch.ops[1], DeleteOp)


def test_batch_rejects_unknown_op_and_empty():
    with pytest.raises(ValidationError):
        OpBatch.model_validate(
            {"client_id": "c1", "ops": [{"op": "explode", "uid": "uid_b3"}]})
    with pytest.raises(ValidationError):
        OpBatch(client_id="c1", ops=[])


def test_plan_create():
    op = CreateOp(op="create", uid="newuid1", page_title="P",
                  parent_uid="uid_b2", order_idx=1, text="t [[X]]")
    ctx = OpContext(page_id=1, parent=BlockInfo("uid_b2", 1, None))
    effects = plan_op(0, op, ctx)
    assert effects == (
        ShiftSiblings(1, "uid_b2", 1),
        InsertBlock("newuid1", 1, "uid_b2", 1, "t [[X]]", None),
        ReindexRefs("newuid1", "t [[X]]"),
        TouchPage(1),
    )


def test_plan_create_rejects_bad_uid_dup_and_foreign_parent():
    ctx = OpContext(page_id=1, parent=BlockInfo("uid_b2", 1, None))
    with pytest.raises(OpError, match="invalid uid"):
        plan_op(0, CreateOp(op="create", uid="a!", page_title="P",
                            order_idx=0, text=""), ctx)
    with pytest.raises(OpError, match="already exists"):
        plan_op(0, CreateOp(op="create", uid="uid_b3", page_title="P",
                            order_idx=0, text=""),
                OpContext(block=B, page_id=1))
    with pytest.raises(OpError, match="different page"):
        plan_op(0, CreateOp(op="create", uid="newuid1", page_title="P",
                            parent_uid="uid_b6", order_idx=0, text=""),
                OpContext(page_id=1, parent=BlockInfo("uid_b6", 2, None)))
    with pytest.raises(OpError, match="parent not found"):
        plan_op(0, CreateOp(op="create", uid="newuid1", page_title="P",
                            parent_uid="ghost99", order_idx=0, text=""),
                OpContext(page_id=1))


def test_plan_update_text():
    effects = plan_op(0, UpdateTextOp(op="update_text", uid="uid_b3",
                                      text="new"), OpContext(block=B))
    assert effects == (UpdateText("uid_b3", "new"),
                       ReindexRefs("uid_b3", "new"), TouchPage(1))
    with pytest.raises(OpError, match="block not found"):
        plan_op(3, UpdateTextOp(op="update_text", uid="ghost99", text="x"),
                OpContext())


def test_plan_move_and_cycle():
    ctx = OpContext(block=B, parent=BlockInfo("uid_b1", 1, None),
                    parent_chain=("uid_b1",))
    assert plan_op(0, MoveOp(op="move", uid="uid_b3", parent_uid="uid_b1",
                             order_idx=0), ctx) == (
        ShiftSiblings(1, "uid_b1", 0), SetParent("uid_b3", "uid_b1", 0),
        TouchPage(1))
    # to top level
    assert plan_op(0, MoveOp(op="move", uid="uid_b3", parent_uid=None,
                             order_idx=2), OpContext(block=B)) == (
        ShiftSiblings(1, None, 2), SetParent("uid_b3", None, 2), TouchPage(1))
    # moving under own descendant = cycle: uid appears in the parent chain
    with pytest.raises(OpError, match="cycle"):
        plan_op(0, MoveOp(op="move", uid="uid_b2", parent_uid="uid_b3",
                          order_idx=0),
                OpContext(block=BlockInfo("uid_b2", 1, None),
                          parent=B, parent_chain=("uid_b3", "uid_b2")))


def test_plan_delete_and_collapse():
    assert plan_op(0, DeleteOp(op="delete", uid="uid_b2"),
                   OpContext(block=BlockInfo("uid_b2", 1, None),
                             subtree=("uid_b3", "uid_b2"))) == (
        DeleteBlocks(("uid_b3", "uid_b2")), TouchPage(1))
    assert plan_op(0, SetCollapsedOp(op="set_collapsed", uid="uid_b2",
                                     collapsed=True),
                   OpContext(block=BlockInfo("uid_b2", 1, None))) == (
        SetCollapsed("uid_b2", True), TouchPage(1))


def test_plan_set_heading():
    assert plan_op(0, SetHeadingOp(op="set_heading", uid="uid_b2", heading=2),
                   OpContext(block=BlockInfo("uid_b2", 1, None))) == (
        SetHeading("uid_b2", 2), TouchPage(1))
    # clearing back to plain text
    assert plan_op(0, SetHeadingOp(op="set_heading", uid="uid_b2", heading=None),
                   OpContext(block=BlockInfo("uid_b2", 1, None))) == (
        SetHeading("uid_b2", None), TouchPage(1))
    with pytest.raises(OpError, match="block not found"):
        plan_op(0, SetHeadingOp(op="set_heading", uid="ghost99", heading=1),
                OpContext())


def test_set_heading_op_rejects_out_of_range():
    with pytest.raises(ValidationError):
        SetHeadingOp(op="set_heading", uid="uid_b2", heading=5)  # pyrefly: ignore[bad-argument-type] (deliberately out of range: asserting ValidationError)
    with pytest.raises(ValidationError):
        SetHeadingOp(op="set_heading", uid="uid_b2", heading=0)  # pyrefly: ignore[bad-argument-type] (deliberately out of range: asserting ValidationError)


def test_plan_set_view_type_and_reject_unknown_value():
    assert plan_op(
        0, SetViewTypeOp(op="set_view_type", uid="uid_b2",
                         view_type="numbered"),
        OpContext(block=BlockInfo("uid_b2", 1, None)),
    ) == (SetViewType("uid_b2", "numbered"), TouchPage(1))
    assert plan_op(
        0, SetViewTypeOp(op="set_view_type", uid="uid_b2",
                         view_type="document"),
        OpContext(block=BlockInfo("uid_b2", 1, None)),
    ) == (SetViewType("uid_b2", "document"), TouchPage(1))
    with pytest.raises(ValidationError):
        SetViewTypeOp(op="set_view_type", uid="uid_b2", view_type="table")  # pyrefly: ignore[bad-argument-type] (deliberately invalid: asserting ValidationError)


def test_set_view_type_requires_an_existing_block():
    with pytest.raises(OpError, match="block not found"):
        plan_op(
            0, SetViewTypeOp(op="set_view_type", uid="ghost99",
                             view_type="numbered"), OpContext())


def test_op_error_carries_index():
    with pytest.raises(OpError) as e:
        plan_op(7, DeleteOp(op="delete", uid="ghost99"), OpContext())
    assert e.value.index == 7 and "not found" in e.value.reason


def _move_ctx(block_page=1, parent_page=1, page_id=None):
    return OpContext(
        block=BlockInfo("u_child", block_page, None),
        parent=BlockInfo("u_parent", parent_page, None),
        parent_chain=("u_parent",),
        page_id=page_id,
        subtree=("u_gc", "u_child"))


def test_move_cross_page_under_parent_reassigns_subtree():
    op = MoveOp(op="move", uid="u_child", parent_uid="u_parent", order_idx=0)
    effects = plan_op(0, op, _move_ctx(block_page=1, parent_page=2))
    assert effects == (
        ShiftSiblings(2, "u_parent", 0),
        SetParent("u_child", "u_parent", 0),
        SetPageId(("u_gc", "u_child"), 2),
        TouchPage(1),
        TouchPage(2))


def test_move_top_level_to_named_page():
    op = MoveOp(op="move", uid="u_child", parent_uid=None, order_idx=0,
                page_title="July 1st, 2026")
    ctx = OpContext(block=BlockInfo("u_child", 1, "u_old"),
                    page_id=7, subtree=("u_child",))
    effects = plan_op(0, op, ctx)
    assert effects == (
        ShiftSiblings(7, None, 0),
        SetParent("u_child", None, 0),
        SetPageId(("u_child",), 7),
        TouchPage(1),
        TouchPage(7))


def test_move_same_page_unchanged_shape():
    # no page_title, same page: exactly the pre-existing three effects
    op = MoveOp(op="move", uid="u_child", parent_uid="u_parent", order_idx=3)
    effects = plan_op(0, op, _move_ctx(block_page=1, parent_page=1))
    assert effects == (
        ShiftSiblings(1, "u_parent", 3),
        SetParent("u_child", "u_parent", 3),
        TouchPage(1))


def test_move_page_title_must_match_parent_page():
    op = MoveOp(op="move", uid="u_child", parent_uid="u_parent", order_idx=0,
                page_title="Somewhere Else")
    with pytest.raises(OpError, match="page_title does not match"):
        plan_op(0, op, _move_ctx(parent_page=2, page_id=3))


def test_move_cycle_check_still_applies_cross_page():
    op = MoveOp(op="move", uid="u_parent", parent_uid="u_parent", order_idx=0)
    ctx = OpContext(block=BlockInfo("u_parent", 1, None),
                    parent=BlockInfo("u_parent", 2, None),
                    parent_chain=("u_parent",), subtree=("u_parent",))
    with pytest.raises(OpError, match="cycle"):
        plan_op(0, op, ctx)


_BLK = BlockInfo("uid_t1", page_id=1, parent_uid=None)


def _ctx(current="old text", order=2):
    return OpContext(block=_BLK, current_text=current, order_idx=order,
                     conflict_uid="uid_cf1")


def _op(text="new text", base="old text"):
    return UpdateTextOp(op="update_text", uid="uid_t1", text=text,
                        base_text_hash=text_hash(base))


def test_check_1_missing_block_lands_on_daily_page():
    ctx = OpContext(block=None, conflict_uid="uid_cf1",
                    daily_page_id=9, daily_append_idx=4)
    effs = plan_op(0, _op(), ctx)
    ins = next(e for e in effs if isinstance(e, InsertBlock))
    assert ins.page_id == 9 and ins.order_idx == 4 and ins.parent_uid is None
    assert ins.text == "[[conflict]] (original block deleted) new text"


def test_check_2_identical_text_is_noop_even_with_stale_hash():
    # device 2 pushes the same text device 1 already synced: base hash is
    # stale but the content matches -- never a conflict (spec section 2)
    effs = plan_op(0, _op(text="same", base="anything else"),
                   _ctx(current="same"))
    assert effs == ()


def test_check_3_absent_hash_applies_as_today():
    op = UpdateTextOp(op="update_text", uid="uid_t1", text="new")
    effs = plan_op(0, op, OpContext(block=_BLK))
    assert any(isinstance(e, UpdateText) for e in effs)
    assert not any(isinstance(e, InsertBlock) for e in effs)


def test_check_4_matching_hash_applies_without_conflict():
    effs = plan_op(0, _op(), _ctx())
    assert any(isinstance(e, UpdateText) for e in effs)
    assert not any(isinstance(e, InsertBlock) for e in effs)


def test_check_5_stale_hash_wins_and_preserves_loser_as_sibling():
    effs = plan_op(0, _op(base="what I saw before going offline"),
                   _ctx(current="server text meanwhile"))
    upd = next(e for e in effs if isinstance(e, UpdateText))
    assert upd.text == "new text"  # incoming wins (LWW)
    shift = next(e for e in effs if isinstance(e, ShiftSiblings))
    ins = next(e for e in effs if isinstance(e, InsertBlock))
    assert shift.from_idx == 3 and ins.order_idx == 3  # right after target
    assert ins.text == "[[conflict]] server text meanwhile"
