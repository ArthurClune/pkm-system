import pytest

from pkm.refs import canonicalize_title, extract, normalize_title
from pkm.unlink import (
    SourceBlock,
    apply_delete_rewrite,
    inline_block_refs,
    plain_copy,
    plan_page_delete,
    defuse_attribute,
    unlink_stale_refs,
    unlink_title_refs,
)
from pkm.test_data.ids import canonical_title_of, uid_of


def is_ai(raw: str) -> bool:
    return normalize_title(raw) == "AI"


@pytest.mark.parametrize("text,expected", [
    ("see [[AI]] now", "see AI now"),
    ("#AI rules", "AI rules"),
    ("#[[AI]] rules", "AI rules"),
    ("[the field]([[AI]])", "the field"),
    ("[#AI]([[AI]])", "AI"),
    ("[x #AI y]([[AI]]) #AI", "x AI y AI"),
    ("[#Other]([[AI]])", "#Other"),
    ("[[ AI ]]", "[[ AI ]]"),
    ("[[ai]] and [[AI]]", "[[ai]] and AI"),
    ("`[[AI]]` and [[AI]]", "`[[AI]]` and AI"),
    ("Tags:: #AI", "Tags:: AI"),
    ("AI:: value", "AI:: value"),
    ("[[x [[AI]] y]]", "[[x AI y]]"),
    ("[[[[AI]]]]", "AI"),
    ("#[[[[AI]]]] x", "AI x"),
])
def test_unlink_title_refs(text, expected):
    assert unlink_title_refs(text, is_ai) == expected


def test_inline_block_refs_replaces_ref_and_embed():
    copies = {uid_of("uid_x1"): "copied"}
    assert inline_block_refs(
        "a ((uid_x1)) b {{embed: ((uid_x1))}} c "
        "{{[[embed]]: ((uid_x1))}} ((uid_y1))", copies
    ) == "a copied b copied c copied ((uid_y1))"


def test_inline_block_refs_ignores_code():
    assert inline_block_refs("`((uid_x1))` ((uid_x1))", {uid_of("uid_x1"): "c"}) \
        == "`((uid_x1))` c"


def test_plain_copy_strips_marker_attribute_and_newlines():
    assert plain_copy("{{[[TODO]]}} Status:: line one\n  line two") \
        == "line one line two"
    assert plain_copy("a\r\nb") == "a b"


def test_apply_delete_rewrite_composes():
    assert apply_delete_rewrite("[[AI]] ((uid_x1))", is_ai, {uid_of("uid_x1"): "[[AI]]!"}) \
        == "AI AI!"


def test_plan_counts_and_rewrites():
    plan = plan_page_delete(
        is_ai,
        {uid_of("pg_p01"): "[[Paper]] about AI", uid_of("pg_p02"): "inner ((pg_p01))"},
        [
            SourceBlock(uid_of("src_s1"), canonical_title_of("Notes"), "[[AI]] and ((pg_p01))"),
            SourceBlock(uid_of("src_s2"), canonical_title_of("Log"), "#AI"),
            SourceBlock(uid_of("src_s3"), canonical_title_of("Log"), "see ((pg_p02))"),
        ],
    )
    assert plan.rewrites == {
        "src_s1": "AI and [[Paper]] about AI",
        "src_s2": "AI",
        "src_s3": "see inner [[Paper]] about AI",
    }
    assert (plan.links, plan.link_pages) == (2, 2)
    assert (plan.block_refs, plan.block_ref_pages) == (2, 2)
    assert plan.blockers == ()
    assert plan.unlinked == {"src_s1", "src_s2"}
    assert set(plan.inlined) == {"src_s1", "src_s3"}
    assert plan.inlined[uid_of("src_s1")] == {"pg_p01": "[[Paper]] about AI"}


def test_plan_copy_cycle_ends_empty():
    plan = plan_page_delete(
        is_ai,
        {uid_of("pg_p01"): "a ((pg_p02))", uid_of("pg_p02"): "b ((pg_p01))"},
        [SourceBlock(uid_of("src_s1"), canonical_title_of("N"), "x ((pg_p01))")],
    )
    assert plan.rewrites[uid_of("src_s1")] == "x a b "


def test_blockers_query_and_attribute_position():
    plan = plan_page_delete(is_ai, {}, [
        SourceBlock(uid_of("tuid-q1"), canonical_title_of("Q"), "{{query: {and: [[AI]] [[Paper]]}}}"),
        SourceBlock(uid_of("tuid-a1"), canonical_title_of("A"), "[[AI]]:: value"),
        SourceBlock(uid_of("tuid-ok"), canonical_title_of("B"), "fine [[AI]]"),
    ])
    assert [(b.uid, b.reason) for b in plan.blockers] == [
        ("tuid-q1", "query"), ("tuid-a1", "attribute")]
    assert plan.rewrites == {"tuid-ok": "fine AI"}


def test_blockers_ignore_code():
    plan = plan_page_delete(is_ai, {}, [
        SourceBlock(uid_of("tuid-c1"), canonical_title_of("C"), "`{{query: {and: [[AI]]}}}` [[AI]]")])
    assert plan.blockers == ()


def is_ai_plain_space(raw: str) -> bool:
    return canonicalize_title(raw, plain_space=True) == "AI"


def test_unlink_padded_nested_link_under_plain_space():
    assert unlink_title_refs("x [[ [[AI]] ]] y", is_ai_plain_space) \
        == "x  AI  y"


@pytest.mark.parametrize("text", [
    "[[AI]] stuff:: v",
    "[l]([[AI]]):: v",
    "#AI rest:: v",
    "[[AI]] [[AI]]:: v",
    "((pg_p01)):: v",
])
def test_blocker_when_the_rewrite_changes_the_leading_attribute(text):
    plan = plan_page_delete(is_ai, {uid_of("pg_p01"): "copied"}, [
        SourceBlock(uid_of("tuid-a1"), canonical_title_of("A"), text)])
    assert [(b.uid, b.reason) for b in plan.blockers] == [("tuid-a1", "attribute")]
    assert plan.rewrites == {}


def test_unchanged_leading_attribute_is_not_a_blocker():
    plan = plan_page_delete(is_ai, {}, [
        SourceBlock(uid_of("tuid-s1"), canonical_title_of("A"), "Status:: [[AI]]"),
        SourceBlock(uid_of("tuid-s2"), canonical_title_of("A"), "Status:: see #AI"),
    ])
    assert plan.blockers == ()
    assert plan.rewrites == {"tuid-s1": "Status:: AI", "tuid-s2": "Status:: see AI"}


@pytest.mark.parametrize("text", [
    "AI:: value",
    " AI :: value",
    "AI:: see [[AI]]",
    "AI:: ((pg_p01))",
])
def test_blocker_when_the_page_is_used_as_an_attribute(text):
    plan = plan_page_delete(is_ai, {uid_of("pg_p01"): "copied"}, [
        SourceBlock(uid_of("tuid-a1"), canonical_title_of("A"), text),
        SourceBlock(uid_of("tuid-ok"), canonical_title_of("B"), "fine [[AI]]"),
    ])
    assert [(b.uid, b.reason) for b in plan.blockers] == [
        ("tuid-a1", "used_as_attribute")]
    assert plan.rewrites == {"tuid-ok": "fine AI"}


def test_query_naming_the_page_outranks_its_use_as_an_attribute():
    plan = plan_page_delete(is_ai, {}, [
        SourceBlock(uid_of("tuid-q1"), canonical_title_of("Q"), "AI:: {{query: [[AI]]}}")])
    assert [(b.uid, b.reason) for b in plan.blockers] == [("tuid-q1", "query")]


def test_attribute_in_code_is_not_a_blocker():
    plan = plan_page_delete(is_ai, {}, [
        SourceBlock(uid_of("tuid-c1"), canonical_title_of("C"), "`AI`:: value [[AI]]")])
    assert plan.blockers == ()


def test_nested_legacy_links_unlink_to_a_fixpoint_in_the_plan():
    plan = plan_page_delete(is_ai_plain_space, {}, [
        SourceBlock(uid_of("tuid-s1"), canonical_title_of("A"), "[[[[AI]]]]"),
        SourceBlock(uid_of("tuid-s2"), canonical_title_of("A"), "x [[ [[AI]] ]] y"),
    ])
    assert plan.blockers == ()
    assert plan.rewrites == {"tuid-s1": "AI", "tuid-s2": "x  AI  y"}


def test_blocker_when_the_rewrite_still_refs_a_page_block():
    # unlinking `[[AI]]` splices the uid back together into a ref
    plan = plan_page_delete(is_ai, {uid_of("abcdAIxyz"): "copied"}, [
        SourceBlock(uid_of("tuid-s1"), canonical_title_of("A"), "((abcd[[AI]]xyz))")])
    assert [(b.uid, b.reason) for b in plan.blockers] == [("tuid-s1", "residual")]
    assert plan.rewrites == {}


@pytest.mark.parametrize("text,expected", [
    ("X:: v", "`X`:: v"),
    ("  X:: v", "  `X`:: v"),
    ("[[X]]:: v", "`X`:: v"),
    ("#X:: v", "`X`:: v"),
    ("a`b:: v", "a`b:: v"),
    ("a`b`c:: v", "a`b`c:: v"),
    ("Live:: [[X]]", "Live:: X"),
    ("Live:: v", "Live:: v"),
    ("plain [[X]]", "plain X"),
])
def test_unlink_stale_refs_defuses_a_leading_attribute(text, expected):
    result = unlink_stale_refs(text, lambda raw: normalize_title(raw) == "X"
                               or "`" in raw)
    assert result == expected
    assert not any(ref.title == "X" for ref in extract(result).refs)


def test_defuse_attribute_leaves_other_text_alone():
    assert defuse_attribute("see [[X]]", lambda raw: raw == "X") == "see [[X]]"


def test_defuse_attribute_leaves_a_backtick_name_alone():
    # Such a name is no attribute, so there is nothing to fence.
    text = "a`b" + ":" * 5000 + " v"
    assert defuse_attribute(text, lambda raw: "`" in raw) == text
