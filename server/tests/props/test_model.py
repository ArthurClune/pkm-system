"""Example tests for the reference op model and its strategies. Unmarked:
these run in the default suite on every commit, guarding the oracle the
property tests trust. One test per doc table row the model encodes."""
import ast
import copy
from pathlib import Path

from hypothesis import given, settings, strategies as st

from pkm.batch import validate_batch
from pkm.contracts.ops import BlockUid, OpBatch, subtree_hash, SyncSeq, text_hash, UID_RE
from props.harness import DAILY_TITLE
from props.model import (MBlock, Model, Outcome, Rewrite, positions_after,
                         replay_chain, unlink_stale)
from props.strategies import (PAGES, batch_for, cli_batch, op_for, seed_tree,
                              texts, uid_pool)
from pkm.test_data.ids import (
    canonical_title_of, malformed_uid, order_idx_of, seq_of, uid_of,
)

A, B, C, P, X, Y = (uid_of(u) for u in ("blk_aa", "blk_bb", "blk_cc", "blk_pp", "blk_xx", "blk_yy"))


def blk(uid: BlockUid, page="Alpha", parent=None, idx=0, text="", heading=None,
        collapsed=False, view_type=None):
    return MBlock(uid=uid, page=page, parent=parent, order_idx=order_idx_of(idx), text=text,
                  heading=heading, collapsed=collapsed, view_type=view_type)


def model(*rows):
    return Model.from_rows(PAGES, rows)


def keys(m, parent=None, page="Alpha"):
    return sorted((b.order_idx, b.uid) for b in m.blocks.values()
                  if b.parent == parent and b.page == page)


def create(uid: BlockUid, idx, parent=None, text="t", page="Alpha", **kw):
    return {"op": "create", "uid": uid, "page_title": page,
            "parent_uid": parent, "order_idx": idx, "text": text, **kw}


def move(uid: BlockUid, parent, idx, page=None):
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
    bad = malformed_uid("bad uid!")
    assert m.apply([create(bad, 0)]).status == 400
    assert m.apply([{"op": "delete", "uid": bad}]).status == 400
    assert m.apply([move(A, bad, 0)]).status == 400
    # a missing block's move never checks its parent uid's shape
    assert m.apply([move(X, bad, 0)]).status == 200


def test_title_syntax_is_400():
    m = model()
    assert m.apply([create(X, 0, page="Bad [[title")]).status == 400
    assert m.apply([create(X, 0, text="[[a#b]]")]).status == 400
    assert X not in m.blocks


# --- backend.md § Page mutations: a page delete -------------------------------

def test_delete_missing_page_is_404():
    m = model()
    m.pages.discard("Gamma")
    assert m.delete_page("Gamma", {}, seq=seq_of(9)).status == 404
    assert m.deletions == []


def test_delete_page_refused_by_an_attribute_naming_it():
    m = model(blk(A, page="Alpha"), blk(B, page="Beta", text="Alpha:: v"),
              blk(C, page="Beta", text="[[Alpha]]:: v"))
    before = m.snapshot()
    out = m.delete_page(
        "Alpha", {uid_of("other_1"): "Alpha:: w", uid_of("other_2"): "x"},
        seq_of(9))
    assert out.status == 409
    assert out.blockers == {B: "used_as_attribute", C: "attribute",
                            "other_1": "used_as_attribute"}
    assert m.snapshot() == before and "Alpha" in m.pages
    assert m.deletions == [] and m.rewrites == {}


def test_delete_page_refused_when_a_copy_would_add_an_attribute():
    # the copy of P keeps `[[Alpha]]:: v` (a link, not an attribute), and
    # unlinking it there makes the referencing block a property block
    m = model(blk(P, page="Alpha", text="[[Alpha]]:: v"),
              blk(B, page="Beta", text=f"(({P}))"))
    assert m.delete_page("Alpha", {}, seq_of(9)).blockers == {B: "attribute"}


def test_delete_page_removes_its_blocks_and_rewrites_references():
    m = model(blk(P, page="Alpha", text=f"Beta:: copy [[Alpha]] (({A}))"),
              blk(A, page="Alpha", idx=1, text=f"inner (({P}))"),
              blk(B, page="Beta", text=f"see [[Alpha]] (({P})) #Beta"),
              blk(C, page="Gamma", text="untouched [[Beta]]"))
    out = m.delete_page(
        "Alpha", {uid_of("conflict_1"): f"[[Alpha]] (({A}))"}, seq_of(9))
    assert out.status == 200
    # a copy drops its attribute, inlines one level, blanks the rest
    assert out.copies == {P: "copy Alpha inner ", A: "inner copy Alpha "}
    assert set(m.blocks) == {B, C} and {P, A} <= m.deleted
    assert m.blocks[B].text == "see Alpha copy Alpha inner  #Beta"
    assert m.blocks[C].text == "untouched [[Beta]]"
    assert out.rewrite("[[Alpha]] x")[0] == "Alpha x"
    assert "Alpha" not in m.pages and m.deletions == [("Alpha", 9)]
    assert m.rewrites == {B: [Rewrite(
        text_hash(f"see [[Alpha]] (({P})) #Beta"),
        text_hash("see Alpha copy Alpha inner  #Beta"),
        frozenset({"Alpha"}), ((P, "copy Alpha inner "),))]}


# --- backend.md § Stale batches -----------------------------------------------

def deleted(*rows, title="Alpha", seq: SyncSeq = seq_of(9)):
    """A model whose `title` page was deleted at journal head `seq`."""
    m = model(*rows)
    assert m.delete_page(title, {}, seq).status == 200
    return m


def test_stale_titles_follow_seen_seq():
    m = deleted()
    assert m.stale_titles(None) == frozenset()
    assert m.stale_titles(seq_of(9)) == frozenset()
    assert m.stale_titles(seq_of(8)) == {"Alpha"}


def test_unlink_stale_fences_a_leading_attribute():
    assert unlink_stale("Alpha:: v [[Alpha]]", {"Alpha"}) == "`Alpha`:: v Alpha"
    assert unlink_stale("[[Alpha]]:: v", {"Alpha"}) == "`Alpha`:: v"
    assert unlink_stale("Beta:: #Beta [[Alpha]]", {"Alpha"}) == \
        "Beta:: #Beta Alpha"
    assert unlink_stale("a`b:: v", {"a`b"}) == "a`b: v"


def test_stale_create_page_is_dropped():
    m = deleted()
    out = m.apply([{"op": "create_page", "page_title": "Alpha"}], seen_seq=seq_of(8))
    assert out == Outcome(200, (), ()) and "Alpha" not in m.pages
    m.apply([{"op": "create_page", "page_title": "Alpha"}], seen_seq=seq_of(9))
    assert "Alpha" in m.pages


def test_stale_top_level_create_on_the_deleted_page_is_parked():
    m = deleted()
    out = m.apply([create(X, 0, text="Alpha:: [[Alpha]]", page="Alpha"),
                   create(Y, 0, text="", page="Alpha")], seen_seq=seq_of(8))
    assert out.skipped == ((0, "create", X, "page_deleted"),
                           (1, "create", Y, "page_deleted"))
    assert out.kept_texts == ("`Alpha`:: Alpha",)
    assert X not in m.blocks and "Alpha" not in m.pages


def test_stale_child_create_follows_its_parent_not_the_title():
    m = deleted(blk(B, page="Beta"))
    out = m.apply([create(X, 0, parent=B, page="Alpha")], seen_seq=seq_of(8))
    assert out.skipped == () and m.blocks[X].page == "Beta"


def test_stale_top_level_move_onto_the_deleted_page_stays_put():
    m = deleted(blk(B, page="Beta"))
    out = m.apply([move(B, None, 3, page="Alpha")], seen_seq=seq_of(8))
    assert out == Outcome(200, ((0, "move", B, "page_deleted"),), ())
    assert m.blocks[B] == blk(B, page="Beta")


def test_stale_text_is_unlinked_and_records_its_rewrite():
    m = deleted(blk(B, page="Beta", text="old"))
    out = m.apply([create(X, 0, text="[[Alpha]]:: v", page="Beta"),
                   {"op": "update_text", "uid": B, "text": "see #Alpha"}],
                  seen_seq=seq_of(8))
    assert out == Outcome(200, (), ())
    assert m.blocks[X].text == "`Alpha`:: v"
    assert m.blocks[B].text == "see Alpha"
    assert "Alpha" not in m.pages
    assert m.rewrites[X] == [Rewrite(text_hash("[[Alpha]]:: v"),
                                     text_hash("`Alpha`:: v"),
                                     frozenset({"Alpha"}))]


def test_unstale_text_recreates_the_page():
    m = deleted(blk(B, page="Beta", text="old"))
    m.apply([{"op": "update_text", "uid": B, "text": "see [[Alpha]]"}],
            seen_seq=seq_of(9))
    assert m.blocks[B].text == "see [[Alpha]]" and "Alpha" in m.pages
    assert B not in m.rewrites


def test_chained_edit_after_a_stale_fence_replays_clean():
    m = deleted(blk(B, page="Beta", text="old"))
    m.apply([{"op": "update_text", "uid": B, "text": "Alpha:: v",
              "base_text_hash": text_hash("old")}], seen_seq=seq_of(8))
    assert m.blocks[B].text == "`Alpha`:: v"
    # the device never saw the fence: its next edit is based on its own text
    out = m.apply([{"op": "update_text", "uid": B, "text": "Alpha:: v2",
                    "base_text_hash": text_hash("Alpha:: v")}])
    assert out == Outcome(200, (), ())
    assert m.blocks[B].text == "`Alpha`:: v2" and "Alpha" not in m.pages
    # and that replay is itself recorded for the edit after it
    assert m.rewrites[B][0] == Rewrite(text_hash("Alpha:: v2"),
                                       text_hash("`Alpha`:: v2"),
                                       frozenset({"Alpha"}))


def test_edit_based_on_a_page_deletes_rewrite_replays_its_inline():
    m = model(blk(P, page="Alpha", text="copied"),
              blk(B, page="Beta", text=f"x (({P}))"))
    m.delete_page("Alpha", {}, seq_of(9))
    assert m.blocks[B].text == "x copied"
    out = m.apply([{"op": "update_text", "uid": B, "text": f"y (({P}))",
                    "base_text_hash": text_hash(f"x (({P}))")}])
    assert out == Outcome(200, (), ()) and m.blocks[B].text == "y copied"


def test_recorded_rewrites_remember_the_text_they_rewrote():
    m = deleted(blk(B, page="Beta", text="see [[Alpha]]"))
    assert m.rewrites[B][0].before == "see [[Alpha]]"
    m.apply([create(X, 0, text="Alpha:: v", page="Beta")], seen_seq=seq_of(8))
    assert m.rewrites[X][0].before == "Alpha:: v"


def test_outcome_names_the_rewrite_paths_its_edits_took():
    m = deleted(blk(B, page="Beta", text="Alpha w"))
    out = m.apply([{"op": "update_text", "uid": B, "text": "[[Alpha]] w",
                    "base_text_hash": text_hash("[[Alpha]] w")}], seen_seq=seq_of(8))
    assert out.paths == ("update_text: identical after stale unlink",)
    assert B in m.rewrites
    m = deleted(blk(B, page="Beta", text="see [[Alpha]]"))
    m.apply([{"op": "update_text", "uid": B, "text": "online"}])
    out = m.apply([{"op": "update_text", "uid": B, "text": "see [[Alpha]] x",
                    "base_text_hash": text_hash("see [[Alpha]]")}])
    assert out.paths == ("update_text replay: conflict, edit rewritten",)
    assert out.kept_texts == ("online",) and m.blocks[B].text == "see Alpha x"


def test_stale_conflicting_edit_keeps_the_current_text():
    m = deleted(blk(B, page="Beta", text="current"))
    out = m.apply([{"op": "update_text", "uid": B, "text": "[[Alpha]] mine",
                    "base_text_hash": text_hash("other")}], seen_seq=seq_of(8))
    assert out.kept_texts == ("current",)
    assert m.blocks[B].text == "Alpha mine"
    assert len(m.rewrites[B]) == 1


H0, H1, H2 = (text_hash(h) for h in ("h0", "h1", "h2"))


def test_recorded_rewrites_sharing_hashes_replay_as_one():
    m = model()
    m._record(A, Rewrite(H1, H2, frozenset({"Alpha"})))
    m._record(A, Rewrite(H0, H1, frozenset({"Beta"})))
    m._record(A, Rewrite(H1, H2, frozenset({"Gamma"}), ((B, "c"),)))
    assert m.rewrites[A] == [
        Rewrite(H1, H2, frozenset({"Alpha", "Gamma"}), ((B, "c"),)),
        Rewrite(H0, H1, frozenset({"Beta"}))]
    assert replay_chain(m.rewrites[A], f"#Beta (({B}))", H0) == (
        "Beta c", H2, [m.rewrites[A][1], m.rewrites[A][0]])


@settings(max_examples=50)
@given(st.data())
def test_text_model_matches_the_unlinker_on_generated_texts(data):
    """The model rewrites texts over the strategies' vocabulary only; on
    that vocabulary it must agree with `pkm.unlink`, so a state machine
    failure points at the ops path, not at the text model."""
    from pkm.refs import normalize_title
    from pkm.unlink import SourceBlock, plan_page_delete, unlink_stale_refs
    pool = uid_pool(6)
    title = data.draw(st.sampled_from(PAGES))
    text = data.draw(texts(pool, (title,)))
    assert unlink_stale(text, {title}) == unlink_stale_refs(
        text, lambda raw: normalize_title(raw) == title)
    page = {uid_of(u): t for u, t in zip(pool[:3], data.draw(st.lists(
        texts(pool), min_size=3, max_size=3)))}
    sources = dict(zip(pool[3:], data.draw(st.lists(
        texts(pool, (title,)), min_size=3, max_size=3))))
    plan = plan_page_delete(lambda raw: normalize_title(raw) == title, page,
                            [SourceBlock(uid_of(u), canonical_title_of("Other"),
                                        t)
                             for u, t in sources.items()])
    m = Model.from_rows(PAGES, [blk(u, page=title, text=t)
                                for u, t in page.items()])
    out = m.delete_page(title, sources, seq_of(9))
    assert out.blockers == {b.uid: b.reason for b in plan.blockers}
    if out.status == 200:
        assert {u: out.rewrite(t)[0] for u, t in sources.items()
                if out.rewrite(t)[0] != t} == plan.rewrites


# --- cli-and-mcp.md: batch `index` is a position ------------------------------

def cr(index=None, parent=None, alias=None, command="create"):
    params = {"page": "Alpha", "text": "t", "parent": parent, "index": index}
    if alias is not None:
        params["as"] = alias
    return {"command": command, "params": params}


def mv(target: str, parent=None, index=None):
    """A move of `target`, a uid or a `{{alias}}` spec."""
    return {"command": "move",
            "params": {"uid": target, "page": "Alpha", "parent": parent,
                       "index": index}}


def dl(uid: BlockUid):
    return {"command": "delete", "params": {"uid": uid}}


def after(groups, commands, new=(X, Y)):
    return positions_after(groups, commands, iter(new))


def test_positions_index_is_a_position_not_a_key():
    # The seed's keys are A@0, B@5, C@6: a position knows nothing of them.
    assert after({None: [A, B, C]}, [cr(index=2)]) == {
        None: [A, B, X, C], X: []}


def test_positions_indexed_then_appended_create():
    assert after({None: [A, B]}, [cr(index=0), cr()])[None] == [X, A, B, Y]


def test_positions_index_zero_twice_composes():
    assert after({None: [A, B]}, [cr(index=0), cr(index=0)])[None] == [
        Y, X, A, B]


def test_positions_delete_then_indexed_create():
    out = after({None: [A, B, C], B: [P]}, [dl(B), cr(index=1)])
    assert out == {None: [A, X, C], X: []}


def test_positions_move_within_parent_forwards():
    assert after({None: [A, B, C]}, [mv(A, index=1)])[None] == [B, A, C]


def test_positions_move_within_parent_backwards():
    assert after({None: [A, B, C]}, [mv(C, index=0)])[None] == [C, A, B]


def test_positions_move_onto_own_slot():
    assert after({None: [A, B, C]}, [mv(B, index=1)])[None] == [A, B, C]


def test_positions_move_counts_destination_without_the_block():
    # Index 2 among [B, C] is the end, not "before C".
    assert after({None: [A, B, C]}, [mv(A, index=2)])[None] == [B, C, A]


def test_positions_index_past_the_end_appends():
    out = after({None: [A, B]}, [cr(index=9), mv(A, index=9)])
    assert out[None] == [B, X, A]


def test_positions_move_across_parents_carries_its_subtree():
    out = after({None: [A, B], A: [C], C: [P]},
                [mv(C, parent=f"(({B}))", index=0)])
    assert out == {None: [A, B], A: [], B: [C], C: [P]}


def test_positions_alias_names_an_earlier_create():
    out = after({None: [A]}, [cr(alias="n"), cr(parent="{{n}}"),
                              mv("{{n}}", index=0)])
    assert out == {None: [X, A], X: [Y], Y: []}


def test_positions_cycle_move_leaves_the_block_in_place():
    groups = {None: [A, B], A: [C]}
    assert after(groups, [mv(A, parent=f"(({C}))", index=0),
                          mv(A, parent=f"(({A}))")]) == groups


def test_positions_missing_targets_are_skipped():
    # The create under a gone parent still mints its uid: X is spent.
    out = after({None: [A]}, [cr(parent=f"(({B}))"), mv(B, index=0),
                              mv(A, parent=f"(({C}))"), dl(C), cr(index=0)])
    assert out == {None: [Y, A], Y: []}


def test_positions_todo_is_a_create_and_input_is_untouched():
    groups = {None: [A]}
    assert after(groups, [cr(index=0, command="todo")])[None] == [X, A]
    assert groups == {None: [A]}


# --- isolation from the code under test --------------------------------------

def test_model_imports_no_server_code():
    tree = ast.parse((Path(__file__).parent / "model.py").read_text())
    names = [a.name for n in ast.walk(tree) if isinstance(n, ast.Import)
             for a in n.names]
    names += [n.module or "" for n in ast.walk(tree)
              if isinstance(n, ast.ImportFrom)]
    assert names, "model.py should import something"
    for name in names:
        assert not name.startswith(
            ("pkm.server", "pkm.planning", "pkm.batch")), name


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
    m = model(blk(uid_of(pool[0])), blk(uid_of(pool[1]), parent=pool[0]))
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
    # Every block a command names is a seeded uid or an alias: never the
    # internal key of an unaliased create.
    seeded = {r.uid for r in rows}
    for c in commands:
        for value in (c["params"].get("uid"), c["params"].get("parent")):
            if value is not None and not value.startswith("{{"):
                assert value.strip("()") in seeded, c
