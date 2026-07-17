from pkm.rename import rewrite_title_refs


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


def test_no_refs_no_change():
    assert rewrite_title_refs("plain text", "Old", "New") == "plain text"
