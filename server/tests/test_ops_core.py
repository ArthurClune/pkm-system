import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from pkm.contracts.ops import (BlockOp, BlockUid, CreateOp, CreatePageOp,
                               DeleteOp, MoveOp, OpBatch, OrderIdx, PageId,
                               Sha256Hex, SetCollapsedOp, SetHeadingOp,
                               SetViewTypeOp, UpdateTextOp, subtree_hash,
                               text_hash)
from pkm.refs import CanonicalTitle, NormalizedTitle
from pkm.server.conflict_notes import deleted_header_text
from pkm.server.db import init_db, open_db
from pkm.server.ops_apply import apply_batch
from pkm.server.ops_core import (BlockContext, BlockInfo, BlockRewrite,
                                 ConflictLanding, CreateContext, DeleteBlocks,
                                 DeleteConflictContext, DeleteContext,
                                 ExistingHeader, FreshHeader, InsertBlock,
                                 JournalBlock, LandedSkipContext, MoveContext,
                                 OpError, PageContext, RecordConflictHeader,
                                 ReindexRefs, SetCollapsed, SetHeading,
                                 SetPageId, SetParent, SetViewType,
                                 ShiftSiblings, Skip, SkipContext,
                                 SkippedContext, StuckMoveContext,
                                 SubtreeRow, TextConflictContext,
                                 TextEditContext, TextEditOutcome, TouchPage,
                                 UpdateText, classify_skip,
                                 classify_text_edit, conflict_entry_effects,
                                 descendant_copy_effects, delete_diverged,
                                 plan_op, skip_report)

B = BlockInfo(uid=BlockUid("uid_b3"), page_id=PageId(1),
             parent_uid=BlockUid("uid_b2"))
_DAY = CanonicalTitle(NormalizedTitle("September 28th, 2026"))
# today's header for the target already exists: entries append under it
_EXISTING = ExistingHeader(BlockUid("uid_old"), OrderIdx(3))


def _landing(header: ExistingHeader | FreshHeader | None = None
             ) -> ConflictLanding:
    """Today's daily page 9; a fresh header uid_hd1 at slot 4 unless one
    exists already; the entry is uid_ch1."""
    return ConflictLanding(PageId(9), _DAY, BlockUid("uid_ch1"),
                           header if header is not None
                           else FreshHeader(BlockUid("uid_hd1"), OrderIdx(4)))


def _skip_ctx(op: BlockOp, *, block_exists: bool = False,
              parent_exists: bool = False, chain: tuple[str, ...] = (),
              header: ExistingHeader | None = None,
              hint_page_exists: bool = False,
              page_title: str = "Machine Learning",
              subtree: tuple[BlockUid, ...] = (BlockUid("uid_b3"),)
              ) -> SkippedContext:
    """The context ops_apply._context_for builds for an op classify_skip
    flags, with the given reads."""
    skip = classify_skip(op, block_exists, parent_exists, chain)
    assert skip is not None
    if skip.landing_uid is None:
        return SkipContext(skip)
    if skip.kind in ("move_parent_missing", "move_cycle"):
        return StuckMoveContext(skip, _landing(header), page_title, subtree)
    return LandedSkipContext(skip, _landing(header), hint_page_exists)


def test_batch_parses_discriminated_ops():
    batch = OpBatch.model_validate({"client_id": "c1", "batch_id": "test_batch1",
                                   "ops": [
        {"op": "create", "uid": "newuid1", "page_title": "P",
         "order_idx": 0, "text": "hi"},
        {"op": "delete", "uid": "uid_b3"},
    ]})
    assert isinstance(batch.ops[0], CreateOp)
    assert isinstance(batch.ops[1], DeleteOp)


def test_batch_rejects_unknown_op_and_empty():
    with pytest.raises(ValidationError):
        OpBatch.model_validate(
            {"client_id": "c1", "batch_id": "test_batch2",
             "ops": [{"op": "explode", "uid": "uid_b3"}]})
    with pytest.raises(ValidationError):
        OpBatch(client_id="c1", batch_id="test_batch3", ops=[])


def test_plan_create():
    op = CreateOp(op="create", uid="newuid1", page_title="P",
                  parent_uid="uid_b2", order_idx=1, text="t [[X]]",
                  view_type="numbered")
    effects = plan_op(0, op, CreateContext(uid_taken=False,
                                           page_id=PageId(1)))
    assert effects == (
        ShiftSiblings(PageId(1), BlockUid("uid_b2"), OrderIdx(1)),
        InsertBlock(uid=BlockUid("newuid1"), page_id=PageId(1),
                   parent_uid=BlockUid("uid_b2"), order_idx=OrderIdx(1),
                   text="t [[X]]", heading=None, view_type="numbered"),
        ReindexRefs(BlockUid("newuid1"), "t [[X]]"),
        TouchPage(PageId(1)),
    )


def test_plan_create_rejects_bad_uid_and_dup():
    with pytest.raises(OpError, match="invalid uid"):
        plan_op(0, CreateOp(op="create", uid="a!", page_title="P",
                            order_idx=0, text=""),
                CreateContext(uid_taken=False, page_id=PageId(1)))
    with pytest.raises(OpError, match="already exists"):
        plan_op(0, CreateOp(op="create", uid="uid_b3", page_title="P",
                            order_idx=0, text=""),
                CreateContext(uid_taken=True, page_id=PageId(1)))


def test_plan_create_rejects_a_uid_with_a_trailing_newline():
    # UID_RE's $ matches just before a trailing "\n" under re.match, so
    # "abcdef\n" used to pass here -- a block no ((ref)) can ever name and
    # every uid-addressed route 422s.
    with pytest.raises(OpError, match="invalid uid"):
        plan_op(0, CreateOp(op="create", uid="abcdef\n", page_title="P",
                            order_idx=0, text=""),
                CreateContext(uid_taken=False, page_id=PageId(1)))


def test_plan_create_page_executes_nothing():
    # context assembly already resolved (and created) the page
    assert plan_op(0, CreatePageOp(op="create_page", page_title="AI"),
                   PageContext(PageId(2))) == ()


def test_plan_update_text():
    effects = plan_op(0, UpdateTextOp(op="update_text", uid="uid_b3",
                                      text="new"), BlockContext(B))
    assert effects == (UpdateText(BlockUid("uid_b3"), "new"),
                       ReindexRefs(BlockUid("uid_b3"), "new"),
                       TouchPage(PageId(1)))


def test_plan_move():
    ctx = MoveContext(B, BlockInfo(BlockUid("uid_b1"), PageId(1), None),
                      None, (BlockUid("uid_b3"),))
    assert plan_op(0, MoveOp(op="move", uid="uid_b3", parent_uid="uid_b1",
                             order_idx=0), ctx) == (
        ShiftSiblings(PageId(1), BlockUid("uid_b1"), OrderIdx(0)),
        SetParent(BlockUid("uid_b3"), BlockUid("uid_b1"), OrderIdx(0)),
        TouchPage(PageId(1)))
    # to top level
    assert plan_op(0, MoveOp(op="move", uid="uid_b3", parent_uid=None,
                             order_idx=2),
                   MoveContext(B, None, None, (BlockUid("uid_b3"),))) == (
        ShiftSiblings(PageId(1), None, OrderIdx(2)),
        SetParent(BlockUid("uid_b3"), None, OrderIdx(2)), TouchPage(PageId(1)))


def test_plan_delete_and_collapse():
    assert plan_op(0, DeleteOp(op="delete", uid="uid_b2"),
                   DeleteContext(
                       BlockInfo(BlockUid("uid_b2"), PageId(1), None),
                       (BlockUid("uid_b3"), BlockUid("uid_b2")))) == (
        DeleteBlocks((BlockUid("uid_b3"), BlockUid("uid_b2"))),
        TouchPage(PageId(1)))
    # collapse/expand is not a real change -- no TouchPage, unlike every
    # other op planned here.
    assert plan_op(0, SetCollapsedOp(op="set_collapsed", uid="uid_b2",
                                     collapsed=True),
                   BlockContext(
                       BlockInfo(BlockUid("uid_b2"), PageId(1), None))
                   ) == (SetCollapsed(BlockUid("uid_b2"), True),)


# --- diverged delete: the subtree changed since the deleting device last
# saw it, so the delete still wins but the server's texts land first -------

# root r has children c2 (order_idx 5) and c1 (order_idx 2); c1 has child g
# (order_idx 0). Deepest first: g, then c1/c2, then r.
_ROOT = SubtreeRow(BlockUid("r"), None, OrderIdx(0), "root text")
_C1 = SubtreeRow(BlockUid("c1"), BlockUid("r"), OrderIdx(2), "c1 text")
_C2 = SubtreeRow(BlockUid("c2"), BlockUid("r"), OrderIdx(5), "c2 text")
_G = SubtreeRow(BlockUid("g"), BlockUid("c1"), OrderIdx(0), "g text")
_SUBTREE_ROWS = (_G, _C1, _C2, _ROOT)


def test_delete_diverged_compares_the_subtree_hash():
    base = subtree_hash((row.uid, row.text) for row in _SUBTREE_ROWS)
    assert delete_diverged(base, _SUBTREE_ROWS) is False
    changed = (_G, _C1, _C2,
              SubtreeRow(BlockUid("r"), None, OrderIdx(0), "edited elsewhere"))
    assert delete_diverged(base, changed) is True


def test_descendant_copies_nest_and_renumber():
    copy_uids = {BlockUid("c1"): BlockUid("copy_c1"),
                BlockUid("c2"): BlockUid("copy_c2"),
                BlockUid("g"): BlockUid("copy_g")}
    effects = descendant_copy_effects(_SUBTREE_ROWS, BlockUid("r"),
                                      BlockUid("copy_r"), copy_uids,
                                      daily_page_id=PageId(9))
    assert effects == (
        InsertBlock(uid=BlockUid("copy_c1"), page_id=PageId(9),
                   parent_uid=BlockUid("copy_r"), order_idx=OrderIdx(0),
                   text="c1 text", heading=None),
        ReindexRefs(BlockUid("copy_c1"), "c1 text"),
        InsertBlock(uid=BlockUid("copy_g"), page_id=PageId(9),
                   parent_uid=BlockUid("copy_c1"), order_idx=OrderIdx(0),
                   text="g text", heading=None),
        ReindexRefs(BlockUid("copy_g"), "g text"),
        InsertBlock(uid=BlockUid("copy_c2"), page_id=PageId(9),
                   parent_uid=BlockUid("copy_r"), order_idx=OrderIdx(1),
                   text="c2 text", heading=None),
        ReindexRefs(BlockUid("copy_c2"), "c2 text"),
    )


def test_descendant_copies_keep_blank_texts():
    rows = (SubtreeRow(BlockUid("c1"), BlockUid("r"), OrderIdx(0), ""),
            SubtreeRow(BlockUid("r"), None, OrderIdx(0), "root"))
    effects = descendant_copy_effects(
        rows, BlockUid("r"), BlockUid("copy_r"),
        {BlockUid("c1"): BlockUid("copy_c1")}, daily_page_id=PageId(9))
    assert effects == (
        InsertBlock(uid=BlockUid("copy_c1"), page_id=PageId(9),
                   parent_uid=BlockUid("copy_r"), order_idx=OrderIdx(0),
                   text="", heading=None),
        ReindexRefs(BlockUid("copy_c1"), ""),
    )


def test_descendant_copies_never_walk_back_into_the_root():
    # a corrupted tree can give the root a parent inside its own subtree;
    # the root is where the walk starts, never one of its descendants
    rows = (SubtreeRow(BlockUid("c1"), BlockUid("r"), OrderIdx(0), "c1 text"),
            SubtreeRow(BlockUid("r"), BlockUid("c1"), OrderIdx(0), "root"))
    effects = descendant_copy_effects(
        rows, BlockUid("r"), BlockUid("copy_r"),
        {BlockUid("c1"): BlockUid("copy_c1")}, daily_page_id=PageId(9))
    assert effects == (
        InsertBlock(uid=BlockUid("copy_c1"), page_id=PageId(9),
                   parent_uid=BlockUid("copy_r"), order_idx=OrderIdx(0),
                   text="c1 text", heading=None),
        ReindexRefs(BlockUid("copy_c1"), "c1 text"),
    )


def test_plan_diverged_delete_lands_copies_then_deletes():
    copy_uids = {BlockUid("c1"): BlockUid("copy_c1"),
                BlockUid("c2"): BlockUid("copy_c2"),
                BlockUid("g"): BlockUid("copy_g")}
    landing = _landing()  # FreshHeader, entry_uid "uid_ch1"
    ctx = DeleteConflictContext(
        BlockInfo(BlockUid("r"), PageId(1), None), _SUBTREE_ROWS,
        "Project X", landing, copy_uids)
    op = DeleteOp(op="delete", uid="r",
                 base_subtree_hash=Sha256Hex("a" * 64))
    assert plan_op(0, op, ctx) == (
        *conflict_entry_effects(BlockUid("r"), _ROOT.text,
                                deleted_header_text("Project X"), landing),
        *descendant_copy_effects(_SUBTREE_ROWS, BlockUid("r"),
                                 landing.entry_uid, copy_uids,
                                 landing.daily_page_id),
        DeleteBlocks(tuple(row.uid for row in _SUBTREE_ROWS)),
        TouchPage(PageId(1)),
    )


def test_plan_set_heading():
    assert plan_op(0, SetHeadingOp(op="set_heading", uid="uid_b2", heading=2),
                   BlockContext(
                       BlockInfo(BlockUid("uid_b2"), PageId(1), None))
                   ) == (SetHeading(BlockUid("uid_b2"), 2),
                         TouchPage(PageId(1)))
    # clearing back to plain text
    assert plan_op(0, SetHeadingOp(op="set_heading", uid="uid_b2", heading=None),
                   BlockContext(
                       BlockInfo(BlockUid("uid_b2"), PageId(1), None))
                   ) == (SetHeading(BlockUid("uid_b2"), None),
                         TouchPage(PageId(1)))


def test_set_heading_op_rejects_out_of_range():
    with pytest.raises(ValidationError):
        SetHeadingOp(op="set_heading", uid="uid_b2", heading=5)  # pyrefly: ignore[bad-argument-type] (deliberately out of range: asserting ValidationError)
    with pytest.raises(ValidationError):
        SetHeadingOp(op="set_heading", uid="uid_b2", heading=0)  # pyrefly: ignore[bad-argument-type] (deliberately out of range: asserting ValidationError)


def test_plan_set_view_type_and_reject_unknown_value():
    assert plan_op(
        0, SetViewTypeOp(op="set_view_type", uid="uid_b2",
                         view_type="numbered"),
        BlockContext(BlockInfo(BlockUid("uid_b2"), PageId(1), None)),
    ) == (SetViewType(BlockUid("uid_b2"), "numbered"), TouchPage(PageId(1)))
    assert plan_op(
        0, SetViewTypeOp(op="set_view_type", uid="uid_b2",
                         view_type="document"),
        BlockContext(BlockInfo(BlockUid("uid_b2"), PageId(1), None)),
    ) == (SetViewType(BlockUid("uid_b2"), "document"), TouchPage(PageId(1)))
    with pytest.raises(ValidationError):
        SetViewTypeOp(op="set_view_type", uid="uid_b2", view_type="table")  # pyrefly: ignore[bad-argument-type] (deliberately invalid: asserting ValidationError)


def test_op_error_carries_index():
    with pytest.raises(OpError) as e:
        plan_op(7, CreateOp(op="create", uid="a!", page_title="P",
                            order_idx=0, text=""),
                CreateContext(uid_taken=False, page_id=PageId(1)))
    assert e.value.index == 7 and "invalid uid" in e.value.reason


def test_a_context_that_does_not_fit_the_op_is_a_programmer_error_not_a_400():
    # A 400 would poison the client's queue over a shell bug the client did
    # not cause; an AssertionError is a 500, which clients retry.
    move = MoveOp(op="move", uid="uid_b3", parent_uid=None, order_idx=0)
    with pytest.raises(AssertionError):
        plan_op(0, move, DeleteContext(B, (BlockUid("uid_b3"),)))
    edit = UpdateTextOp(op="update_text", uid="uid_b3", text="x",
                        base_text_hash=text_hash("y"))
    with pytest.raises(AssertionError):
        plan_op(0, edit, TextEditContext(
            B, TextEditOutcome("conflict", "x")))


def test_a_skip_context_that_does_not_fit_its_skip_kind_is_a_programmer_error():
    # Planned silently, these would drop a skip's note, or tombstone a live
    # block and cascade its subtree away on a replica.
    heading = SetHeadingOp(op="set_heading", uid="ghost1", heading=1)
    with pytest.raises(AssertionError):
        plan_op(0, heading, SkipContext(
            Skip("orphan_structural", BlockUid("ghost1"))))
    move = MoveOp(op="move", uid="uid_b3", parent_uid="ghost_p1", order_idx=0)
    with pytest.raises(AssertionError):
        plan_op(0, move, LandedSkipContext(
            Skip("move_parent_missing", BlockUid("uid_b3")), _landing(),
            False))
    with pytest.raises(AssertionError):
        plan_op(0, heading, StuckMoveContext(
            Skip("orphan_structural", BlockUid("ghost1")), _landing(),
            "Machine Learning", (BlockUid("ghost1"),)))


def _move_ctx(block_page: int = 1, parent_page: int = 1,
             page_id: int | None = None):
    return MoveContext(
        BlockInfo(BlockUid("u_child"), PageId(block_page), None),
        BlockInfo(BlockUid("u_parent"), PageId(parent_page), None),
        PageId(page_id) if page_id is not None else None,
        (BlockUid("u_gc"), BlockUid("u_child")))


def test_move_cross_page_under_parent_reassigns_subtree():
    op = MoveOp(op="move", uid="u_child", parent_uid="u_parent", order_idx=0)
    effects = plan_op(0, op, _move_ctx(block_page=1, parent_page=2))
    assert effects == (
        ShiftSiblings(PageId(2), BlockUid("u_parent"), OrderIdx(0)),
        SetParent(BlockUid("u_child"), BlockUid("u_parent"), OrderIdx(0)),
        SetPageId((BlockUid("u_gc"), BlockUid("u_child")), PageId(2)),
        TouchPage(PageId(1)),
        TouchPage(PageId(2)))


def test_move_top_level_to_named_page():
    op = MoveOp(op="move", uid="u_child", parent_uid=None, order_idx=0,
                page_title="July 1st, 2026")
    ctx = MoveContext(
        BlockInfo(BlockUid("u_child"), PageId(1), BlockUid("u_old")),
        None, PageId(7), (BlockUid("u_child"),))
    effects = plan_op(0, op, ctx)
    assert effects == (
        ShiftSiblings(PageId(7), None, OrderIdx(0)),
        SetParent(BlockUid("u_child"), None, OrderIdx(0)),
        SetPageId((BlockUid("u_child"),), PageId(7)),
        TouchPage(PageId(1)),
        TouchPage(PageId(7)))


def test_move_same_page_unchanged_shape():
    # no page_title, same page: exactly the pre-existing three effects
    op = MoveOp(op="move", uid="u_child", parent_uid="u_parent", order_idx=3)
    effects = plan_op(0, op, _move_ctx(block_page=1, parent_page=1))
    assert effects == (
        ShiftSiblings(PageId(1), BlockUid("u_parent"), OrderIdx(3)),
        SetParent(BlockUid("u_child"), BlockUid("u_parent"), OrderIdx(3)),
        TouchPage(PageId(1)))


@pytest.mark.parametrize("page_id", [3, None])
def test_move_follows_its_parent_whatever_page_title_says(page_id):
    # page_title named the parent's page when the move was queued; another
    # device has since moved the parent to page 2. The block follows the
    # parent, and the shell no longer resolves the stale title.
    op = MoveOp(op="move", uid="u_child", parent_uid="u_parent", order_idx=0,
                page_title="Somewhere Else")
    assert plan_op(0, op, _move_ctx(parent_page=2, page_id=page_id)) == (
        ShiftSiblings(PageId(2), BlockUid("u_parent"), OrderIdx(0)),
        SetParent(BlockUid("u_child"), BlockUid("u_parent"), OrderIdx(0)),
        SetPageId((BlockUid("u_gc"), BlockUid("u_child")), PageId(2)),
        TouchPage(PageId(1)),
        TouchPage(PageId(2)))


_BLK = BlockInfo(BlockUid("uid_t1"), page_id=PageId(1), parent_uid=None)


def _op(text="new text", base="old text", page_title=None):
    return UpdateTextOp(op="update_text", uid="uid_t1", text=text,
                        base_text_hash=text_hash(base),
                        page_title=page_title)


def _text_ctx(op: UpdateTextOp, current: str,
              header: ExistingHeader | None = None,
              page_title: str = "Machine Learning",
              ) -> TextEditContext | TextConflictContext:
    """The context ops_apply._context_for builds for a hashed edit of _BLK
    whose live text is `current`."""
    assert op.base_text_hash is not None
    outcome = classify_text_edit(op.text, op.base_text_hash, current, ())
    if outcome.kind != "conflict":
        return TextEditContext(_BLK, outcome)
    return TextConflictContext(_BLK, outcome.text, current, page_title,
                               _landing(header))


def test_missing_block_creates_daily_header_naming_the_hint():
    op = _op(page_title="AI Agent Security")
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=True))
    header = next(e for e in effs if isinstance(e, InsertBlock)
                  and e.uid == "uid_hd1")
    assert (header.page_id, header.parent_uid, header.order_idx) == (9, None, 4)
    assert header.text == ("[[conflict]] [[AI Agent Security]] — edit to a "
                           "block the server no longer has")
    child = next(e for e in effs if isinstance(e, InsertBlock)
                and e.uid == "uid_ch1")
    assert (child.page_id, child.parent_uid, child.order_idx) == (9, "uid_hd1", 0)
    assert child.text == "new text"
    record = next(e for e in effs if isinstance(e, RecordConflictHeader))
    assert record == RecordConflictHeader(BlockUid("uid_t1"), _DAY,
                                          BlockUid("uid_hd1"))


@pytest.mark.parametrize("page_title", [None, "  ", "a[[b"])
def test_missing_block_without_usable_hint_says_page_unknown(page_title):
    # hint_page_exists is irrelevant here -- an unusable hint always falls
    # back to the generic label regardless.
    op = _op(page_title=page_title)
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=True))
    header = next(e for e in effs if isinstance(e, InsertBlock)
                  and e.uid == "uid_hd1")
    assert header.text == ("[[conflict]] (page unknown) — edit to a block "
                           "the server no longer has")


def test_missing_block_hint_names_a_renamed_away_page_says_not_found():
    # usable hint, but hint_page_exists is False: the page it names is gone
    # -- renamed or deleted since the client last saw it -- so the header
    # must not link it (that would recreate the page).
    op = _op(page_title="Old Title")
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=False))
    header = next(e for e in effs if isinstance(e, InsertBlock)
                  and e.uid == "uid_hd1")
    assert header.text == ("[[conflict]] `Old Title` (page not found) — "
                           "edit to a block the server no longer has")


def test_missing_block_hint_with_backtick_and_no_page_says_page_unknown():
    # usable hint, no such page, but the title itself holds a backtick: an
    # inline-code span can't safely wrap it, so this also falls back to the
    # generic label rather than emitting a broken/misleading code span.
    op = _op(page_title="a`b")
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=False))
    header = next(e for e in effs if isinstance(e, InsertBlock)
                  and e.uid == "uid_hd1")
    assert header.text == ("[[conflict]] (page unknown) — edit to a block "
                           "the server no longer has")


def test_missing_block_appends_under_todays_header():
    op = _op(page_title="AI Agent Security")
    effs = plan_op(0, op, _skip_ctx(op, header=_EXISTING))
    inserts = [e for e in effs if isinstance(e, InsertBlock)]
    assert inserts == [InsertBlock(
        uid=BlockUid("uid_ch1"), page_id=PageId(9),
        parent_uid=BlockUid("uid_old"), order_idx=OrderIdx(3), text="new text",
        heading=None)]
    assert not any(isinstance(e, RecordConflictHeader) for e in effs)


def test_check_2_identical_text_is_noop_even_with_stale_hash():
    # device 2 pushes the same text device 1 already synced: base hash is
    # stale but the content matches -- never a conflict (spec section 2)
    op = _op(text="same", base="anything else")
    assert plan_op(0, op, _text_ctx(op, "same")) == ()


def test_check_3_absent_hash_applies_as_today():
    op = UpdateTextOp(op="update_text", uid="uid_t1", text="new")
    effs = plan_op(0, op, BlockContext(_BLK))
    assert any(isinstance(e, UpdateText) for e in effs)
    assert not any(isinstance(e, InsertBlock) for e in effs)


def test_check_4_matching_hash_applies_without_conflict():
    op = _op()
    assert plan_op(0, op, _text_ctx(op, "old text")) == (
        UpdateText(BlockUid("uid_t1"), "new text"),
        ReindexRefs(BlockUid("uid_t1"), "new text"), TouchPage(PageId(1)))


def test_check_5_incoming_wins_and_loser_goes_to_daily_header():
    op = _op(base="what I saw before going offline")
    effs = plan_op(0, op, _text_ctx(op, "server text meanwhile"))
    upd = next(e for e in effs if isinstance(e, UpdateText))
    assert upd == UpdateText(BlockUid("uid_t1"), "new text")  # incoming wins (LWW)
    assert not any(isinstance(e, ShiftSiblings) for e in effs)
    header = next(e for e in effs if isinstance(e, InsertBlock)
                  and e.uid == "uid_hd1")
    assert header.text == ("[[conflict]] [[Machine Learning]] — overwritten "
                           "by ((uid_t1))")
    child = next(e for e in effs if isinstance(e, InsertBlock)
                and e.uid == "uid_ch1")
    assert child.text == "server text meanwhile"
    assert not any(isinstance(e, InsertBlock) and e.page_id == _BLK.page_id
                  for e in effs)


def test_check_5_appends_under_todays_header():
    op = _op(base="what I saw before going offline")
    effs = plan_op(0, op, _text_ctx(op, "server text meanwhile",
                                    header=_EXISTING))
    inserts = [e for e in effs if isinstance(e, InsertBlock)]
    assert inserts == [InsertBlock(
        uid=BlockUid("uid_ch1"), page_id=PageId(9),
        parent_uid=BlockUid("uid_old"), order_idx=OrderIdx(3),
        text="server text meanwhile", heading=None)]
    assert any(isinstance(e, UpdateText) for e in effs)


def test_check_5_applies_the_replayed_edit_not_the_callers_text():
    t0, t1 = "note about [[Old]]", "note about [[New]] and more"
    op = UpdateTextOp(op="update_text", uid="uid_t1",
                      text="note about [[Old]] plus comment",
                      base_text_hash=text_hash(t0))
    ctx = TextConflictContext(_BLK, "note about [[New]] plus comment", t1,
                              "Machine Learning", _landing())
    effs = plan_op(0, op, ctx)
    assert effs[-3:] == (
        UpdateText(BlockUid("uid_t1"), "note about [[New]] plus comment"),
        ReindexRefs(BlockUid("uid_t1"), "note about [[New]] plus comment"),
        TouchPage(PageId(1)))


# --- classify_text_edit: the shared identical/clean/conflict predicate ----


def test_classify_text_edit_identical_without_rewrites():
    outcome = classify_text_edit("same", text_hash("anything else"),
                                 "same", ())
    assert outcome == TextEditOutcome("identical", "same")


def test_classify_text_edit_clean_without_rewrites():
    outcome = classify_text_edit("new text", text_hash("old text"),
                                 "old text", ())
    assert outcome == TextEditOutcome("clean", "new text")


def test_classify_text_edit_conflict_without_rewrites():
    outcome = classify_text_edit(
        "new text", text_hash("what I saw before going offline"),
        "server text meanwhile", ())
    assert outcome == TextEditOutcome("conflict", "new text")


def test_classify_text_edit_identical_with_rewrite_replay():
    # The rename replay is the only difference between the stale edit and
    # the live text: replaying it makes the edit identical, not a conflict.
    t0, t1 = "note about [[Old]]", "note about [[New]]"
    rewrites = (BlockRewrite(text_hash(t0), text_hash(t1), "Old", "New"),)
    outcome = classify_text_edit(t0, text_hash(t0), t1, rewrites)
    assert outcome == TextEditOutcome("identical", t1)


def test_classify_text_edit_clean_with_rewrite_replay():
    # A stale hash that would look like a conflict without replay (base
    # hashes the pre-rename text, live is what the rename produced) becomes
    # a clean apply once the same rename is replayed onto the offline edit:
    # a rewritten block whose replayed edit is clean.
    t0, t1 = "note about [[Old]]", "note about [[New]]"
    edit = "note about [[Old]] plus comment"
    rewrites = (BlockRewrite(text_hash(t0), text_hash(t1), "Old", "New"),)
    outcome = classify_text_edit(edit, text_hash(t0), t1, rewrites)
    assert outcome == TextEditOutcome("clean", "note about [[New]] plus comment")


def test_classify_text_edit_conflict_with_rewrite_replay():
    # Something else changed the block after the rename too: the replayed
    # edit neither matches the live text nor its post-rename hash, so it's
    # still a genuine conflict.
    t0, t1 = "note about [[Old]]", "note about [[New]]"
    live = "note about [[New]] and more edits"
    edit = "note about [[Old]] plus comment"
    rewrites = (BlockRewrite(text_hash(t0), text_hash(t1), "Old", "New"),)
    outcome = classify_text_edit(edit, text_hash(t0), live, rewrites)
    assert outcome == TextEditOutcome(
        "conflict", "note about [[New]] plus comment")


# --- ops on missing blocks -------------------------------------------------
#
# An op whose target block (or create/move parent) the server doesn't have
# never 400s: it is a no-op, lands a note/lost text in today's daily note,
# and journals the uids a client may hold a ghost of.

_MOVE = MoveOp(op="move", uid="ghost99", parent_uid=None, order_idx=0)
_HEADING = SetHeadingOp(op="set_heading", uid="ghost99", heading=1)
_VIEW = SetViewTypeOp(op="set_view_type", uid="ghost99", view_type="numbered")
_COLLAPSE = SetCollapsedOp(op="set_collapsed", uid="ghost99", collapsed=True)
_DELETE = DeleteOp(op="delete", uid="ghost99")
_ORPHAN_HEADER = ("[[conflict]] (page unknown) — edit to a block the server"
                  " no longer has")


def _create_under(parent_uid="ghost_p1", text="lost child", page_title="AI"):
    return CreateOp(op="create", uid="newuid1", page_title=page_title,
                    parent_uid=parent_uid, order_idx=0, text=text)


@pytest.mark.parametrize("op, block_exists, parent_exists, expected", [
    # targets present: ordinary planning
    (_MOVE, True, False, None),
    (_HEADING, True, False, None),
    (_COLLAPSE, True, False, None),
    (_DELETE, True, False, None),
    (UpdateTextOp(op="update_text", uid="ghost99", text="x"), True, False,
     None),
    (_create_under(parent_uid=None), False, False, None),
    (_create_under(), False, True, None),
    # a create whose uid exists is left to plan_op's "uid already exists"
    (_create_under(), True, False, None),
    (CreatePageOp(op="create_page", page_title="AI"), False, False, None),
    (MoveOp(op="move", uid="ghost99", parent_uid="uid_p", order_idx=0),
     True, True, None),
    # plain no-ops, nothing lands
    (_COLLAPSE, False, False, Skip("noop", None)),
    (_DELETE, False, False, Skip("noop", None)),
    # skipped with a note under the missing block's own uid
    (_MOVE, False, False, Skip("orphan_structural", BlockUid("ghost99"))),
    (MoveOp(op="move", uid="ghost99", parent_uid="ghost_p1", order_idx=0),
     False, False, Skip("orphan_structural", BlockUid("ghost99"))),
    (_HEADING, False, False, Skip("orphan_structural", BlockUid("ghost99"))),
    (_VIEW, False, False, Skip("orphan_structural", BlockUid("ghost99"))),
    # text edits, hashed or not, land their text under the block's uid
    (UpdateTextOp(op="update_text", uid="ghost99", text="x"), False, False,
     Skip("orphan_edit", BlockUid("ghost99"))),
    (UpdateTextOp(op="update_text", uid="ghost99", text="x",
                  base_text_hash=text_hash("y")), False, False,
     Skip("orphan_edit", BlockUid("ghost99"))),
    # ... unless blank: nothing lost, nothing lands (same as a blank create)
    (UpdateTextOp(op="update_text", uid="ghost99", text=" "), False, False,
     Skip("orphan_edit", None)),
    # a create under a missing parent lands under the PARENT's uid ...
    (_create_under(), False, False,
     Skip("diverted_create", BlockUid("ghost_p1"))),
    # ... unless it carries no text, which leaves nothing to land
    (_create_under(text="  "), False, False,
     Skip("diverted_create", None)),
    # the block exists but its move target doesn't
    (MoveOp(op="move", uid="uid_b3", parent_uid="ghost_p1", order_idx=0),
     True, False, Skip("move_parent_missing", BlockUid("uid_b3"))),
])
def test_classify_skip(op, block_exists, parent_exists, expected):
    assert classify_skip(op, block_exists, parent_exists) == expected


MISSING_TARGETS_FIXTURE = (
    Path(__file__).parents[2] / "shared" / "fixtures" / "missing_targets.json"
)
MISSING_TARGETS_CASES = json.loads(MISSING_TARGETS_FIXTURE.read_text())["cases"]
_BLOCK_OP_ADAPTER = TypeAdapter(BlockOp)


@pytest.mark.parametrize("case", MISSING_TARGETS_CASES,
                        ids=[c["name"] for c in MISSING_TARGETS_CASES])
def test_classify_skip_matches_shared_fixture(case):
    # Pins classify_skip against the same skip/no-skip table the
    # replica's TS mirror (web/src/replica/missingTarget.ts) is tested
    # against, so the two languages cannot drift apart.
    op = _BLOCK_OP_ADAPTER.validate_python(case["op"])
    skipped = classify_skip(
        op, case["block_exists"], case["parent_exists"],
        tuple(case.get("parent_chain", ()))) is not None
    assert skipped == case["skip"]


MISSING_TARGETS = json.loads(MISSING_TARGETS_FIXTURE.read_text())
PLACEMENT_STATE = MISSING_TARGETS["placement_state"]
PLACEMENT_CASES = MISSING_TARGETS["placement_cases"]


@pytest.mark.parametrize("case", PLACEMENT_CASES,
                        ids=[c["name"] for c in PLACEMENT_CASES])
def test_placement_matches_shared_fixture(case, tmp_path):
    # Where a create or move lands, applied through the real write path.
    # The replica's local apply (web/src/replica/localOps.ts) is pinned to
    # the same table, so an optimistic placement is what the feed confirms.
    # replica_only rows are the replica's own earlier apply of these ops
    # (a row for a shared uid is where that apply shifted it); the server
    # never received them, so it starts from the shared state.
    db_path = tmp_path / "placement.sqlite3"
    init_db(db_path)
    db = open_db(db_path)
    try:
        page_ids = {p["title"]: p["id"] for p in PLACEMENT_STATE["pages"]}
        db.executemany("INSERT INTO pages(id, title) VALUES (?, ?)",
                       [(i, t) for t, i in page_ids.items()])
        db.executemany(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
            " VALUES (?,?,?,?,?)",
            [(b["uid"], page_ids[b["page"]], b["parent_uid"], b["order_idx"],
              b["uid"]) for b in PLACEMENT_STATE["blocks"]])
        db.commit()
        apply_batch(db, OpBatch.model_validate({
            "client_id": "fixture", "batch_id": f"placement_{case['name']}"[:64],
            "ops": case["ops"]}), 1_800_000_000_000)
        db.commit()
        placed = {r["uid"]: {"uid": r["uid"], "page": r["title"],
                             "parent_uid": r["parent_uid"],
                             "order_idx": r["order_idx"]}
                  for r in db.execute(
                      "SELECT b.uid, p.title, b.parent_uid, b.order_idx"
                      " FROM blocks b JOIN pages p ON p.id = b.page_id")}
        assert [placed.get(e["uid"]) for e in case["expect"]] == case["expect"]
        for title in case["pages_absent"]:
            assert db.execute("SELECT 1 FROM pages WHERE title = ?",
                              (title,)).fetchone() is None
    finally:
        db.close()


def test_collapse_on_missing_block_only_journals_the_ghost():
    # the client just toggled a row the server doesn't have: the tombstone
    # this journal row ships drops it from the replica
    assert plan_op(0, _COLLAPSE, _skip_ctx(_COLLAPSE)) == (
        JournalBlock(BlockUid("ghost99"), deleted=True),)


def test_delete_of_missing_block_is_empty():
    # the client's own optimistic delete already removed its copy
    assert plan_op(0, _DELETE, _skip_ctx(_DELETE)) == ()


@pytest.mark.parametrize("op, note", [
    (_MOVE, "move skipped: block ghost99 not found"),
    (_HEADING, "heading change skipped: block ghost99 not found"),
    (_VIEW, "view type change skipped: block ghost99 not found"),
])
def test_skipped_op_on_missing_block_lands_a_note_under_the_orphan_header(
        op, note):
    effs = plan_op(0, op, _skip_ctx(op))
    # the tombstone leads: journal rows reach replicas in seq order, and a
    # window boundary must never put a ghost's tombstone after live rows
    assert effs == (
        JournalBlock(BlockUid("ghost99"), deleted=True),
        InsertBlock(uid=BlockUid("uid_hd1"), page_id=PageId(9),
                   parent_uid=None, order_idx=OrderIdx(4), text=_ORPHAN_HEADER,
                   heading=None),
        ReindexRefs(BlockUid("uid_hd1"), _ORPHAN_HEADER),
        InsertBlock(uid=BlockUid("uid_ch1"), page_id=PageId(9),
                   parent_uid=BlockUid("uid_hd1"), order_idx=OrderIdx(0), text=note,
                   heading=None),
        ReindexRefs(BlockUid("uid_ch1"), note),
        RecordConflictHeader(BlockUid("ghost99"), _DAY, BlockUid("uid_hd1")),
        TouchPage(PageId(9)),
    )


def test_skipped_op_appends_under_an_existing_header_for_the_block():
    effs = plan_op(0, _MOVE, _skip_ctx(
        _MOVE, header=ExistingHeader(BlockUid("uid_old"), OrderIdx(2))))
    assert [e for e in effs if isinstance(e, InsertBlock)] == [
        InsertBlock(uid=BlockUid("uid_ch1"), page_id=PageId(9),
                   parent_uid=BlockUid("uid_old"), order_idx=OrderIdx(2),
                   text="move skipped: block ghost99 not found",
                   heading=None)]


@pytest.mark.parametrize("op, reason", [
    (DeleteOp(op="delete", uid="bad uid!"), "block not found: bad uid!"),
    (SetCollapsedOp(op="set_collapsed", uid="x" * 40, collapsed=True),
     "block not found: " + "x" * 40),
    (UpdateTextOp(op="update_text", uid="a!", text="t"),
     "block not found: a!"),
    (MoveOp(op="move", uid="uid_b3", parent_uid="bad parent", order_idx=0),
     "parent not found: bad parent"),
    (CreateOp(op="create", uid="newuid1", page_title="P",
              parent_uid="bad parent", order_idx=0, text="t"),
     "parent not found: bad parent"),
])
def test_skipped_op_with_an_impossible_uid_still_400s(op, reason):
    # clients only mint UID_RE uids, so this never wedges a real queue; it
    # keeps unvalidated strings out of the journal and conflict_headers
    ctx = _skip_ctx(op, block_exists=isinstance(op, MoveOp))
    with pytest.raises(OpError) as e:
        plan_op(0, op, ctx)
    assert e.value.reason == reason


def test_blank_orphan_edit_only_journals():
    op = UpdateTextOp(op="update_text", uid="ghost99", text="")
    assert plan_op(0, op, _skip_ctx(op)) == (
        JournalBlock(BlockUid("ghost99"), True),)


def test_unhashed_edit_of_missing_block_lands_like_a_hashed_one():
    op = UpdateTextOp(op="update_text", uid="uid_t1", text="new text",
                      page_title="AI Agent Security")
    hashed_op = _op(page_title="AI Agent Security")
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=True))
    hashed = plan_op(0, hashed_op, _skip_ctx(hashed_op, hint_page_exists=True))
    assert effs == hashed
    assert effs[0] == JournalBlock(BlockUid("uid_t1"), deleted=True)
    assert [e.text for e in effs if isinstance(e, InsertBlock)] == [
        "[[conflict]] [[AI Agent Security]] — edit to a block the server"
        " no longer has", "new text"]


def test_create_under_missing_parent_lands_its_text_under_the_parent():
    op = _create_under()
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=True))
    header = ("[[conflict]] [[AI]] — edit to a block the server no longer"
              " has")
    assert effs == (
        JournalBlock(BlockUid("newuid1"), deleted=True),
        JournalBlock(BlockUid("ghost_p1"), deleted=True),
        InsertBlock(uid=BlockUid("uid_hd1"), page_id=PageId(9),
                   parent_uid=None, order_idx=OrderIdx(4), text=header, heading=None),
        ReindexRefs(BlockUid("uid_hd1"), header),
        InsertBlock(uid=BlockUid("uid_ch1"), page_id=PageId(9),
                   parent_uid=BlockUid("uid_hd1"), order_idx=OrderIdx(0),
                   text="lost child", heading=None),
        ReindexRefs(BlockUid("uid_ch1"), "lost child"),
        RecordConflictHeader(BlockUid("ghost_p1"), _DAY, BlockUid("uid_hd1")),
        TouchPage(PageId(9)),
    )


def test_create_under_missing_parent_names_a_missing_page_without_linking():
    op = _create_under(page_title="Gone Page")
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=False))
    header = next(e for e in effs if isinstance(e, InsertBlock)
                  and e.uid == "uid_hd1")
    assert header.text == ("[[conflict]] `Gone Page` (page not found) —"
                           " edit to a block the server no longer has")


def test_blank_create_under_missing_parent_only_journals():
    op = _create_under(text="")
    assert plan_op(0, op, _skip_ctx(op)) == (
        JournalBlock(BlockUid("newuid1"), deleted=True),
        JournalBlock(BlockUid("ghost_p1"), deleted=True))


def test_create_under_missing_parent_still_checks_its_uid():
    op = CreateOp(op="create", uid="a!", page_title="P",
                  parent_uid="ghost_p1", order_idx=0, text="t")
    with pytest.raises(OpError, match="invalid uid"):
        plan_op(0, op, _skip_ctx(op))


def test_create_under_missing_parent_rejects_a_parent_uid_with_a_trailing_newline():
    # impossible_uid_reason's parent_uid check (diverted_create skip kind)
    # has the same $-vs-trailing-newline hole as the uid check above.
    op = CreateOp(op="create", uid="newuid1", page_title="P",
                  parent_uid="ghost_p1\n", order_idx=0, text="t")
    with pytest.raises(OpError, match="parent not found"):
        plan_op(0, op, _skip_ctx(op))


def test_orphan_edit_rejects_a_uid_with_a_trailing_newline():
    # impossible_uid_reason's non-create uid check (orphan_edit skip kind):
    # a malformed uid must 400 rather than land a ghost journal/conflict
    # entry under an uid no surface can ever reference back.
    op = UpdateTextOp(op="update_text", uid="abcdef\n", text="t")
    with pytest.raises(OpError, match="block not found"):
        plan_op(0, op, _skip_ctx(op))


def test_move_to_missing_parent_leaves_the_block_and_notes_why():
    op = MoveOp(op="move", uid="uid_b3", parent_uid="ghost_p1", order_idx=0)
    effs = plan_op(0, op, _skip_ctx(
        op, block_exists=True,
        subtree=(BlockUid("uid_gc"), BlockUid("uid_c1"), BlockUid("uid_b3"))))
    header = "[[conflict]] [[Machine Learning]] — ((uid_b3))"
    note = "move skipped: target parent ghost_p1 not found"
    # A replica that applied the move holds the whole subtree under a ghost
    # of the parent; the parent's tombstone cascades all of it away there,
    # so it leads and every row of the subtree (root first) is re-shipped.
    assert effs == (
        JournalBlock(BlockUid("ghost_p1"), deleted=True),
        InsertBlock(uid=BlockUid("uid_hd1"), page_id=PageId(9),
                   parent_uid=None, order_idx=OrderIdx(4), text=header, heading=None),
        ReindexRefs(BlockUid("uid_hd1"), header),
        InsertBlock(uid=BlockUid("uid_ch1"), page_id=PageId(9),
                   parent_uid=BlockUid("uid_hd1"), order_idx=OrderIdx(0), text=note,
                   heading=None),
        ReindexRefs(BlockUid("uid_ch1"), note),
        RecordConflictHeader(BlockUid("uid_b3"), _DAY, BlockUid("uid_hd1")),
        TouchPage(PageId(9)),
        JournalBlock(BlockUid("uid_b3"), deleted=False),
        JournalBlock(BlockUid("uid_c1"), deleted=False),
        JournalBlock(BlockUid("uid_gc"), deleted=False),
    )


# --- a move that would make a cycle -----------------------------------------
#
# Two devices moved blocks under each other concurrently: the server applied
# the first, so the second would nest a block under its own descendant.

_CYCLE_MOVE = MoveOp(op="move", uid="uid_b2", parent_uid="uid_b3",
                     order_idx=0, page_title="Machine Learning")
_B2 = BlockInfo(BlockUid("uid_b2"), PageId(1), None)


@pytest.mark.parametrize("op, block_exists, parent_exists, chain, expected", [
    # the target parent's chain holds the moved block: a cycle
    (_CYCLE_MOVE, True, True, ("uid_b3", "uid_b2"),
     Skip("move_cycle", BlockUid("uid_b2"))),
    # a block moved under itself is the shortest cycle
    (MoveOp(op="move", uid="uid_b2", parent_uid="uid_b2", order_idx=0),
     True, True, ("uid_b2",), Skip("move_cycle", BlockUid("uid_b2"))),
    # a chain without the block plans normally
    (_CYCLE_MOVE, True, True, ("uid_b3", "uid_b1"), None),
    # a missing block or parent is the missing-target case, chain or not
    (_CYCLE_MOVE, False, True, ("uid_b3", "uid_b2"),
     Skip("orphan_structural", BlockUid("uid_b2"))),
    (_CYCLE_MOVE, True, False, ("uid_b3", "uid_b2"),
     Skip("move_parent_missing", BlockUid("uid_b2"))),
    # only a move's chain means anything
    (_create_under(parent_uid="uid_b3"), False, True, ("uid_b3", "newuid1"),
     None),
])
def test_classify_move_cycle(op, block_exists, parent_exists, chain,
                             expected):
    assert classify_skip(op, block_exists, parent_exists,
                                   chain) == expected


def _cycle_ctx(op: MoveOp = _CYCLE_MOVE,
               chain: tuple[str, ...] = ("uid_b3", "uid_b2"),
               header: ExistingHeader | None = None) -> SkippedContext:
    return _skip_ctx(op, block_exists=True, parent_exists=True, chain=chain,
                     header=header,
                     subtree=(BlockUid("uid_b3"), BlockUid("uid_b2")))


def test_move_that_would_make_a_cycle_leaves_the_block_and_notes_why():
    effs = plan_op(0, _CYCLE_MOVE, _cycle_ctx())
    header = "[[conflict]] [[Machine Learning]] — ((uid_b2))"
    note = "move skipped: would create a cycle"
    # A replica that applied the move holds uid_b2 under its own
    # descendant, a loop no page root reaches: every row of the moved
    # block's server subtree (root first) is re-shipped as it really is.
    # Nothing is gone, so nothing is tombstoned.
    assert effs == (
        InsertBlock(uid=BlockUid("uid_hd1"), page_id=PageId(9),
                   parent_uid=None, order_idx=OrderIdx(4), text=header, heading=None),
        ReindexRefs(BlockUid("uid_hd1"), header),
        InsertBlock(uid=BlockUid("uid_ch1"), page_id=PageId(9),
                   parent_uid=BlockUid("uid_hd1"), order_idx=OrderIdx(0), text=note,
                   heading=None),
        ReindexRefs(BlockUid("uid_ch1"), note),
        RecordConflictHeader(BlockUid("uid_b2"), _DAY, BlockUid("uid_hd1")),
        TouchPage(PageId(9)),
        JournalBlock(BlockUid("uid_b2"), deleted=False),
        JournalBlock(BlockUid("uid_b3"), deleted=False),
    )


def test_move_under_itself_is_skipped_like_any_cycle():
    op = MoveOp(op="move", uid="uid_b2", parent_uid="uid_b2", order_idx=0)
    effs = plan_op(0, op, _cycle_ctx(op, chain=("uid_b2",)))
    assert [e.text for e in effs if isinstance(e, InsertBlock)] == [
        "[[conflict]] [[Machine Learning]] — ((uid_b2))",
        "move skipped: would create a cycle"]


def test_cycle_note_appends_under_an_existing_header_for_the_block():
    effs = plan_op(0, _CYCLE_MOVE, _cycle_ctx(
        header=ExistingHeader(BlockUid("uid_old"), OrderIdx(2))))
    assert [e for e in effs if isinstance(e, InsertBlock)] == [
        InsertBlock(uid=BlockUid("uid_ch1"), page_id=PageId(9),
                   parent_uid=BlockUid("uid_old"), order_idx=OrderIdx(2),
                   text="move skipped: would create a cycle",
                   heading=None)]


@pytest.mark.parametrize("op, ctx, expected", [
    (_MOVE, _skip_ctx(_MOVE),
     {"index": 3, "op": "move", "uid": "ghost99", "reason": "block_not_found",
      "note_page": _DAY}),
    (_DELETE, _skip_ctx(_DELETE),
     {"index": 3, "op": "delete", "uid": "ghost99",
      "reason": "block_not_found", "note_page": None}),
    (_create_under(), _skip_ctx(_create_under()),
     {"index": 3, "op": "create", "uid": "newuid1",
      "reason": "parent_not_found", "note_page": _DAY}),
    (_create_under(text=""), _skip_ctx(_create_under(text="")),
     {"index": 3, "op": "create", "uid": "newuid1",
      "reason": "parent_not_found", "note_page": None}),
    (MoveOp(op="move", uid="uid_b3", parent_uid="ghost_p1", order_idx=0),
     _skip_ctx(MoveOp(op="move", uid="uid_b3", parent_uid="ghost_p1",
                      order_idx=0), block_exists=True),
     {"index": 3, "op": "move", "uid": "uid_b3",
      "reason": "parent_not_found", "note_page": _DAY}),
    (_CYCLE_MOVE, _cycle_ctx(),
     {"index": 3, "op": "move", "uid": "uid_b2", "reason": "cycle",
      "note_page": _DAY}),
])
def test_skip_report_names_the_op_and_where_its_note_landed(op, ctx,
                                                            expected):
    assert skip_report(3, op, ctx) == expected
