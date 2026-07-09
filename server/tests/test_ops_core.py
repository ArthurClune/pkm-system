import pytest
from pydantic import ValidationError

from pkm.server.ops_core import (BlockInfo, BlockOp, CreateOp, DeleteBlocks,
                                 DeleteOp, InsertBlock, MoveOp, OpBatch,
                                 OpContext, OpError, ReindexRefs,
                                 SetCollapsed, SetCollapsedOp, SetParent,
                                 ShiftSiblings, TouchPage, UpdateText,
                                 UpdateTextOp, plan_op)

B = BlockInfo(uid="uid_b3", page_id=1, parent_uid="uid_b2")


def test_batch_parses_discriminated_ops():
    batch = OpBatch(client_id="c1", ops=[
        {"op": "create", "uid": "newuid1", "page_title": "P",
         "order_idx": 0, "text": "hi"},
        {"op": "delete", "uid": "uid_b3"},
    ])
    assert isinstance(batch.ops[0], CreateOp)
    assert isinstance(batch.ops[1], DeleteOp)


def test_batch_rejects_unknown_op_and_empty():
    with pytest.raises(ValidationError):
        OpBatch(client_id="c1", ops=[{"op": "explode", "uid": "uid_b3"}])
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
    with pytest.raises(OpError, match="cross-page"):
        plan_op(0, MoveOp(op="move", uid="uid_b3", parent_uid="uid_b6",
                          order_idx=0),
                OpContext(block=B, parent=BlockInfo("uid_b6", 2, None),
                          parent_chain=("uid_b6",)))


def test_plan_delete_and_collapse():
    assert plan_op(0, DeleteOp(op="delete", uid="uid_b2"),
                   OpContext(block=BlockInfo("uid_b2", 1, None),
                             subtree=("uid_b3", "uid_b2"))) == (
        DeleteBlocks(("uid_b3", "uid_b2")), TouchPage(1))
    assert plan_op(0, SetCollapsedOp(op="set_collapsed", uid="uid_b2",
                                     collapsed=True),
                   OpContext(block=BlockInfo("uid_b2", 1, None))) == (
        SetCollapsed("uid_b2", True), TouchPage(1))


def test_op_error_carries_index():
    with pytest.raises(OpError) as e:
        plan_op(7, DeleteOp(op="delete", uid="ghost99"), OpContext())
    assert e.value.index == 7 and "not found" in e.value.reason
