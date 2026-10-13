import pytest

from pkm.refs import normalize_title
from pkm.unlink import (
    SourceBlock,
    apply_delete_rewrite,
    inline_block_refs,
    plain_copy,
    plan_page_delete,
    unlink_title_refs,
)


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
])
def test_unlink_title_refs(text, expected):
    assert unlink_title_refs(text, is_ai) == expected


def test_inline_block_refs_replaces_ref_and_embed():
    copies = {"uid_x1": "copied"}
    assert inline_block_refs(
        "a ((uid_x1)) b {{embed: ((uid_x1))}} c "
        "{{[[embed]]: ((uid_x1))}} ((uid_y1))", copies
    ) == "a copied b copied c copied ((uid_y1))"


def test_inline_block_refs_ignores_code():
    assert inline_block_refs("`((uid_x1))` ((uid_x1))", {"uid_x1": "c"}) \
        == "`((uid_x1))` c"


def test_plain_copy_strips_marker_attribute_and_newlines():
    assert plain_copy("{{[[TODO]]}} Status:: line one\n  line two") \
        == "line one line two"
    assert plain_copy("a\r\nb") == "a b"


def test_apply_delete_rewrite_composes():
    assert apply_delete_rewrite("[[AI]] ((uid_x1))", is_ai, {"uid_x1": "[[AI]]!"}) \
        == "AI AI!"


def test_plan_counts_and_rewrites():
    plan = plan_page_delete(
        is_ai,
        {"pg_p01": "[[Paper]] about AI", "pg_p02": "inner ((pg_p01))"},
        [
            SourceBlock("src_s1", "Notes", "[[AI]] and ((pg_p01))"),
            SourceBlock("src_s2", "Log", "#AI"),
            SourceBlock("src_s3", "Log", "see ((pg_p02))"),
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
    assert plan.inlined["src_s1"] == {"pg_p01": "[[Paper]] about AI"}


def test_plan_copy_cycle_ends_empty():
    plan = plan_page_delete(
        is_ai,
        {"pg_p01": "a ((pg_p02))", "pg_p02": "b ((pg_p01))"},
        [SourceBlock("src_s1", "N", "x ((pg_p01))")],
    )
    assert plan.rewrites["src_s1"] == "x a b "


def test_blockers_query_and_attribute_position():
    plan = plan_page_delete(is_ai, {}, [
        SourceBlock("q1", "Q", "{{query: {and: [[AI]] [[Paper]]}}}"),
        SourceBlock("a1", "A", "[[AI]]:: value"),
        SourceBlock("ok", "B", "fine [[AI]]"),
    ])
    assert [(b.uid, b.reason) for b in plan.blockers] == [
        ("q1", "query"), ("a1", "attribute")]
    assert plan.rewrites == {"ok": "fine AI"}


def test_blockers_ignore_code():
    plan = plan_page_delete(is_ai, {}, [
        SourceBlock("c1", "C", "`{{query: {and: [[AI]]}}}` [[AI]]")])
    assert plan.blockers == ()
