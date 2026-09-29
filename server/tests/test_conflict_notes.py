import pytest

from pkm.contracts.ops import MoveOp, SetHeadingOp, SetViewTypeOp
from pkm.server.conflict_notes import (MOVE_CYCLE_NOTE, block_missing_note,
                                       conflict_label, existing_page_label,
                                       live_block_header_text,
                                       move_parent_missing_note,
                                       orphan_header_text,
                                       overwritten_header_text)


@pytest.mark.parametrize(
    "page_title, hint_page_exists, label",
    [
        ("AI Agent Security", True, "[[AI Agent Security]]"),
        ("Old Title", False, "`Old Title` (page not found)"),
        ("a`b", False, "(page unknown)"),
        (None, False, "(page unknown)"),
        ("  ", False, "(page unknown)"),
        ("a[[b", False, "(page unknown)"),
        # a hint could exist and still be unusable syntax at the same
        # time (e.g. it names a real page's title that happens to hold
        # `[[`) -- unusable always wins.
        ("a[[b", True, "(page unknown)"),
        # the page exists, but `[[title]]` would read back as a different
        # title (a trailing `]`, paired backticks), and the ref indexer
        # would create THAT page -- so it is named, not linked
        ("x]", True, "`x]`"),
        ("[x]", True, "`[x]`"),
        ("a}]", True, "`a}]`"),
        ("a`b`c", True, "(page unknown)"),
        ("  Padded  ", True, "[[  Padded  ]]"),
    ])
def test_conflict_label_table(page_title, hint_page_exists, label):
    assert conflict_label(page_title, hint_page_exists) == label


def test_existing_page_label_falls_back_when_a_link_would_not_read_back():
    assert existing_page_label("Paper") == "[[Paper]]"
    assert existing_page_label("Paper]") == "`Paper]`"
    assert existing_page_label("a`b]") == "(page unknown)"


def test_headers_name_the_page_and_embed_or_name_the_block():
    assert overwritten_header_text("Paper", "uid_b3") == (
        "[[conflict]] [[Paper]] — overwritten by ((uid_b3))")
    assert orphan_header_text("Old", False) == (
        "[[conflict]] `Old` (page not found) — edit to a block the server"
        " no longer has")
    assert live_block_header_text("Paper", "uid_b3") == (
        "[[conflict]] [[Paper]] — ((uid_b3))")


def test_block_missing_note_names_what_was_skipped():
    assert block_missing_note(MoveOp(
        op="move", uid="ghost99", parent_uid=None, order_idx=0)) == (
        "move skipped: block ghost99 not found")
    assert block_missing_note(SetHeadingOp(
        op="set_heading", uid="ghost99", heading=1)) == (
        "heading change skipped: block ghost99 not found")
    assert block_missing_note(SetViewTypeOp(
        op="set_view_type", uid="ghost99", view_type="numbered")) == (
        "view type change skipped: block ghost99 not found")


def test_move_notes_say_why_the_block_stayed_put():
    assert move_parent_missing_note("ghost_p1") == (
        "move skipped: target parent ghost_p1 not found")
    assert MOVE_CYCLE_NOTE == "move skipped: would create a cycle"
