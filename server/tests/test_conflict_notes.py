import pytest

from pkm.contracts.ops import (MAX_BLOCK_TEXT_CHARS, MoveOp, SetHeadingOp,
                               SetViewTypeOp)
from pkm.server.conflict_notes import (LONG_TITLE_LABEL, MOVE_CYCLE_NOTE,
                                       block_missing_note,
                                       conflict_label, deleted_header_text,
                                       existing_page_label,
                                       live_block_header_text,
                                       move_parent_missing_note,
                                       orphan_header_text,
                                       overwritten_header_text,
                                       stale_page_move_note)
from pkm.test_data.ids import canonical_title_of, order_idx_of, raw_title_of, uid_of
from pkm.text_limits import text_limit_violation


@pytest.mark.parametrize(
    "hint, hint_page, label",
    [
        ("AI Agent Security", "AI Agent Security", "[[AI Agent Security]]"),
        ("Old Title", None, "`Old Title` (page not found)"),
        ("a`b", None, "(page unknown)"),
        (None, None, "(page unknown)"),
        ("  ", None, "(page unknown)"),
        ("a[[b", None, "(page unknown)"),
        # a hint could exist and still be unusable syntax at the same
        # time (e.g. it names a real page's title that happens to hold
        # `[[`) -- unusable always wins.
        ("a[[b", "a[[b", "(page unknown)"),
        # `[[title]]` would read back as a different title (a trailing `]`,
        # paired backticks), and the ref indexer would create THAT page, so
        # such a title is unusable even when a legacy page holds it
        ("x]", "x]", "(page unknown)"),
        ("[x]", "[x]", "(page unknown)"),
        ("a}]", "a}]", "(page unknown)"),
        ("a`b`c", "a`b`c", "(page unknown)"),
        ("  Padded  ", "  Padded  ", "[[  Padded  ]]"),
        # the stored title labels the page, whatever spelling named it
        ("Fo\no ", "Fo o", "[[Fo o]]"),
    ])
def test_conflict_label_table(hint, hint_page, label):
    page_title = None if hint is None else raw_title_of(hint)
    stored = None if hint_page is None else canonical_title_of(hint_page)
    assert conflict_label(page_title, stored) == label


def test_existing_page_label_falls_back_when_a_link_would_not_read_back():
    assert existing_page_label(raw_title_of("Paper")) == "[[Paper]]"
    assert existing_page_label(raw_title_of("Paper]")) == "`Paper]`"
    assert existing_page_label(raw_title_of("a`b]")) == "(page unknown)"


def test_headers_name_the_page_and_embed_or_name_the_block():
    assert overwritten_header_text(canonical_title_of("Paper"), uid_of("uid_b3")) == (
        "[[conflict]] [[Paper]] — overwritten by ((uid_b3))")
    assert orphan_header_text(raw_title_of("Old"), None) == (
        "[[conflict]] `Old` (page not found) — edit to a block the server"
        " no longer has")
    assert live_block_header_text(canonical_title_of("Paper"), uid_of("uid_b3")) == (
        "[[conflict]] [[Paper]] — ((uid_b3))")


def test_block_missing_note_names_what_was_skipped():
    assert block_missing_note(MoveOp(
        op="move", uid=uid_of("ghost99"), parent_uid=None, order_idx=order_idx_of(0))) == (
        "move skipped: block ghost99 not found")
    assert block_missing_note(SetHeadingOp(
        op="set_heading", uid=uid_of("ghost99"), heading=1)) == (
        "heading change skipped: block ghost99 not found")
    assert block_missing_note(SetViewTypeOp(
        op="set_view_type", uid=uid_of("ghost99"), view_type="numbered")) == (
        "view type change skipped: block ghost99 not found")


def test_move_notes_say_why_the_block_stayed_put():
    assert move_parent_missing_note(uid_of("ghost_p1")) == (
        "move skipped: target parent ghost_p1 not found")
    assert MOVE_CYCLE_NOTE == "move skipped: would create a cycle"


def test_deleted_header_links_the_page():
    assert deleted_header_text(canonical_title_of("Project X")) == (
        "[[conflict]] [[Project X]] — deleted while edited elsewhere")


def test_deleted_header_fences_a_title_that_does_not_link_back():
    assert deleted_header_text(canonical_title_of("Project X]")) == (
        "[[conflict]] `Project X]` — deleted while edited elsewhere")


@pytest.mark.parametrize("title_text, note", [
    ("Old Title", "move skipped: page `Old Title` was deleted"),
    ("a`b", "move skipped: page (page unknown) was deleted"),
])
def test_stale_page_move_note_names_the_page_as_code(title_text, note):
    assert stale_page_move_note(raw_title_of(title_text)) == note


# A page title has no length cap, and a hint is whatever the client sent,
# so every header and note that embeds one is fitted to the text limits.
HUGE_TITLE = "t" * 1_000_000
LONGEST_PROD_TITLE = "p" * 260  # the longest title in production
NESTED_TITLE = "[[a//" * 40 + "x" + "]]" * 40
UID = uid_of("fit_hdr_001")

_BUILDERS = {
    "overwritten": lambda t: overwritten_header_text(canonical_title_of(t),
                                                     UID),
    "deleted": lambda t: deleted_header_text(canonical_title_of(t)),
    "orphan_existing": lambda t: orphan_header_text(raw_title_of(t),
                                                    canonical_title_of(t)),
    "orphan_missing": lambda t: orphan_header_text(raw_title_of(t), None),
    "live_block": lambda t: live_block_header_text(canonical_title_of(t),
                                                   UID),
    "stale_move": lambda t: stale_page_move_note(raw_title_of(t)),
}


@pytest.mark.parametrize("builder", _BUILDERS)
def test_a_header_or_note_for_a_huge_title_falls_back(builder):
    text = _BUILDERS[builder](HUGE_TITLE)
    assert text_limit_violation(text) is None
    assert LONG_TITLE_LABEL in text


@pytest.mark.parametrize("builder", _BUILDERS)
def test_a_header_or_note_for_a_deeply_nested_title_fits(builder):
    # Such a title never reads back as one link, so it is labelled as
    # inline code or not at all, and the nesting measure skips code.
    assert text_limit_violation(_BUILDERS[builder](NESTED_TITLE)) is None


def test_a_huge_hint_naming_no_page_falls_back():
    text = orphan_header_text(raw_title_of("h" * 3_000_000), None)
    assert text_limit_violation(text) is None
    assert LONG_TITLE_LABEL in text


@pytest.mark.parametrize("builder", _BUILDERS)
def test_the_longest_production_title_is_still_named(builder):
    text = _BUILDERS[builder](LONGEST_PROD_TITLE)
    assert LONGEST_PROD_TITLE in text
    assert LONG_TITLE_LABEL not in text


def test_a_title_just_fitting_is_named():
    # The header around the label is short; a title leaving room for it
    # is named, one character more is not.
    room = MAX_BLOCK_TEXT_CHARS - len(deleted_header_text(
        canonical_title_of("x")).replace("[[x]]", ""))
    fits = "f" * (room - 4)
    assert fits in deleted_header_text(canonical_title_of(fits))
    over = fits + "f"
    assert LONG_TITLE_LABEL in deleted_header_text(canonical_title_of(over))
