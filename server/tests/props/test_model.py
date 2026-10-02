"""Example tests for the reference op model and its strategies. Unmarked:
these run in the default suite on every commit, guarding the oracle the
property tests trust. One test per doc table row the model encodes."""
import ast
import copy
from pathlib import Path

from hypothesis import given, settings, strategies as st

from pkm.batch import validate_batch
from pkm.contracts.ops import UID_RE, OpBatch, subtree_hash, text_hash
from props.harness import DAILY_TITLE
from props.model import MBlock, Model, Outcome
from props.strategies import (PAGES, batch_for, cli_batch, op_for, seed_tree,
                              texts, uid_pool)

A, B, C, P, X, Y = "blk_aa", "blk_bb", "blk_cc", "blk_pp", "blk_xx", "blk_yy"


def blk(uid, page="Alpha", parent=None, idx=0, text="", heading=None,
        collapsed=False, view_type=None):
    return MBlock(uid=uid, page=page, parent=parent, order_idx=idx, text=text,
                  heading=heading, collapsed=collapsed, view_type=view_type)


def model(*rows):
    return Model.from_rows(PAGES, rows)


def keys(m, parent=None, page="Alpha"):
    return sorted((b.order_idx, b.uid) for b in m.blocks.values()
                  if b.parent == parent and b.page == page)


def create(uid, idx, parent=None, text="t", page="Alpha", **kw):
    return {"op": "create", "uid": uid, "page_title": page,
            "parent_uid": parent, "order_idx": idx, "text": text, **kw}


def move(uid, parent, idx, page=None):
    op = {"op": "move", "uid": uid, "parent_uid": parent, "order_idx": idx}
    if page is not None:
        op["page_title"] = page
    return op


# --- backend.md § The write path: Ordering ----------------------------------

def test_create_shifts_siblings_at_and_after_key():
    m = model(blk(A, idx=0), blk(B, idx=1))
    out = m.apply([create(X, 1)])
    assert out == Outcome(200, (), ())
    assert keys(m) == [(0, A), (1, X), (2, B)]


def test_move_leaves_gap_in_old_group():
    m = model(blk(P), blk(A, parent=P, idx=0), blk(B, parent=P, idx=1),
              blk(C, parent=P, idx=2))
    out = m.apply([move(B, None, 5)])
    assert out.status == 200 and out.skipped == ()
    assert keys(m, parent=P) == [(0, A), (2, C)]
    assert keys(m) == [(0, P), (5, B)]


def test_move_onto_own_slot_shifts_later_siblings_only():
    m = model(blk(A, idx=0), blk(B, idx=1), blk(C, idx=2))
    m.apply([move(B, None, 1)])
    assert keys(m) == [(0, A), (1, B), (3, C)]


def test_create_heading_and_view_type_are_kept():
    m = model()
    m.apply([create(X, 0, heading=2, view_type="numbered")])
    assert m.blocks[X] == blk(X, text="t", heading=2, view_type="numbered")


# --- backend.md § Concurrent structure edits --------------------------------

def test_cycle_move_skipped():
    m = model(blk(A), blk(B, parent=A))
    before = m.snapshot()
    out = m.apply([move(A, B, 0)])
    assert out == Outcome(200, ((0, "move", A, "cycle"),), ())
    assert m.snapshot() == before


def test_move_under_itself_is_a_cycle():
    m = model(blk(A))
    out = m.apply([move(A, A, 0)])
    assert out.skipped == ((0, "move", A, "cycle"),)


def test_create_under_parent_on_other_page_follows_parent():
    m = model(blk(P, page="Beta"))
    m.apply([create(X, 0, parent=P, page="Alpha")])
    assert m.blocks[X].page == "Beta"


def test_move_under_parent_on_other_page_follows_parent():
    m = model(blk(P, page="Beta"), blk(A, page="Alpha"),
              blk(C, page="Alpha", parent=A))
    m.apply([move(A, P, 0, page="Gamma")])
    assert (m.blocks[A].page, m.blocks[C].page) == ("Beta", "Beta")


def test_cross_page_move_repages_subtree():
    m = model(blk(P, page="Alpha"), blk(C, page="Alpha", parent=P),
              blk(A, page="Beta", idx=0))
    m.apply([move(P, None, 0, page="Beta")])
    assert m.blocks[P] == blk(P, page="Beta", idx=0)
    assert m.blocks[C] == blk(C, page="Beta", parent=P)
    assert keys(m, page="Beta") == [(0, P), (1, A)]


# --- backend.md § Missing targets -------------------------------------------

def test_move_to_missing_parent_skipped():
    m = model(blk(A))
    before = m.snapshot()
    out = m.apply([move(A, X, 0)])
    assert out.skipped == ((0, "move", A, "parent_not_found"),)
    assert m.snapshot() == before


def test_move_of_missing_block_skipped():
    out = model().apply([move(X, None, 0)])
    assert out == Outcome(200, ((0, "move", X, "block_not_found"),), ())


def test_create_under_missing_parent_diverted():
    m = model()
    out = m.apply([create(X, 0, parent=Y, text="lost words")])
    assert X not in m.blocks
    assert out.kept_texts == ("lost words",)
    assert out.skipped == ((0, "create", X, "parent_not_found"),)


def test_create_under_missing_parent_blank_text_keeps_nothing():
    out = model().apply([create(X, 0, parent=Y, text="  ")])
    assert out.kept_texts == ()
    assert out.skipped == ((0, "create", X, "parent_not_found"),)


def test_edit_to_deleted_block_keeps_incoming_text():
    m = model(blk(A, text="a"))
    out = m.apply([{"op": "delete", "uid": A},
                   {"op": "update_text", "uid": A, "text": "late edit",
                    "base_text_hash": text_hash("a")}])
    assert out.kept_texts == ("late edit",)
    assert out.skipped == ((1, "update_text", A, "block_not_found"),)
    assert A not in m.blocks and A in m.deleted


def test_delete_missing_is_noop():
    m = model(blk(A))
    before = m.snapshot()
    out = m.apply([{"op": "delete", "uid": X}])
    # code, not docs: a no-op delete is still listed in the ack's skipped
    assert out == Outcome(200, ((0, "delete", X, "block_not_found"),), ())
    assert m.snapshot() == before


def test_set_collapsed_missing_is_noop():
    m = model(blk(A))
    before = m.snapshot()
    out = m.apply([{"op": "set_collapsed", "uid": X, "collapsed": True}])
    assert out == Outcome(200, ((0, "set_collapsed", X, "block_not_found"),),
                          ())
    assert m.snapshot() == before


def test_set_heading_and_view_type_of_missing_block_skipped():
    out = model().apply([{"op": "set_heading", "uid": X, "heading": 1},
                         {"op": "set_view_type", "uid": X,
                          "view_type": "document"}])
    assert out.skipped == ((0, "set_heading", X, "block_not_found"),
                           (1, "set_view_type", X, "block_not_found"))


def test_follow_on_op_sees_diverted_create_as_missing():
    m = model()
    out = m.apply([create(X, 0, parent=Y, text="first"),
                   {"op": "update_text", "uid": X, "text": "second"}])
    assert out.status == 200
    assert out.kept_texts == ("first", "second")


# --- backend.md § Conflicts / sync-and-offline.md § Conflicts at push time ---

def test_stale_hash_edit_keeps_overwritten_text():
    m = model(blk(A, text="old"))
    out = m.apply([{"op": "update_text", "uid": A, "text": "new",
                    "base_text_hash": text_hash("older")}])
    assert m.blocks[A].text == "new"
    assert out == Outcome(200, (), ("old",))


def test_matching_hash_edit_applies_cleanly():
    m = model(blk(A, text="old"))
    out = m.apply([{"op": "update_text", "uid": A, "text": "new",
                    "base_text_hash": text_hash("old")}])
    assert m.blocks[A].text == "new" and out.kept_texts == ()


def test_identical_text_with_stale_hash_is_noop():
    m = model(blk(A, text="same"))
    out = m.apply([{"op": "update_text", "uid": A, "text": "same",
                    "base_text_hash": text_hash("older")}])
    assert out.kept_texts == ()


def test_hashless_edit_is_lww():
    m = model(blk(A, text="old"))
    out = m.apply([{"op": "update_text", "uid": A, "text": "new"}])
    assert m.blocks[A].text == "new"
    assert out.kept_texts == ()


def test_guarded_delete_with_changed_subtree_keeps_all_texts():
    m = model(blk(P, text="p"), blk(C, parent=P, text="c"))
    out = m.apply([{"op": "delete", "uid": P,
                    "base_subtree_hash": subtree_hash([(P, "p")])}])
    assert m.blocks == {}
    assert {"p", "c"} <= set(out.kept_texts)
    assert m.deleted == {P, C}


def test_guarded_delete_with_matching_subtree_keeps_nothing():
    m = model(blk(P, text="p"), blk(C, parent=P, text="c"))
    out = m.apply([{"op": "delete", "uid": P,
                    "base_subtree_hash": subtree_hash([(P, "p"), (C, "c")])}])
    assert m.blocks == {} and out.kept_texts == ()


def test_set_ops_on_live_block():
    m = model(blk(A))
    m.apply([{"op": "set_collapsed", "uid": A, "collapsed": True},
             {"op": "set_heading", "uid": A, "heading": 3},
             {"op": "set_view_type", "uid": A, "view_type": "document"}])
    assert m.blocks[A] == blk(A, heading=3, collapsed=True,
                              view_type="document")


def test_recreate_deleted_uid():
    m = model(blk(A))
    out = m.apply([{"op": "delete", "uid": A}, create(A, 0, text="again")])
    assert out.status == 200 and m.blocks[A].text == "again"
    assert A not in m.deleted


def test_create_page_adds_page():
    m = Model.from_rows((), ())
    m.apply([{"op": "create_page", "page_title": "Gamma"}])
    assert m.pages == {"Gamma"}


# --- backend.md § Missing targets: what is still a 400 ----------------------

def test_create_existing_uid_is_400_and_atomic():
    m = model(blk(A))
    before = m.snapshot()
    out = m.apply([create(X, 0), create(A, 1)])
    assert out == Outcome(400, (), ())
    assert X not in m.blocks and m.snapshot() == before


def test_invalid_uid_is_400():
    m = model(blk(A))
    assert m.apply([create("bad uid!", 0)]).status == 400
    assert m.apply([{"op": "delete", "uid": "bad uid!"}]).status == 400
    assert m.apply([move(A, "bad uid!", 0)]).status == 400
    # a missing block's move never checks its parent uid's shape
    assert m.apply([move(X, "bad uid!", 0)]).status == 200


def test_title_syntax_is_400():
    m = model()
    assert m.apply([create(X, 0, page="Bad [[title")]).status == 400
    assert m.apply([create(X, 0, text="[[a#b]]")]).status == 400
    assert X not in m.blocks


# --- isolation from the code under test --------------------------------------

def test_model_imports_no_server_code():
    tree = ast.parse((Path(__file__).parent / "model.py").read_text())
    names = [a.name for n in ast.walk(tree) if isinstance(n, ast.Import)
             for a in n.names]
    names += [n.module or "" for n in ast.walk(tree)
              if isinstance(n, ast.ImportFrom)]
    assert names, "model.py should import something"
    for name in names:
        assert not name.startswith(("pkm.server", "pkm.planning")), name


# --- strategies --------------------------------------------------------------

def test_strategies_never_target_daily_page():
    assert DAILY_TITLE not in PAGES


def test_uid_pool_is_valid_and_disjoint_from_seed():
    pool = uid_pool(40)
    assert len(set(pool)) == 40
    assert all(UID_RE.fullmatch(u) for u in pool)
    assert not any(u.startswith("uid_b") for u in pool)


@settings(max_examples=20)
@given(st.data())
def test_seed_tree_is_gapped_and_shallow(data):
    rows = data.draw(seed_tree(uid_pool(16)))
    assert len(rows) <= 12
    by_uid = {r.uid: r for r in rows}
    seen: set[str] = set()
    for r in rows:   # parents before children, on the parent's page
        assert r.page in PAGES
        if r.parent is not None:
            assert r.parent in seen and by_uid[r.parent].page == r.page
        seen.add(r.uid)
        depth, p = 0, r.parent
        while p is not None:
            depth, p = depth + 1, by_uid[p].parent
        assert depth < 3
    groups: dict = {}
    for r in rows:   # keys ascend in seed order, gaps 1-4
        groups.setdefault((r.page, r.parent), []).append(r.order_idx)
    for ks in groups.values():
        assert all(1 <= b - a <= 4 for a, b in zip(ks, ks[1:]))


@settings(max_examples=20)
@given(st.data())
def test_batches_are_wire_valid_and_model_applies(data):
    pool = uid_pool(12)
    m = Model.from_rows(PAGES, data.draw(seed_tree(pool)))
    ops = data.draw(batch_for(m, pool))
    assert 1 <= len(ops) <= 20
    OpBatch.model_validate({"client_id": "c", "batch_id": "b" * 8,
                            "ops": ops})
    before = m.snapshot()
    out = m.apply(ops)
    assert out.status in (200, 400)
    if out.status == 400:
        assert m.snapshot() == before


@settings(max_examples=20)
@given(st.data())
def test_op_for_draws_wire_valid_ops(data):
    pool = uid_pool(8)
    m = Model.from_rows(PAGES, data.draw(seed_tree(pool)))
    op = data.draw(op_for(m, pool))
    OpBatch.model_validate({"client_id": "c", "batch_id": "b" * 8,
                            "ops": [op]})
    assert isinstance(data.draw(texts()), str)


@settings(max_examples=10)
@given(st.data())
def test_batch_for_does_not_mutate_the_model(data):
    pool = uid_pool(6)
    m = model(blk(pool[0]), blk(pool[1], parent=pool[0]))
    before = copy.deepcopy((m.snapshot(), m.pages, m.deleted))
    data.draw(batch_for(m, pool))
    assert (m.snapshot(), m.pages, m.deleted) == before


@settings(max_examples=20)
@given(st.data())
def test_cli_batches_pass_the_command_schema(data):
    rows = [r for r in data.draw(seed_tree(uid_pool(12)))
            if r.page == PAGES[0]]
    commands = data.draw(cli_batch(rows, PAGES[0]))
    assert commands
    validate_batch(commands)
