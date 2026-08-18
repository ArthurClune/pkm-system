import json
from pathlib import Path

import pytest

from pkm import rename
from pkm import refs
from pkm.refs import normalize_title
from pkm.rename import rewrite_title_refs, rewrite_title_refs_map

GRAMMAR_FIXTURE = (
    Path(__file__).parents[2] / "shared" / "fixtures" / "ref_grammar.json"
)
GRAMMAR_CASES = json.loads(GRAMMAR_FIXTURE.read_text())["cases"]


def test_bare_tag_matches_hashtag_capture_class():
    # _BARE_TAG hand-duplicates _HASHTAG's capture class so _tag_form() can
    # test a bare new_title the same way _HASHTAG would match it. If either
    # regex changes without the other, this must fail loudly rather than
    # let the two silently drift apart.
    assert refs._HASHTAG.pattern == rf"(?:^|(?<=[\s(]))#({rename._BARE_TAG.pattern})"


def test_link_rewritten():
    assert rewrite_title_refs("see [[Old]] now", "Old", "New") == \
        "see [[New]] now"


def test_multiple_occurrences_rewritten():
    assert rewrite_title_refs("[[Old]] and [[Old]]", "Old", "New") == \
        "[[New]] and [[New]]"


def test_other_titles_untouched():
    assert rewrite_title_refs("[[Older]] then [[Old]]", "Old", "New") == \
        "[[Older]] then [[New]]"


def test_case_sensitive():
    assert rewrite_title_refs("[[old]] stays", "Old", "New") == "[[old]] stays"


def test_bracket_tag_keeps_form():
    assert rewrite_title_refs("x #[[Old]] y", "Old", "New") == "x #[[New]] y"


def test_bare_tag_keeps_form():
    assert rewrite_title_refs("x #Old y", "Old", "New") == "x #New y"


def test_bare_tag_downgrades_when_new_title_has_spaces():
    assert rewrite_title_refs("x #Old y", "Old", "New Name") == \
        "x #[[New Name]] y"


def test_bare_tag_prefix_not_rewritten():
    # #Oldish is a different tag
    assert rewrite_title_refs("x #Oldish y", "Old", "New") == "x #Oldish y"


def test_attribute_keeps_form():
    assert rewrite_title_refs("Old:: some value", "Old", "New") == \
        "New:: some value"


def test_attribute_downgrades_when_new_title_breaks_grammar():
    # ':' can't appear in an attribute name -> downgrade to a link
    assert rewrite_title_refs("Old:: some value", "Old", "Re: New") == \
        "[[Re: New]] some value"


def test_attribute_only_at_line_start():
    # mid-text "Old::" is not an attribute (grammar anchors at start)
    assert rewrite_title_refs("see Old:: here", "Old", "New") == \
        "see Old:: here"


def test_attribute_name_trailing_space_is_replaced_with_the_title():
    # The name group ends where the colons start, so the span being replaced
    # covers "Old " -- the padding goes with the title it padded.
    assert rewrite_title_refs("Old :: v", "Old", "New") == "New:: v"


def test_blank_attribute_name_matches_nothing():
    assert rewrite_title_refs("  ::", "Old", "New") == "  ::"


def test_attribute_inside_inline_code_is_not_an_attribute():
    assert rewrite_title_refs("`Old::` v", "Old", "New") == "`Old::` v"


def test_attribute_rewrite_keeps_the_indent_in_front_of_it():
    # The span starts at the title, not at column 0. refs.extract() reads an
    # indented attribute as a ref, so a rename has to reach it -- and leave
    # the indent where the author put it.
    assert rewrite_title_refs("  Old:: v", "Old", "New") == "  New:: v"
    assert rewrite_title_refs("\tOld:: v", "Old", "New") == "\tNew:: v"


def test_attribute_rewrite_keeps_a_code_span_in_front_of_it():
    # strip_code() blanks the code to spaces, so a column-0 attribute match
    # would start its span at offset 0 and splice the new title over the code.
    assert rewrite_title_refs("`x` Old:: v", "Old", "New") == "`x` New:: v"
    assert rewrite_title_refs("```\nc\n``` Old:: v", "Old", "New") == \
        "```\nc\n``` New:: v"


def test_attribute_behind_a_leading_newline_is_rewritten():
    # _ATTRIBUTE cannot cross a newline, so this is reachable only because
    # the scan is anchored past the leading whitespace, as extract() is.
    assert rewrite_title_refs("\n Old:: v", "Old", "New") == "\n New:: v"


def test_code_fence_untouched():
    text = "```\n[[Old]]\n``` and [[Old]]"
    assert rewrite_title_refs(text, "Old", "New") == \
        "```\n[[Old]]\n``` and [[New]]"


def test_inline_code_untouched():
    assert rewrite_title_refs("`[[Old]]` and [[Old]]", "Old", "New") == \
        "`[[Old]]` and [[New]]"


def test_nested_link_inner_rewritten():
    # renaming the inner page mutates the outer title text too — documented
    # consequence of Roam's nesting (the inner ref must follow the rename)
    assert rewrite_title_refs("[[A [[Old]]]]", "Old", "New") == "[[A [[New]]]]"


def test_nested_link_outer_rewritten():
    assert rewrite_title_refs("[[A [[B]]]]", "A [[B]]", "C [[B]]") == \
        "[[C [[B]]]]"


def test_bare_tag_inside_a_bracket_is_rewritten_when_the_outer_title_is_not():
    # No replacement for the outer title, so the scan descends into it, and
    # inside "#Old" follows a space -- a tag by the same rule as at top level.
    assert rewrite_title_refs("[[A #Old]]", "Old", "New") == "[[A #New]]"


def test_hash_at_the_start_of_bracket_content_is_not_a_tag():
    # "[[" is not whitespace, so this "#Old" is title text. refs.extract()
    # reads it the same way -- _HASHTAG's lookbehind is also [\s(].
    assert rewrite_title_refs("[[#Old]]", "Old", "New") == "[[#Old]]"


def test_bracket_tag_is_descended_into_when_its_own_title_is_not_replaced():
    assert rewrite_title_refs("#[[A #Old]]", "Old", "New") == "#[[A #New]]"


def test_unbalanced_bracket_tag_does_not_stop_the_scan():
    assert rewrite_title_refs("#[[Old and [[Old]]", "Old", "New") == \
        "#[[Old and [[New]]"


def test_lone_hash_is_not_a_tag():
    assert rewrite_title_refs("# Old and #Old", "Old", "New") == "# Old and #New"


def test_outer_replacement_wins_over_a_tag_nested_inside_it():
    # Rewriting both would need overlapping spans; the outer one takes the
    # whole bracket and the inner tag is never visited.
    assert rewrite_title_refs_map(
        "[[A #Old]]", {"A #Old": "Outer", "Old": "New"}
    ) == "[[Outer]]"


# --- walker pins -------------------------------------------------------
# The bracket depth walk is shared with refs.py (refs.bracket_spans). These
# pin the rewriter's half of the contract -- how the walk is *consumed* --
# so a change to the shared walker cannot quietly alter a rewrite.


def test_descent_reaches_a_title_nested_two_levels_deep():
    assert rewrite_title_refs("[[A [[B [[Old]]]]]]", "Old", "New") == \
        "[[A [[B [[New]]]]]]"


def test_a_replaced_middle_title_swallows_the_ref_nested_inside_it():
    # Outer-wins applies at every depth, not just the top: the middle bracket
    # is replaced whole, so the "Old" inside it is never visited.
    assert rewrite_title_refs_map(
        "[[A [[B [[Old]]]]]]", {"B [[Old]]": "Inner", "Old": "New"}
    ) == "[[A [[Inner]]]]"
    assert rewrite_title_refs_map(
        "[[A [[B [[Old]]]]]]", {"A [[B [[Old]]]]": "Top", "Old": "New"}
    ) == "[[Top]]"


def test_every_sibling_inside_an_unreplaced_title_is_visited():
    assert rewrite_title_refs("[[A [[Old]] B [[Old]]]]", "Old", "New") == \
        "[[A [[New]] B [[New]]]]"


def test_an_unclosed_bracket_does_not_stop_the_scan():
    # The walk gives up on the unbalanced "[[" and resumes one character
    # later, so the balanced ref behind it is still found.
    assert rewrite_title_refs("[[A and [[Old]]", "Old", "New") == \
        "[[A and [[New]]"
    assert rewrite_title_refs("[[Old", "Old", "New") == "[[Old"
    assert rewrite_title_refs("]]Old[[", "Old", "New") == "]]Old[["


def test_a_stray_open_bracket_is_title_text_of_the_ref_that_closes():
    # "[[[Old]]" closes once, so the title is "[Old" -- not "Old".
    assert rewrite_title_refs("[[[Old]]", "Old", "New") == "[[[Old]]"
    assert rewrite_title_refs("[[[Old]]", "[Old", "New") == "[[New]]"


def test_a_trailing_close_bracket_is_left_where_it_was():
    assert rewrite_title_refs("[[Old]]]]", "Old", "New") == "[[New]]]]"


def test_doubled_brackets_nest_rather_than_pair_across():
    assert rewrite_title_refs("[[[[Old]]]]", "Old", "New") == "[[[[New]]]]"
    assert rewrite_title_refs("[[[[Old]]]]", "[[Old]]", "Inner") == "[[Inner]]"


def test_a_hash_bracket_tag_is_rewritten_wherever_the_hash_sits():
    # The "#" is not part of what gets spliced -- it stays put and the
    # bracket run is replaced -- so a "#[[..]]" that no lookbehind would call
    # a tag still keeps its written form.
    assert rewrite_title_refs("a#[[Old]] b", "Old", "New") == "a#[[New]] b"
    assert rewrite_title_refs("[[A #[[Old]]]]", "Old", "New") == \
        "[[A #[[New]]]]"


def test_a_bare_tag_ends_where_a_bracket_run_begins():
    assert rewrite_title_refs("#Old[[Old]]", "Old", "New") == "#New[[New]]"


def test_a_bare_tag_needs_a_boundary_in_front_of_it():
    assert rewrite_title_refs("a#Old b", "Old", "New") == "a#Old b"
    assert rewrite_title_refs("(#Old) b", "Old", "New") == "(#New) b"
    assert rewrite_title_refs("[[A]]#Old", "Old", "New") == "[[A]]#Old"


def test_a_tag_inside_an_unreplaced_title_is_rewritten_at_any_depth():
    assert rewrite_title_refs("[[A [[]] #Old]]", "Old", "New") == \
        "[[A [[]] #New]]"
    assert rewrite_title_refs("[[ #Old]]", "Old", "New") == "[[ #New]]"


def test_block_refs_and_embeds_are_not_bracket_runs():
    assert rewrite_title_refs_map(
        "{{[[embed]]: ((abcdef123))}} [[Old]]",
        {"Old": "New", "embed": "E"},
    ) == "{{[[E]]: ((abcdef123))}} [[New]]"


def test_tag_form_is_chosen_exactly_when_extract_would_read_it_back_as_a_tag():
    # _tag_form() downgrades "#New" to "#[[New]]" for any title the hashtag
    # grammar could not read back. Both sides ask refs, so the two cannot
    # disagree: the bare form is used iff extract() reports that exact title.
    for title in ("New", "a.b", "a/b", "a-b", "New Name", "a]b", "a#b", "a(b"):
        bare = rename._tag_form(title) == f"#{title}"
        read_back = refs.Ref(title, "tag") in refs.extract(f"x #{title}").refs
        assert bare == read_back, title


@pytest.mark.parametrize(
    "case", GRAMMAR_CASES, ids=[c["name"] for c in GRAMMAR_CASES]
)
def test_the_rewriter_reaches_every_ref_the_extractor_reports(case):
    # The importer's title map is keyed by what extract() reported, and it
    # relies on the rewriter finding those same spellings (importer/titles.py
    # documents the invariant). Both sides now read the grammar out of refs,
    # so the fixture that pins extraction pins reachability too: renaming any
    # one reported title must change the text it was reported from.
    text = case["text"]
    for ref in refs.extract(text).refs:
        rewritten = rewrite_title_refs_map(
            text, {ref.title: "Sentinel"}, normalize=normalize_title
        )
        assert rewritten != text, (ref, text)


def test_no_refs_no_change():
    assert rewrite_title_refs("plain text", "Old", "New") == "plain text"


def test_map_rewrites_multiple_titles_simultaneously():
    assert rewrite_title_refs_map(
        "[[ Acme]] and [[Acme ]] plus #Legacy",
        {" Acme": "Acme", "Acme ": "Acme", "Legacy": "New Name"},
    ) == "[[Acme]] and [[Acme]] plus #[[New Name]]"


def test_map_preserves_code_and_attributes_and_ignores_unrelated_casing():
    text = "Legacy:: `[[ Acme]]`\n```\n#Legacy\n```\n[[ Acme]] [[acme]]"
    assert rewrite_title_refs_map(
        text,
        {" Acme": "Acme", "Legacy": "New Name"},
    ) == "New Name:: `[[ Acme]]`\n```\n#Legacy\n```\n[[Acme]] [[acme]]"


def test_map_order_does_not_change_the_result():
    text = "[[ Acme]] [[Acme ]] #Legacy"
    first = rewrite_title_refs_map(
        text,
        {" Acme": "Acme", "Acme ": "Acme", "Legacy": "New Name"},
    )
    second = rewrite_title_refs_map(
        text,
        {"Legacy": "New Name", "Acme ": "Acme", " Acme": "Acme"},
    )
    assert first == "[[Acme]] [[Acme]] #[[New Name]]"
    assert second == first


def test_map_matches_written_spellings_verbatim_by_default():
    # Rename and the title migration key their maps by the stored title, so
    # a ref spelled with control whitespace is not theirs to rewrite.
    text = "Two\tLine:: v and [[Two\nLine]]"
    assert rewrite_title_refs_map(text, {"Two Line": "One"}) == text


def test_map_normalizes_written_spellings_when_given_a_normalizer():
    # The importer's keys come from extract(), which normalizes every title.
    text = "Two\tLine:: v and [[Two\nLine]]"
    assert rewrite_title_refs_map(
        text, {"Two Line": "One"}, normalize=normalize_title
    ) == "One:: v and [[One]]"


def test_map_treats_replacement_values_as_opaque():
    assert rewrite_title_refs_map(
        "[[Old]] and [[Other]]",
        {"Old": "New #Old", "Other": "Old"},
    ) == "[[New #Old]] and [[Old]]"
