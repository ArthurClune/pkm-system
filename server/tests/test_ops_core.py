import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from rawread import read
from pkm.contracts.ops import (BlockOp, BlockUid, CreateOp, CreatePageOp,
                               DeleteOp, MoveOp, OpBatch, PageId, SetCollapsedOp,
                               SetHeadingOp,
                               SetViewTypeOp, UpdateTextOp, subtree_hash,
                               text_hash)
from pkm.contracts.titles import CanonicalTitle, RawTitle
from pkm.refs import normalize_title
from pkm.server.conflict_notes import (deleted_header_text,
                                       live_block_header_text,
                                       orphan_header_text,
                                       stale_page_move_note)
from pkm.server.db import init_db, open_db
from pkm.server.ops_apply import apply_batch
from pkm.server.ops_core import (BlockContext, BlockInfo, BlockRewrite,
                                 ConflictLanding, CreateContext, DeleteBlocks,
                                 DeleteConflictContext, DeleteContext,
                                 ExistingHeader, FreshHeader, InsertBlock,
                                 JournalBlock, LandedSkipContext, MoveContext,
                                 OpError, PageContext, RecordConflictHeader,
                                 RecordRewrite,
                                 ReindexRefs, SetCollapsed, SetHeading,
                                 SetPageId, SetParent, SetViewType,
                                 ShiftSiblings, Skip, SkipContext,
                                 SkippedContext, StuckMoveContext,
                                 SubtreeRow, TextConflictContext,
                                 TextEditContext, TextEditOutcome, TouchPage,
                                 UpdateText, classify_skip,
                                 classify_text_edit, conflict_entry_effects,
                                 descendant_copy_effects, delete_diverged,
                                 replay_title_rewrites,
                                 plan_op, skip_report, rewrite_effects,
                                 unlink_stale_text)
from pkm.server.ops_core import MAX_REPLAYED_REWRITES
from pkm.unlink import unlink_stale_refs
from pkm.test_data.ids import (
    batch_id_of, canonical_title_of, client_id_of, malformed_uid, order_idx_of, page_id_of,
    raw_title_of, sha_of, uid_of)

B = BlockInfo(uid=uid_of("uid_b3"), page_id=page_id_of(1),
             parent_uid=uid_of("uid_b2"))
_DAY = canonical_title_of("September 28th, 2026")
# today's header for the target already exists: entries append under it
_EXISTING = ExistingHeader(uid_of("uid_old"), order_idx_of(3))


def _landing(header: ExistingHeader | FreshHeader | None = None
             ) -> ConflictLanding:
    """Today's daily page 9; a fresh header uid_hd1 at slot 4 unless one
    exists already; the entry is uid_ch1."""
    return ConflictLanding(page_id_of(9), _DAY, uid_of("uid_ch1"),
                           header if header is not None
                           else FreshHeader(uid_of("uid_hd1"), order_idx_of(4)))


def _skip_ctx(op: BlockOp, *, block_exists: bool = False,
              parent_exists: bool = False, chain: tuple[str, ...] = (),
              header: ExistingHeader | None = None,
              hint_page_exists: bool = False,
              page_title: CanonicalTitle = canonical_title_of(
                  "Machine Learning"),
              subtree: tuple[BlockUid, ...] = (uid_of("uid_b3"),),
              page_stale: bool = False
              ) -> SkippedContext:
    """The context ops_apply._context_for builds for an op classify_skip
    flags, with the given reads."""
    skip = classify_skip(op, block_exists, parent_exists, chain,
                         page_stale=page_stale)
    assert skip is not None
    if skip.landing_uid is None:
        return SkipContext(skip)
    if (skip.kind in ("move_parent_missing", "move_cycle")
            or (skip.kind == "stale_page" and isinstance(op, MoveOp))):
        return StuckMoveContext(skip, _landing(header), page_title, subtree)
    return LandedSkipContext(skip, _landing(header), hint_page_exists)


def test_batch_parses_discriminated_ops():
    batch = OpBatch.model_validate_json(
        '{"client_id": "c1", "batch_id": "test_batch1", "ops": ['
        '{"op": "create", "uid": "newuid1", "page_title": "P",'
        ' "order_idx": 0, "text": "hi"},'
        '{"op": "delete", "uid": "uid_b3"}]}')
    assert isinstance(batch.ops[0], CreateOp)
    assert isinstance(batch.ops[1], DeleteOp)


def test_batch_rejects_unknown_op_and_empty():
    with pytest.raises(ValidationError):
        OpBatch.model_validate_json(
            '{"client_id": "c1", "batch_id": "test_batch2",'
            ' "ops": [{"op": "explode", "uid": "uid_b3"}]}')
    with pytest.raises(ValidationError):
        OpBatch(client_id=client_id_of("c1"), batch_id=batch_id_of("test_batch3"), ops=[])


def test_plan_create():
    op = CreateOp(op="create", uid=uid_of("newuid1"), page_title=raw_title_of("P"),
                  parent_uid=uid_of("uid_b2"), order_idx=order_idx_of(1), text="t [[X]]",
                  view_type="numbered")
    effects = plan_op(0, op, CreateContext(uid_taken=False,
                                           page_id=page_id_of(1)))
    assert effects == (
        ShiftSiblings(page_id_of(1), uid_of("uid_b2"), order_idx_of(1)),
        InsertBlock(uid=uid_of("newuid1"), page_id=page_id_of(1),
                   parent_uid=uid_of("uid_b2"), order_idx=order_idx_of(1),
                   text="t [[X]]", heading=None, view_type="numbered"),
        ReindexRefs(uid_of("newuid1"), "t [[X]]"),
        TouchPage(page_id_of(1)),
    )


def test_plan_create_rejects_bad_uid_and_dup():
    with pytest.raises(OpError, match="invalid uid"):
        plan_op(0, CreateOp(op="create", uid=malformed_uid("a!"), page_title=raw_title_of("P"),
                            order_idx=order_idx_of(0), text=""),
                CreateContext(uid_taken=False, page_id=page_id_of(1)))
    with pytest.raises(OpError, match="already exists"):
        plan_op(0, CreateOp(op="create", uid=uid_of("uid_b3"), page_title=raw_title_of("P"),
                            order_idx=order_idx_of(0), text=""),
                CreateContext(uid_taken=True, page_id=page_id_of(1)))


def test_plan_create_rejects_a_uid_with_a_trailing_newline():
    # UID_RE's $ matches just before a trailing "\n" under re.match, so
    # "abcdef\n" used to pass here -- a block no ((ref)) can ever name and
    # every uid-addressed route 422s.
    with pytest.raises(OpError, match="invalid uid"):
        plan_op(0, CreateOp(op="create", uid=malformed_uid("abcdef\n"), page_title=raw_title_of("P"),
                            order_idx=order_idx_of(0), text=""),
                CreateContext(uid_taken=False, page_id=page_id_of(1)))


def test_plan_create_page_executes_nothing():
    # context assembly already resolved (and created) the page
    assert plan_op(0, CreatePageOp(op="create_page", page_title=raw_title_of("AI")),
                   PageContext(page_id_of(2))) == ()


def test_plan_update_text():
    effects = plan_op(0, UpdateTextOp(op="update_text", uid=uid_of("uid_b3"),
                                      text="new"), BlockContext(B))
    assert effects == (UpdateText(uid_of("uid_b3"), "new"),
                       ReindexRefs(uid_of("uid_b3"), "new"),
                       TouchPage(page_id_of(1)))


def test_plan_move():
    ctx = MoveContext(B, BlockInfo(uid_of("uid_b1"), page_id_of(1), None),
                      None, (uid_of("uid_b3"),))
    assert plan_op(0, MoveOp(op="move", uid=uid_of("uid_b3"), parent_uid=uid_of("uid_b1"),
                             order_idx=order_idx_of(0)), ctx) == (
        ShiftSiblings(page_id_of(1), uid_of("uid_b1"), order_idx_of(0)),
        SetParent(uid_of("uid_b3"), uid_of("uid_b1"), order_idx_of(0)),
        TouchPage(page_id_of(1)))
    # to top level
    assert plan_op(0, MoveOp(op="move", uid=uid_of("uid_b3"), parent_uid=None,
                             order_idx=order_idx_of(2)),
                   MoveContext(B, None, None, (uid_of("uid_b3"),))) == (
        ShiftSiblings(page_id_of(1), None, order_idx_of(2)),
        SetParent(uid_of("uid_b3"), None, order_idx_of(2)), TouchPage(page_id_of(1)))


def test_plan_delete_and_collapse():
    assert plan_op(0, DeleteOp(op="delete", uid=uid_of("uid_b2")),
                   DeleteContext(
                       BlockInfo(uid_of("uid_b2"), page_id_of(1), None),
                       (uid_of("uid_b3"), uid_of("uid_b2")))) == (
        DeleteBlocks((uid_of("uid_b3"), uid_of("uid_b2"))),
        TouchPage(page_id_of(1)))
    # collapse/expand is not a real change -- no TouchPage, unlike every
    # other op planned here.
    assert plan_op(0, SetCollapsedOp(op="set_collapsed", uid=uid_of("uid_b2"),
                                     collapsed=True),
                   BlockContext(
                       BlockInfo(uid_of("uid_b2"), page_id_of(1), None))
                   ) == (SetCollapsed(uid_of("uid_b2"), True),)


# --- diverged delete: the subtree changed since the deleting device last
# saw it, so the delete still wins but the server's texts land first -------

# root tuid-r has children tuid-c2 (order_idx 5) and tuid-c1 (order_idx 2);
# tuid-c1 has child tuid-g
# (order_idx 0). Deepest first: g, then c1/c2, then r.
_ROOT = SubtreeRow(uid_of("tuid-r"), None, order_idx_of(0), "root text")
_C1 = SubtreeRow(uid_of("tuid-c1"), uid_of("tuid-r"), order_idx_of(2), "c1 text")
_C2 = SubtreeRow(uid_of("tuid-c2"), uid_of("tuid-r"), order_idx_of(5), "c2 text")
_G = SubtreeRow(uid_of("tuid-g"), uid_of("tuid-c1"), order_idx_of(0), "g text")
_SUBTREE_ROWS = (_G, _C1, _C2, _ROOT)


def test_delete_diverged_compares_the_subtree_hash():
    base = subtree_hash((row.uid, row.text) for row in _SUBTREE_ROWS)
    assert delete_diverged(base, _SUBTREE_ROWS) is False
    changed = (_G, _C1, _C2,
              SubtreeRow(uid_of("tuid-r"), None, order_idx_of(0), "edited elsewhere"))
    assert delete_diverged(base, changed) is True


def test_descendant_copies_nest_and_renumber():
    copy_uids = {uid_of("tuid-c1"): uid_of("copy_c1"),
                uid_of("tuid-c2"): uid_of("copy_c2"),
                uid_of("tuid-g"): uid_of("copy_g")}
    effects = descendant_copy_effects(_SUBTREE_ROWS, uid_of("tuid-r"),
                                      uid_of("copy_r"), copy_uids,
                                      daily_page_id=page_id_of(9))
    assert effects == (
        InsertBlock(uid=uid_of("copy_c1"), page_id=page_id_of(9),
                   parent_uid=uid_of("copy_r"), order_idx=order_idx_of(0),
                   text="c1 text", heading=None),
        ReindexRefs(uid_of("copy_c1"), "c1 text"),
        InsertBlock(uid=uid_of("copy_g"), page_id=page_id_of(9),
                   parent_uid=uid_of("copy_c1"), order_idx=order_idx_of(0),
                   text="g text", heading=None),
        ReindexRefs(uid_of("copy_g"), "g text"),
        InsertBlock(uid=uid_of("copy_c2"), page_id=page_id_of(9),
                   parent_uid=uid_of("copy_r"), order_idx=order_idx_of(1),
                   text="c2 text", heading=None),
        ReindexRefs(uid_of("copy_c2"), "c2 text"),
    )


def test_descendant_copies_keep_blank_texts():
    rows = (SubtreeRow(uid_of("tuid-c1"), uid_of("tuid-r"), order_idx_of(0), ""),
            SubtreeRow(uid_of("tuid-r"), None, order_idx_of(0), "root"))
    effects = descendant_copy_effects(
        rows, uid_of("tuid-r"), uid_of("copy_r"),
        {uid_of("tuid-c1"): uid_of("copy_c1")}, daily_page_id=page_id_of(9))
    assert effects == (
        InsertBlock(uid=uid_of("copy_c1"), page_id=page_id_of(9),
                   parent_uid=uid_of("copy_r"), order_idx=order_idx_of(0),
                   text="", heading=None),
        ReindexRefs(uid_of("copy_c1"), ""),
    )


def test_descendant_copies_never_walk_back_into_the_root():
    # a corrupted tree can give the root a parent inside its own subtree;
    # the root is where the walk starts, never one of its descendants
    rows = (SubtreeRow(uid_of("tuid-c1"), uid_of("tuid-r"), order_idx_of(0), "c1 text"),
            SubtreeRow(uid_of("tuid-r"), uid_of("tuid-c1"), order_idx_of(0), "root"))
    effects = descendant_copy_effects(
        rows, uid_of("tuid-r"), uid_of("copy_r"),
        {uid_of("tuid-c1"): uid_of("copy_c1")}, daily_page_id=page_id_of(9))
    assert effects == (
        InsertBlock(uid=uid_of("copy_c1"), page_id=page_id_of(9),
                   parent_uid=uid_of("copy_r"), order_idx=order_idx_of(0),
                   text="c1 text", heading=None),
        ReindexRefs(uid_of("copy_c1"), "c1 text"),
    )


def test_plan_diverged_delete_lands_copies_then_deletes():
    copy_uids = {uid_of("tuid-c1"): uid_of("copy_c1"),
                uid_of("tuid-c2"): uid_of("copy_c2"),
                uid_of("tuid-g"): uid_of("copy_g")}
    landing = _landing()  # FreshHeader, entry_uid "uid_ch1"
    ctx = DeleteConflictContext(
        BlockInfo(uid_of("tuid-r"), page_id_of(1), None), _SUBTREE_ROWS,
        canonical_title_of("Project X"), landing, copy_uids)
    op = DeleteOp(op="delete", uid=uid_of("tuid-r"),
                 base_subtree_hash=sha_of("a" * 64))
    assert plan_op(0, op, ctx) == (
        *conflict_entry_effects(uid_of("tuid-r"), _ROOT.text,
                                deleted_header_text(canonical_title_of("Project X")), landing),
        *descendant_copy_effects(_SUBTREE_ROWS, uid_of("tuid-r"),
                                 landing.entry_uid, copy_uids,
                                 landing.daily_page_id),
        DeleteBlocks(tuple(row.uid for row in _SUBTREE_ROWS)),
        TouchPage(page_id_of(1)),
    )


def test_plan_set_heading():
    assert plan_op(0, SetHeadingOp(op="set_heading", uid=uid_of("uid_b2"), heading=2),
                   BlockContext(
                       BlockInfo(uid_of("uid_b2"), page_id_of(1), None))
                   ) == (SetHeading(uid_of("uid_b2"), 2),
                         TouchPage(page_id_of(1)))
    # clearing back to plain text
    assert plan_op(0, SetHeadingOp(op="set_heading", uid=uid_of("uid_b2"), heading=None),
                   BlockContext(
                       BlockInfo(uid_of("uid_b2"), page_id_of(1), None))
                   ) == (SetHeading(uid_of("uid_b2"), None),
                         TouchPage(page_id_of(1)))


def test_set_heading_op_rejects_out_of_range():
    # out of range on purpose: asserting ValidationError
    with pytest.raises(ValidationError):
        SetHeadingOp(op="set_heading", uid=uid_of("uid_b2"), heading=5)  # pyrefly: ignore[bad-argument-type]
    with pytest.raises(ValidationError):
        SetHeadingOp(op="set_heading", uid=uid_of("uid_b2"), heading=0)  # pyrefly: ignore[bad-argument-type]


def test_plan_set_view_type_and_reject_unknown_value():
    assert plan_op(
        0, SetViewTypeOp(op="set_view_type", uid=uid_of("uid_b2"),
                         view_type="numbered"),
        BlockContext(BlockInfo(uid_of("uid_b2"), page_id_of(1), None)),
    ) == (SetViewType(uid_of("uid_b2"), "numbered"), TouchPage(page_id_of(1)))
    assert plan_op(
        0, SetViewTypeOp(op="set_view_type", uid=uid_of("uid_b2"),
                         view_type="document"),
        BlockContext(BlockInfo(uid_of("uid_b2"), page_id_of(1), None)),
    ) == (SetViewType(uid_of("uid_b2"), "document"), TouchPage(page_id_of(1)))
    # invalid on purpose: asserting ValidationError
    with pytest.raises(ValidationError):
        SetViewTypeOp(op="set_view_type", uid=uid_of("uid_b2"), view_type="table")  # pyrefly: ignore[bad-argument-type]


def test_op_error_carries_index():
    with pytest.raises(OpError) as e:
        plan_op(7, CreateOp(op="create", uid=malformed_uid("a!"), page_title=raw_title_of("P"),
                            order_idx=order_idx_of(0), text=""),
                CreateContext(uid_taken=False, page_id=page_id_of(1)))
    assert e.value.index == 7 and "invalid uid" in e.value.reason


def test_a_context_that_does_not_fit_the_op_is_a_programmer_error_not_a_400():
    # A 400 would poison the client's queue over a shell bug the client did
    # not cause; an AssertionError is a 500, which clients retry.
    move = MoveOp(op="move", uid=uid_of("uid_b3"), parent_uid=None, order_idx=order_idx_of(0))
    with pytest.raises(AssertionError):
        plan_op(0, move, DeleteContext(B, (uid_of("uid_b3"),)))
    edit = UpdateTextOp(op="update_text", uid=uid_of("uid_b3"), text="x",
                        base_text_hash=text_hash("y"))
    with pytest.raises(AssertionError):
        plan_op(0, edit, TextEditContext(
            B, TextEditOutcome("conflict", "x")))


def test_a_skip_context_that_does_not_fit_its_skip_kind_is_a_programmer_error():
    # Planned silently, these would drop a skip's note, or tombstone a live
    # block and cascade its subtree away on a replica.
    heading = SetHeadingOp(op="set_heading", uid=uid_of("ghost1"), heading=1)
    with pytest.raises(AssertionError):
        plan_op(0, heading, SkipContext(
            Skip("orphan_structural", uid_of("ghost1"))))
    move = MoveOp(op="move", uid=uid_of("uid_b3"), parent_uid=uid_of("ghost_p1"), order_idx=order_idx_of(0))
    with pytest.raises(AssertionError):
        plan_op(0, move, LandedSkipContext(
            Skip("move_parent_missing", uid_of("uid_b3")), _landing(),
            False))
    with pytest.raises(AssertionError):
        plan_op(0, heading, StuckMoveContext(
            Skip("orphan_structural", uid_of("ghost1")), _landing(),
            canonical_title_of("Machine Learning"), (uid_of("ghost1"),)))


def _move_ctx(block_page: int = 1, parent_page: int = 1,
             page_id: PageId | None = None):
    return MoveContext(
        BlockInfo(uid_of("u_child"), page_id_of(block_page), None),
        BlockInfo(uid_of("u_parent"), page_id_of(parent_page), None),
        page_id,
        (uid_of("tuid-u_gc"), uid_of("u_child")))


def test_move_cross_page_under_parent_reassigns_subtree():
    op = MoveOp(op="move", uid=uid_of("u_child"), parent_uid=uid_of("u_parent"), order_idx=order_idx_of(0))
    effects = plan_op(0, op, _move_ctx(block_page=1, parent_page=2))
    assert effects == (
        ShiftSiblings(page_id_of(2), uid_of("u_parent"), order_idx_of(0)),
        SetParent(uid_of("u_child"), uid_of("u_parent"), order_idx_of(0)),
        SetPageId((uid_of("tuid-u_gc"), uid_of("u_child")), page_id_of(2)),
        TouchPage(page_id_of(1)),
        TouchPage(page_id_of(2)))


def test_move_top_level_to_named_page():
    op = MoveOp(op="move", uid=uid_of("u_child"), parent_uid=None, order_idx=order_idx_of(0),
                page_title=raw_title_of("July 1st, 2026"))
    ctx = MoveContext(
        BlockInfo(uid_of("u_child"), page_id_of(1), uid_of("tuid-u_old")),
        None, page_id_of(7), (uid_of("u_child"),))
    effects = plan_op(0, op, ctx)
    assert effects == (
        ShiftSiblings(page_id_of(7), None, order_idx_of(0)),
        SetParent(uid_of("u_child"), None, order_idx_of(0)),
        SetPageId((uid_of("u_child"),), page_id_of(7)),
        TouchPage(page_id_of(1)),
        TouchPage(page_id_of(7)))


def test_move_same_page_unchanged_shape():
    # no page_title, same page: exactly the pre-existing three effects
    op = MoveOp(op="move", uid=uid_of("u_child"), parent_uid=uid_of("u_parent"), order_idx=order_idx_of(3))
    effects = plan_op(0, op, _move_ctx(block_page=1, parent_page=1))
    assert effects == (
        ShiftSiblings(page_id_of(1), uid_of("u_parent"), order_idx_of(3)),
        SetParent(uid_of("u_child"), uid_of("u_parent"), order_idx_of(3)),
        TouchPage(page_id_of(1)))


@pytest.mark.parametrize("page_id", [page_id_of(3), None])
def test_move_follows_its_parent_whatever_page_title_says(
        page_id: PageId | None):
    # page_title named the parent's page when the move was queued; another
    # device has since moved the parent to page 2. The block follows the
    # parent, and the shell no longer resolves the stale title.
    op = MoveOp(op="move", uid=uid_of("u_child"), parent_uid=uid_of("u_parent"), order_idx=order_idx_of(0),
                page_title=raw_title_of("Somewhere Else"))
    assert plan_op(0, op, _move_ctx(parent_page=2, page_id=page_id)) == (
        ShiftSiblings(page_id_of(2), uid_of("u_parent"), order_idx_of(0)),
        SetParent(uid_of("u_child"), uid_of("u_parent"), order_idx_of(0)),
        SetPageId((uid_of("tuid-u_gc"), uid_of("u_child")), page_id_of(2)),
        TouchPage(page_id_of(1)),
        TouchPage(page_id_of(2)))


_BLK = BlockInfo(uid_of("uid_t1"), page_id=page_id_of(1), parent_uid=None)


def _op(text="new text", base="old text", hint: str | None = None):
    return UpdateTextOp(op="update_text", uid=uid_of("uid_t1"), text=text,
                        base_text_hash=text_hash(base),
                        page_title=None if hint is None else raw_title_of(hint))


def _text_ctx(op: UpdateTextOp, current: str,
              header: ExistingHeader | None = None,
              page_title: CanonicalTitle = canonical_title_of(
                  "Machine Learning"),
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
    op = _op(hint="AI Agent Security")
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
    assert record == RecordConflictHeader(uid_of("uid_t1"), _DAY,
                                          uid_of("uid_hd1"))


@pytest.mark.parametrize("hint", [None, "  ", "a[[b"])
def test_missing_block_without_usable_hint_says_page_unknown(hint):
    # hint_page_exists is irrelevant here -- an unusable hint always falls
    # back to the generic label regardless.
    op = _op(hint=hint)
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=True))
    header = next(e for e in effs if isinstance(e, InsertBlock)
                  and e.uid == "uid_hd1")
    assert header.text == ("[[conflict]] (page unknown) — edit to a block "
                           "the server no longer has")


def test_missing_block_hint_names_a_renamed_away_page_says_not_found():
    # usable hint, but hint_page_exists is False: the page it names is gone
    # -- renamed or deleted since the client last saw it -- so the header
    # must not link it (that would recreate the page).
    op = _op(hint="Old Title")
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=False))
    header = next(e for e in effs if isinstance(e, InsertBlock)
                  and e.uid == "uid_hd1")
    assert header.text == ("[[conflict]] `Old Title` (page not found) — "
                           "edit to a block the server no longer has")


def test_missing_block_hint_with_backtick_and_no_page_says_page_unknown():
    # usable hint, no such page, but the title itself holds a backtick: an
    # inline-code span can't safely wrap it, so this also falls back to the
    # generic label rather than emitting a broken/misleading code span.
    op = _op(hint="a`b")
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=False))
    header = next(e for e in effs if isinstance(e, InsertBlock)
                  and e.uid == "uid_hd1")
    assert header.text == ("[[conflict]] (page unknown) — edit to a block "
                           "the server no longer has")


def test_missing_block_appends_under_todays_header():
    op = _op(hint="AI Agent Security")
    effs = plan_op(0, op, _skip_ctx(op, header=_EXISTING))
    inserts = [e for e in effs if isinstance(e, InsertBlock)]
    assert inserts == [InsertBlock(
        uid=uid_of("uid_ch1"), page_id=page_id_of(9),
        parent_uid=uid_of("uid_old"), order_idx=order_idx_of(3), text="new text",
        heading=None)]
    assert not any(isinstance(e, RecordConflictHeader) for e in effs)


def test_check_2_identical_text_is_noop_even_with_stale_hash():
    # device 2 pushes the same text device 1 already synced: base hash is stale
    # but the content matches -- never a conflict (offline-editing-design.md §2)
    op = _op(text="same", base="anything else")
    assert plan_op(0, op, _text_ctx(op, "same")) == ()


def test_check_3_absent_hash_applies_as_today():
    op = UpdateTextOp(op="update_text", uid=uid_of("uid_t1"), text="new")
    effs = plan_op(0, op, BlockContext(_BLK))
    assert any(isinstance(e, UpdateText) for e in effs)
    assert not any(isinstance(e, InsertBlock) for e in effs)


def test_check_4_matching_hash_applies_without_conflict():
    op = _op()
    assert plan_op(0, op, _text_ctx(op, "old text")) == (
        UpdateText(uid_of("uid_t1"), "new text"),
        ReindexRefs(uid_of("uid_t1"), "new text"), TouchPage(page_id_of(1)))


def test_check_5_incoming_wins_and_loser_goes_to_daily_header():
    op = _op(base="what I saw before going offline")
    effs = plan_op(0, op, _text_ctx(op, "server text meanwhile"))
    upd = next(e for e in effs if isinstance(e, UpdateText))
    assert upd == UpdateText(uid_of("uid_t1"), "new text")  # incoming wins (LWW)
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
        uid=uid_of("uid_ch1"), page_id=page_id_of(9),
        parent_uid=uid_of("uid_old"), order_idx=order_idx_of(3),
        text="server text meanwhile", heading=None)]
    assert any(isinstance(e, UpdateText) for e in effs)


def test_check_5_applies_the_replayed_edit_not_the_callers_text():
    t0, t1 = "note about [[Old]]", "note about [[New]] and more"
    op = UpdateTextOp(op="update_text", uid=uid_of("uid_t1"),
                      text="note about [[Old]] plus comment",
                      base_text_hash=text_hash(t0))
    ctx = TextConflictContext(_BLK, "note about [[New]] plus comment", t1,
                              canonical_title_of("Machine Learning"),
                              _landing())
    effs = plan_op(0, op, ctx)
    assert effs[-3:] == (
        UpdateText(uid_of("uid_t1"), "note about [[New]] plus comment"),
        ReindexRefs(uid_of("uid_t1"), "note about [[New]] plus comment"),
        TouchPage(page_id_of(1)))


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

_MOVE = MoveOp(op="move", uid=uid_of("ghost99"), parent_uid=None, order_idx=order_idx_of(0))
_HEADING = SetHeadingOp(op="set_heading", uid=uid_of("ghost99"), heading=1)
_VIEW = SetViewTypeOp(op="set_view_type", uid=uid_of("ghost99"), view_type="numbered")
_COLLAPSE = SetCollapsedOp(op="set_collapsed", uid=uid_of("ghost99"), collapsed=True)
_DELETE = DeleteOp(op="delete", uid=uid_of("ghost99"))
_ORPHAN_HEADER = ("[[conflict]] (page unknown) — edit to a block the server"
                  " no longer has")


def _create_under(parent_uid: BlockUid | None = uid_of("ghost_p1"), text="lost child",
                  page_title: RawTitle = raw_title_of("AI")):
    return CreateOp(op="create", uid=uid_of("newuid1"), page_title=page_title,
                    parent_uid=parent_uid, order_idx=order_idx_of(0), text=text)


@pytest.mark.parametrize("op, block_exists, parent_exists, expected", [
    # targets present: ordinary planning
    (_MOVE, True, False, None),
    (_HEADING, True, False, None),
    (_COLLAPSE, True, False, None),
    (_DELETE, True, False, None),
    (UpdateTextOp(op="update_text", uid=uid_of("ghost99"), text="x"), True, False,
     None),
    (_create_under(parent_uid=None), False, False, None),
    (_create_under(), False, True, None),
    # a create whose uid exists is left to plan_op's "uid already exists"
    (_create_under(), True, False, None),
    (CreatePageOp(op="create_page", page_title=raw_title_of("AI")), False, False, None),
    (MoveOp(op="move", uid=uid_of("ghost99"), parent_uid=malformed_uid("uid_p"), order_idx=order_idx_of(0)),
     True, True, None),
    # plain no-ops, nothing lands
    (_COLLAPSE, False, False, Skip("noop", None)),
    (_DELETE, False, False, Skip("noop", None)),
    # skipped with a note under the missing block's own uid
    (_MOVE, False, False, Skip("orphan_structural", uid_of("ghost99"))),
    (MoveOp(op="move", uid=uid_of("ghost99"), parent_uid=uid_of("ghost_p1"), order_idx=order_idx_of(0)),
     False, False, Skip("orphan_structural", uid_of("ghost99"))),
    (_HEADING, False, False, Skip("orphan_structural", uid_of("ghost99"))),
    (_VIEW, False, False, Skip("orphan_structural", uid_of("ghost99"))),
    # text edits, hashed or not, land their text under the block's uid
    (UpdateTextOp(op="update_text", uid=uid_of("ghost99"), text="x"), False, False,
     Skip("orphan_edit", uid_of("ghost99"))),
    (UpdateTextOp(op="update_text", uid=uid_of("ghost99"), text="x",
                  base_text_hash=text_hash("y")), False, False,
     Skip("orphan_edit", uid_of("ghost99"))),
    # ... unless blank: nothing lost, nothing lands (same as a blank create)
    (UpdateTextOp(op="update_text", uid=uid_of("ghost99"), text=" "), False, False,
     Skip("orphan_edit", None)),
    # a create under a missing parent lands under the PARENT's uid ...
    (_create_under(), False, False,
     Skip("diverted_create", uid_of("ghost_p1"))),
    # ... unless it carries no text, which leaves nothing to land
    (_create_under(text="  "), False, False,
     Skip("diverted_create", None)),
    # the block exists but its move target doesn't
    (MoveOp(op="move", uid=uid_of("uid_b3"), parent_uid=uid_of("ghost_p1"), order_idx=order_idx_of(0)),
     True, False, Skip("move_parent_missing", uid_of("uid_b3"))),
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
        # The shared fixture is decoded JSON: each op is validated as wire
        # input, then the batch is built from the checked ops.
        ops = [TypeAdapter(BlockOp).validate_python(op) for op in case["ops"]]
        batch = OpBatch(client_id=client_id_of("fixture"),
                        batch_id=batch_id_of(f"placement_{case['name']}"[:64]),
                        ops=ops)
        apply_batch(db, batch, 1_800_000_000_000)
        db.commit()
        placed = {r["uid"]: {"uid": r["uid"], "page": r["title"],
                             "parent_uid": r["parent_uid"],
                             "order_idx": r["order_idx"]}
                  for r in db.select(
                      "SELECT b.uid, p.title, b.parent_uid, b.order_idx"
                      " FROM blocks b JOIN pages p ON p.id = b.page_id")}
        assert [placed.get(e["uid"]) for e in case["expect"]] == case["expect"]
        for title in case["pages_absent"]:
            assert read(db, "SELECT 1 FROM pages WHERE title = ?",
                              (title,)).fetchone() is None
    finally:
        db.close()


def test_collapse_on_missing_block_only_journals_the_ghost():
    # the client just toggled a row the server doesn't have: the tombstone
    # this journal row ships drops it from the replica
    assert plan_op(0, _COLLAPSE, _skip_ctx(_COLLAPSE)) == (
        JournalBlock(uid_of("ghost99"), deleted=True),)


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
        JournalBlock(uid_of("ghost99"), deleted=True),
        InsertBlock(uid=uid_of("uid_hd1"), page_id=page_id_of(9),
                   parent_uid=None, order_idx=order_idx_of(4), text=_ORPHAN_HEADER,
                   heading=None),
        ReindexRefs(uid_of("uid_hd1"), _ORPHAN_HEADER),
        InsertBlock(uid=uid_of("uid_ch1"), page_id=page_id_of(9),
                   parent_uid=uid_of("uid_hd1"), order_idx=order_idx_of(0), text=note,
                   heading=None),
        ReindexRefs(uid_of("uid_ch1"), note),
        RecordConflictHeader(uid_of("ghost99"), _DAY, uid_of("uid_hd1")),
        TouchPage(page_id_of(9)),
    )


def test_skipped_op_appends_under_an_existing_header_for_the_block():
    effs = plan_op(0, _MOVE, _skip_ctx(
        _MOVE, header=ExistingHeader(uid_of("uid_old"), order_idx_of(2))))
    assert [e for e in effs if isinstance(e, InsertBlock)] == [
        InsertBlock(uid=uid_of("uid_ch1"), page_id=page_id_of(9),
                   parent_uid=uid_of("uid_old"), order_idx=order_idx_of(2),
                   text="move skipped: block ghost99 not found",
                   heading=None)]


@pytest.mark.parametrize("op, reason", [
    (DeleteOp(op="delete", uid=malformed_uid("bad uid!")), "block not found: bad uid!"),
    (SetCollapsedOp(op="set_collapsed", uid=malformed_uid("x" * 40), collapsed=True),
     "block not found: " + "x" * 40),
    (UpdateTextOp(op="update_text", uid=malformed_uid("a!"), text="t"),
     "block not found: a!"),
    (MoveOp(op="move", uid=uid_of("uid_b3"), parent_uid=malformed_uid("bad parent"), order_idx=order_idx_of(0)),
     "parent not found: bad parent"),
    (CreateOp(op="create", uid=uid_of("newuid1"), page_title=raw_title_of("P"),
              parent_uid=malformed_uid("bad parent"), order_idx=order_idx_of(0), text="t"),
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
    op = UpdateTextOp(op="update_text", uid=uid_of("ghost99"), text="")
    assert plan_op(0, op, _skip_ctx(op)) == (
        JournalBlock(uid_of("ghost99"), True),)


def test_unhashed_edit_of_missing_block_lands_like_a_hashed_one():
    op = UpdateTextOp(op="update_text", uid=uid_of("uid_t1"), text="new text",
                      page_title=raw_title_of("AI Agent Security"))
    hashed_op = _op(hint="AI Agent Security")
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=True))
    hashed = plan_op(0, hashed_op, _skip_ctx(hashed_op, hint_page_exists=True))
    assert effs == hashed
    assert effs[0] == JournalBlock(uid_of("uid_t1"), deleted=True)
    assert [e.text for e in effs if isinstance(e, InsertBlock)] == [
        "[[conflict]] [[AI Agent Security]] — edit to a block the server"
        " no longer has", "new text"]


def test_create_under_missing_parent_lands_its_text_under_the_parent():
    op = _create_under()
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=True))
    header = ("[[conflict]] [[AI]] — edit to a block the server no longer"
              " has")
    assert effs == (
        JournalBlock(uid_of("newuid1"), deleted=True),
        JournalBlock(uid_of("ghost_p1"), deleted=True),
        InsertBlock(uid=uid_of("uid_hd1"), page_id=page_id_of(9),
                   parent_uid=None, order_idx=order_idx_of(4), text=header, heading=None),
        ReindexRefs(uid_of("uid_hd1"), header),
        InsertBlock(uid=uid_of("uid_ch1"), page_id=page_id_of(9),
                   parent_uid=uid_of("uid_hd1"), order_idx=order_idx_of(0),
                   text="lost child", heading=None),
        ReindexRefs(uid_of("uid_ch1"), "lost child"),
        RecordConflictHeader(uid_of("ghost_p1"), _DAY, uid_of("uid_hd1")),
        TouchPage(page_id_of(9)),
    )


def test_create_under_missing_parent_names_a_missing_page_without_linking():
    op = _create_under(page_title=raw_title_of("Gone Page"))
    effs = plan_op(0, op, _skip_ctx(op, hint_page_exists=False))
    header = next(e for e in effs if isinstance(e, InsertBlock)
                  and e.uid == "uid_hd1")
    assert header.text == ("[[conflict]] `Gone Page` (page not found) —"
                           " edit to a block the server no longer has")


def test_blank_create_under_missing_parent_only_journals():
    op = _create_under(text="")
    assert plan_op(0, op, _skip_ctx(op)) == (
        JournalBlock(uid_of("newuid1"), deleted=True),
        JournalBlock(uid_of("ghost_p1"), deleted=True))


def test_create_under_missing_parent_still_checks_its_uid():
    op = CreateOp(op="create", uid=malformed_uid("a!"), page_title=raw_title_of("P"),
                  parent_uid=uid_of("ghost_p1"), order_idx=order_idx_of(0), text="t")
    with pytest.raises(OpError, match="invalid uid"):
        plan_op(0, op, _skip_ctx(op))


def test_create_under_missing_parent_rejects_a_parent_uid_with_a_trailing_newline():
    # impossible_uid_reason's parent_uid check (diverted_create skip kind)
    # has the same $-vs-trailing-newline hole as the uid check above.
    op = CreateOp(op="create", uid=uid_of("newuid1"), page_title=raw_title_of("P"),
                  parent_uid=malformed_uid("ghost_p1\n"), order_idx=order_idx_of(0), text="t")
    with pytest.raises(OpError, match="parent not found"):
        plan_op(0, op, _skip_ctx(op))


def test_orphan_edit_rejects_a_uid_with_a_trailing_newline():
    # impossible_uid_reason's non-create uid check (orphan_edit skip kind):
    # a malformed uid must 400 rather than land a ghost journal/conflict
    # entry under an uid no surface can ever reference back.
    op = UpdateTextOp(op="update_text", uid=malformed_uid("abcdef\n"), text="t")
    with pytest.raises(OpError, match="block not found"):
        plan_op(0, op, _skip_ctx(op))


def test_move_to_missing_parent_leaves_the_block_and_notes_why():
    op = MoveOp(op="move", uid=uid_of("uid_b3"), parent_uid=uid_of("ghost_p1"), order_idx=order_idx_of(0))
    effs = plan_op(0, op, _skip_ctx(
        op, block_exists=True,
        subtree=(uid_of("uid_gc"), uid_of("uid_c1"), uid_of("uid_b3"))))
    header = "[[conflict]] [[Machine Learning]] — ((uid_b3))"
    note = "move skipped: target parent ghost_p1 not found"
    # A replica that applied the move holds the whole subtree under a ghost
    # of the parent; the parent's tombstone cascades all of it away there,
    # so it leads and every row of the subtree (root first) is re-shipped.
    assert effs == (
        JournalBlock(uid_of("ghost_p1"), deleted=True),
        InsertBlock(uid=uid_of("uid_hd1"), page_id=page_id_of(9),
                   parent_uid=None, order_idx=order_idx_of(4), text=header, heading=None),
        ReindexRefs(uid_of("uid_hd1"), header),
        InsertBlock(uid=uid_of("uid_ch1"), page_id=page_id_of(9),
                   parent_uid=uid_of("uid_hd1"), order_idx=order_idx_of(0), text=note,
                   heading=None),
        ReindexRefs(uid_of("uid_ch1"), note),
        RecordConflictHeader(uid_of("uid_b3"), _DAY, uid_of("uid_hd1")),
        TouchPage(page_id_of(9)),
        JournalBlock(uid_of("uid_b3"), deleted=False),
        JournalBlock(uid_of("uid_c1"), deleted=False),
        JournalBlock(uid_of("uid_gc"), deleted=False),
    )


# --- a move that would make a cycle -----------------------------------------
#
# Two devices moved blocks under each other concurrently: the server applied
# the first, so the second would nest a block under its own descendant.

_CYCLE_MOVE = MoveOp(op="move", uid=uid_of("uid_b2"), parent_uid=uid_of("uid_b3"),
                     order_idx=order_idx_of(0), page_title=raw_title_of("Machine Learning"))
_B2 = BlockInfo(uid_of("uid_b2"), page_id_of(1), None)


@pytest.mark.parametrize("op, block_exists, parent_exists, chain, expected", [
    # the target parent's chain holds the moved block: a cycle
    (_CYCLE_MOVE, True, True, ("uid_b3", "uid_b2"),
     Skip("move_cycle", uid_of("uid_b2"))),
    # a block moved under itself is the shortest cycle
    (MoveOp(op="move", uid=uid_of("uid_b2"), parent_uid=uid_of("uid_b2"), order_idx=order_idx_of(0)),
     True, True, ("uid_b2",), Skip("move_cycle", uid_of("uid_b2"))),
    # a chain without the block plans normally
    (_CYCLE_MOVE, True, True, ("uid_b3", "uid_b1"), None),
    # a missing block or parent is the missing-target case, chain or not
    (_CYCLE_MOVE, False, True, ("uid_b3", "uid_b2"),
     Skip("orphan_structural", uid_of("uid_b2"))),
    (_CYCLE_MOVE, True, False, ("uid_b3", "uid_b2"),
     Skip("move_parent_missing", uid_of("uid_b2"))),
    # only a move's chain means anything
    (_create_under(parent_uid=uid_of("uid_b3")), False, True, ("uid_b3", "newuid1"),
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
                     subtree=(uid_of("uid_b3"), uid_of("uid_b2")))


def test_move_that_would_make_a_cycle_leaves_the_block_and_notes_why():
    effs = plan_op(0, _CYCLE_MOVE, _cycle_ctx())
    header = "[[conflict]] [[Machine Learning]] — ((uid_b2))"
    note = "move skipped: would create a cycle"
    # A replica that applied the move holds uid_b2 under its own
    # descendant, a loop no page root reaches: every row of the moved
    # block's server subtree (root first) is re-shipped as it really is.
    # Nothing is gone, so nothing is tombstoned.
    assert effs == (
        InsertBlock(uid=uid_of("uid_hd1"), page_id=page_id_of(9),
                   parent_uid=None, order_idx=order_idx_of(4), text=header, heading=None),
        ReindexRefs(uid_of("uid_hd1"), header),
        InsertBlock(uid=uid_of("uid_ch1"), page_id=page_id_of(9),
                   parent_uid=uid_of("uid_hd1"), order_idx=order_idx_of(0), text=note,
                   heading=None),
        ReindexRefs(uid_of("uid_ch1"), note),
        RecordConflictHeader(uid_of("uid_b2"), _DAY, uid_of("uid_hd1")),
        TouchPage(page_id_of(9)),
        JournalBlock(uid_of("uid_b2"), deleted=False),
        JournalBlock(uid_of("uid_b3"), deleted=False),
    )


def test_move_under_itself_is_skipped_like_any_cycle():
    op = MoveOp(op="move", uid=uid_of("uid_b2"), parent_uid=uid_of("uid_b2"), order_idx=order_idx_of(0))
    effs = plan_op(0, op, _cycle_ctx(op, chain=("uid_b2",)))
    assert [e.text for e in effs if isinstance(e, InsertBlock)] == [
        "[[conflict]] [[Machine Learning]] — ((uid_b2))",
        "move skipped: would create a cycle"]


def test_cycle_note_appends_under_an_existing_header_for_the_block():
    effs = plan_op(0, _CYCLE_MOVE, _cycle_ctx(
        header=ExistingHeader(uid_of("uid_old"), order_idx_of(2))))
    assert [e for e in effs if isinstance(e, InsertBlock)] == [
        InsertBlock(uid=uid_of("uid_ch1"), page_id=page_id_of(9),
                   parent_uid=uid_of("uid_old"), order_idx=order_idx_of(2),
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
    (MoveOp(op="move", uid=uid_of("uid_b3"), parent_uid=uid_of("ghost_p1"), order_idx=order_idx_of(0)),
     _skip_ctx(MoveOp(op="move", uid=uid_of("uid_b3"), parent_uid=uid_of("ghost_p1"),
                      order_idx=order_idx_of(0)), block_exists=True),
     {"index": 3, "op": "move", "uid": "uid_b3",
      "reason": "parent_not_found", "note_page": _DAY}),
    (_CYCLE_MOVE, _cycle_ctx(),
     {"index": 3, "op": "move", "uid": "uid_b2", "reason": "cycle",
      "note_page": _DAY}),
])
def test_skip_report_names_the_op_and_where_its_note_landed(op, ctx,
                                                            expected):
    assert skip_report(3, op, ctx).model_dump() == expected


def test_replay_applies_an_unlink_step():
    t0, t1 = "Tags:: #AI", "Tags:: AI"
    rewrites = (BlockRewrite(text_hash(t0), text_hash(t1), "AI", "", "unlink"),)
    text, base = replay_title_rewrites(
        "Tags:: #AI plus", text_hash(t0), rewrites)
    assert text == "Tags:: AI plus"
    assert base == text_hash(t1)


def test_replay_unlink_matches_through_the_given_canonicaliser():
    t0, t1 = "x [[ AI ]] y", "x  AI  y"
    rewrites = (BlockRewrite(text_hash(t0), text_hash(t1), "AI", "", "unlink"),)
    stale = "x [[ AI ]] y offline"
    # default: today's normalize_title matching leaves the padded link
    assert replay_title_rewrites(stale, text_hash(t0), rewrites)[0] == stale
    text, base = replay_title_rewrites(
        stale, text_hash(t0), rewrites,
        canonical=lambda title: title.strip(" "))
    assert text == "x  AI  y offline"
    assert base == text_hash(t1)


def test_replay_unlink_normalizes_the_stored_title():
    t0, t1 = "see [[A I]]", "see A I"
    rewrites = (
        BlockRewrite(text_hash(t0), text_hash(t1), "A\tI", "", "unlink"),)
    text, _ = replay_title_rewrites("see [[A I]] more", text_hash(t0), rewrites)
    assert text == "see A I more"


def test_replay_skips_a_row_of_unknown_kind():
    t0, t1 = "see [[Old]]", "see [[New]]"
    # an unknown kind on purpose: asserting the replay skips it
    rewrites = (BlockRewrite(text_hash(t0), text_hash(t1), "Old", "New",
                             "bogus"),)  # pyrefly: ignore[bad-argument-type]
    text, _ = replay_title_rewrites("see [[Old]] more", text_hash(t0), rewrites)
    assert text == "see [[Old]] more"


def test_replay_applies_an_inline_step():
    t0, t1 = "see ((uid_p1))", "see copied"
    rewrites = (BlockRewrite(text_hash(t0), text_hash(t1), "uid_p1", "copied",
                             "inline"),)
    text, base = replay_title_rewrites(
        "see ((uid_p1)) more", text_hash(t0), rewrites)
    assert text == "see copied more"
    assert base == text_hash(t1)


def test_replay_chains_unlink_then_retitle():
    t0, t1, t2 = "#AI [[Paper]]", "AI [[Paper]]", "AI [[Papers]]"
    rewrites = (
        BlockRewrite(text_hash(t1), text_hash(t2), "Paper", "Papers"),
        BlockRewrite(text_hash(t0), text_hash(t1), "AI", "", "unlink"),
    )
    text, base = replay_title_rewrites(
        "#AI [[Paper]] x", text_hash(t0), rewrites)
    assert text == "AI [[Papers]] x"
    assert base == text_hash(t2)


def _top_create(title_text: str, text: str) -> CreateOp:
    return CreateOp(op="create", uid=uid_of("uid_c0000001"),
                    page_title=raw_title_of(title_text),
                    parent_uid=None, order_idx=order_idx_of(0), text=text)


def _top_move(title_text: str) -> MoveOp:
    return MoveOp(op="move", uid=uid_of("uid_m0000001"),
                  page_title=raw_title_of(title_text),
                  parent_uid=None, order_idx=order_idx_of(0))


def test_unlink_stale_text_rewrites_create_and_update_text_only():
    def is_x(raw: str) -> bool:
        return normalize_title(raw) == "X"
    create = _top_create("P", "see [[X]] and #X")
    unlinked_create = unlink_stale_text(create, is_x)
    assert isinstance(unlinked_create, CreateOp)
    assert unlinked_create.text == "see X and X"
    clean = _top_create("P", "see [[Y]]")
    assert unlink_stale_text(clean, is_x) is clean
    upd = UpdateTextOp(op="update_text", uid=uid_of("uid_u0000001"), text="[[X]]")
    unlinked_upd = unlink_stale_text(upd, is_x)
    assert isinstance(unlinked_upd, UpdateTextOp)
    assert unlinked_upd.text == "X"
    upd_clean = UpdateTextOp(op="update_text", uid=uid_of("uid_u0000001"),
                             text="[[Y]]")
    assert unlink_stale_text(upd_clean, is_x) is upd_clean
    move = _top_move("X")
    assert unlink_stale_text(move, is_x) is move
    delete = DeleteOp(op="delete", uid=uid_of("uid_d0000001"))
    assert unlink_stale_text(delete, is_x) is delete


def test_unlink_stale_text_keeps_every_field_but_the_text():
    def is_x(raw: str) -> bool:
        return normalize_title(raw) == "X"
    create = CreateOp(op="create", uid=uid_of("uid_c0000001"),
                      page_title=raw_title_of("P"),
                      parent_uid=uid_of("uid_p0000001"),
                      order_idx=order_idx_of(3), text="see [[X]]", heading=2,
                      view_type="numbered")
    upd = UpdateTextOp(op="update_text", uid=uid_of("uid_u0000001"),
                       text="see [[X]]", base_text_hash=text_hash("old"),
                       page_title=raw_title_of("P"))
    for op in (create, upd):
        # a new field on the op fails here until this fixture sets it
        assert op.model_fields_set == set(type(op).model_fields)
        out = unlink_stale_text(op, is_x)
        assert type(out) is type(op)
        assert out.text == "see X"
        assert out.model_dump(exclude={"text"}) == op.model_dump(exclude={"text"})


def test_classify_skip_stale_page():
    assert classify_skip(_top_create("X", "t"), False, False,
                         page_stale=True) == Skip("stale_page", uid_of("uid_c0000001"))
    assert classify_skip(_top_create("X", "  "), False, False,
                         page_stale=True) == Skip("stale_page", None)
    assert classify_skip(_top_move("X"), True, False,
                         page_stale=True) == Skip("stale_page", uid_of("uid_m0000001"))
    assert classify_skip(_top_create("X", "t"), False, False) is None
    assert classify_skip(_top_move("X"), True, False) is None
    # a missing block's move stays an orphan, stale or not
    assert classify_skip(_top_move("X"), False, False,
                         page_stale=True) == Skip("orphan_structural",
                                                  uid_of("uid_m0000001"))
    # an existing block's create is not re-created, so never stale
    assert classify_skip(_top_create("X", "t"), True, False,
                         page_stale=True) is None


def test_plan_stale_create_parks_text_under_a_code_span_header():
    op = _top_create("X", "kept text")
    ctx = _skip_ctx(op, page_stale=True)
    assert isinstance(ctx, LandedSkipContext)
    assert plan_op(0, op, ctx) == (
        JournalBlock(uid_of("uid_c0000001"), True),
        *conflict_entry_effects(uid_of("uid_c0000001"), "kept text",
                                orphan_header_text(raw_title_of("X"), False),
                                ctx.landing))


def test_plan_stale_blank_create_lands_nothing():
    op = _top_create("X", " ")
    ctx = _skip_ctx(op, page_stale=True)
    assert isinstance(ctx, SkipContext)
    assert plan_op(0, op, ctx) == (JournalBlock(uid_of("uid_c0000001"),
                                                True),)


def test_plan_stale_move_keeps_block_and_notes_it():
    op = _top_move("X")
    subtree = (uid_of("uid_kid"), uid_of("uid_m0000001"))
    ctx = _skip_ctx(op, block_exists=True, page_stale=True,
                    page_title=canonical_title_of("Home"), subtree=subtree)
    assert isinstance(ctx, StuckMoveContext)
    assert plan_op(0, op, ctx) == (
        *conflict_entry_effects(
            uid_of("uid_m0000001"), stale_page_move_note(raw_title_of("X")),
            live_block_header_text(canonical_title_of("Home"), uid_of("uid_m0000001")), ctx.landing),
        JournalBlock(uid_of("uid_m0000001"), False),
        JournalBlock(uid_of("uid_kid"), False))
    assert not any(isinstance(e, JournalBlock) and e.deleted
                   for e in plan_op(0, op, ctx))


def test_plan_stale_context_must_fit_the_op():
    move = _top_move("X")
    skip = Skip("stale_page", uid_of("uid_m0000001"))
    with pytest.raises(AssertionError):
        plan_op(0, move, LandedSkipContext(skip, _landing(), False))
    create = _top_create("X", "t")
    with pytest.raises(AssertionError):
        plan_op(0, create, StuckMoveContext(
            Skip("stale_page", uid_of("uid_c0000001")), _landing(),
            canonical_title_of("Home"), ()))


def test_skip_report_stale_page_reason():
    op = _top_create("X", "t")
    assert skip_report(2, op, _skip_ctx(op, page_stale=True)).model_dump() == {
        "index": 2, "op": "create", "uid": "uid_c0000001",
        "reason": "page_deleted", "note_page": _DAY}


def test_rewrite_effects_record_one_row_per_unlinked_title():
    sent = UpdateTextOp(op="update_text", uid=uid_of("uid_u0000001"),
                        text="[[X]] and [[Z]] and [[Y]]")
    planned = (UpdateText(uid_of("uid_u0000001"), "X and Z and [[Y]]"),)
    stale = {canonical_title_of(t) for t in "XZW"}
    [eff] = rewrite_effects(sent, planned, stale, normalize_title)
    after = text_hash("X and Z and [[Y]]")
    assert eff == RecordRewrite(uid_of("uid_u0000001"), tuple(
        BlockRewrite(text_hash(sent.text), after, t, "", "unlink")
        for t in "XZ"))


def test_rewrite_effects_skip_parked_and_unchanged_text():
    sent = UpdateTextOp(op="update_text", uid=uid_of("uid_u0000001"),
                        text="[[X]]")
    stale = {canonical_title_of("X")}
    assert rewrite_effects(sent, (), stale, normalize_title) == ()
    plain = UpdateTextOp(op="update_text", uid=uid_of("uid_u0000001"),
                         text="[[Y]]")
    planned = (UpdateText(uid_of("uid_u0000001"), "[[Y]]"),)
    assert rewrite_effects(plain, planned, stale, normalize_title) == ()


_U1 = uid_of("uid_u0000001")


def _replay_effects(sent_text, base_text, rewrites, current, stale=()):
    sent = UpdateTextOp(op="update_text", uid=_U1, text=sent_text,
                        base_text_hash=text_hash(base_text))
    unlinked = unlink_stale_refs(
        sent_text, lambda raw: canonical_title_of(normalize_title(raw)) in stale)
    outcome = classify_text_edit(unlinked, text_hash(base_text), current,
                                 rewrites)
    planned = (() if outcome.kind == "identical"
               else (UpdateText(_U1, outcome.text),))
    return rewrite_effects(sent, planned, stale, normalize_title,
                           outcome.replayed, outcome.text)


def test_rewrite_effects_chain_each_replayed_step_from_the_sent_text():
    t0, t1, t2 = "[[A]]", "[[B]]", "[[C d]]"
    rewrites = (BlockRewrite(text_hash(t1), text_hash(t2), "B", "C d"),
                BlockRewrite(text_hash(t0), text_hash(t1), "A", "B"))
    [eff] = _replay_effects("[[A]] x", t0, rewrites, t2)
    assert eff == RecordRewrite(_U1, (
        BlockRewrite(text_hash("[[A]] x"), text_hash("[[B]] x"), "A", "B"),
        BlockRewrite(text_hash("[[B]] x"), text_hash("[[C d]] x"),
                     "B", "C d")))


def test_rewrite_effects_cover_an_identical_replay_and_inlines():
    t0, t1 = "x ((uid_u0000002)) y", "x text y"
    ref = "uid_u0000002"
    rewrites = (BlockRewrite(text_hash(t0), text_hash(t1), ref, "text",
                             "inline"),)
    [eff] = _replay_effects("x ((uid_u0000002)) y!", t0, rewrites,
                            "x text y!")
    assert eff == RecordRewrite(_U1, (BlockRewrite(
        text_hash("x ((uid_u0000002)) y!"), text_hash("x text y!"), ref,
        "text", "inline"),))


def test_rewrite_effects_cover_a_stale_unlink_before_a_replayed_rename():
    t0, t1 = "[[A]]", "[[B]]"
    rewrites = (BlockRewrite(text_hash(t0), text_hash(t1), "A", "B"),)
    stale = {canonical_title_of("Z")}
    [eff] = _replay_effects("[[A]] [[Z]]", t0, rewrites, t1, stale)
    assert eff == RecordRewrite(_U1, (
        BlockRewrite(text_hash("[[A]] [[Z]]"), text_hash("[[A]] Z"), "Z", "",
                     "unlink"),
        BlockRewrite(text_hash("[[A]] Z"), text_hash("[[B]] Z"), "A", "B")))


def test_rewrite_effects_record_nothing_for_plain_clean_or_conflicting_edits():
    t0 = "[[A]]"
    assert _replay_effects("[[A]] x", t0, (), t0) == ()


def test_rewrite_effects_record_a_conflicting_replay_from_its_written_text():
    t0 = "[[A]]"
    rewrites = (BlockRewrite(text_hash(t0), text_hash("[[B]]"), "A", "B"),)
    [eff] = _replay_effects("[[A]] x", t0, rewrites, "[[B]] other")
    assert eff == RecordRewrite(_U1, (BlockRewrite(
        text_hash("[[A]] x"), text_hash("[[B]] x"), "A", "B"),))


def test_rewrite_effects_record_a_stale_unlink_that_is_identical_to_current():
    sent = UpdateTextOp(op="update_text", uid=_U1, text="[[Z]] x",
                        base_text_hash=text_hash("old"))
    stale = {canonical_title_of("Z")}
    [eff] = rewrite_effects(sent, (), stale, normalize_title, (), "Z x")
    assert eff == RecordRewrite(_U1, (BlockRewrite(
        text_hash("[[Z]] x"), text_hash("Z x"), "Z", "", "unlink"),))


def test_rewrite_effects_record_nothing_when_the_chain_misses_written():
    t0 = "[[A]]"
    rewrites = (BlockRewrite(text_hash(t0), text_hash("[[B]]"), "A", "B"),)
    outcome = classify_text_edit("[[A]] x", text_hash(t0), "[[B]] x", rewrites)
    sent = UpdateTextOp(op="update_text", uid=_U1, text="[[A]] x",
                        base_text_hash=text_hash(t0))
    assert rewrite_effects(sent, (), (), normalize_title, outcome.replayed,
                           "[[B]] elsewhere") == ()


def test_rewrite_effects_record_nothing_when_the_chain_outruns_the_replay_cap():
    texts = [f"[[A{i}]]" for i in range(MAX_REPLAYED_REWRITES + 1)]
    rewrites = tuple(
        BlockRewrite(text_hash(a), text_hash(b), a[2:-2], b[2:-2])
        for a, b in zip(texts, texts[1:]))[::-1]
    stale = {canonical_title_of("Z")}
    # the stale unlink plus ten replayed renames is an 11-step chain, one more
    # than a later replay of the recorded rows can walk
    assert _replay_effects(f"{texts[0]} [[Z]]", texts[0], rewrites,
                           texts[-1], stale) == ()


def test_replay_of_a_real_delete_unlink_row_fences_a_leading_attribute():
    t0 = "old"
    rewrites = (BlockRewrite(text_hash(t0), text_hash("new"), "X", "",
                             "unlink"),)
    text, _ = replay_title_rewrites("X:: v see [[X]]", text_hash(t0), rewrites)
    assert text == "`X`:: v see X"
