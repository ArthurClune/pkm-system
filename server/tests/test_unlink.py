import re
import time
import tracemalloc
from collections.abc import Callable

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from scaling import loop_steps

from pkm import refs, spans, unlink
from pkm.contracts.ops import MAX_LINK_NESTING, BlockUid
from pkm.refs import canonicalize_title, extract, normalize_title
from pkm.unlink import (
    MAX_DELETE_COPY_CHARS,
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


# -- the text limit, judged before copies are built ----------------------

def is_t(raw: str) -> bool:
    return normalize_title(raw) == "T"


TARGET = uid_of("tgt_blk01")
PAGE_A = uid_of("page_blk_a")
PAGE_B = uid_of("page_blk_b")
SRC = uid_of("src_blk01")
OTHER = canonical_title_of("Other")


def _traced[R](run: Callable[[], R]) -> tuple[R, int]:
    """`run()`'s result and the peak bytes it allocated."""
    tracemalloc.start()
    try:
        result = run()
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    return result, peak


def test_inlining_past_the_cap_is_refused_before_the_copies_are_built():
    page = {TARGET: "x" * 200_000}
    source = SourceBlock(SRC, OTHER, " ".join([f"(({TARGET}))"] * 100))
    plan, peak = _traced(lambda: plan_page_delete(is_t, page, [source]))
    assert [b.reason for b in plan.blockers] == ["limit"]
    assert peak < 10 * 200_000  # 20M characters were built before


def test_a_page_block_whose_own_copy_passes_the_cap_blocks_its_referrers():
    page = {PAGE_A: " ".join([f"(({PAGE_B}))"] * 100), PAGE_B: "y" * 200_000}
    source = SourceBlock(SRC, OTHER, f"(({PAGE_A}))")
    plan, peak = _traced(lambda: plan_page_delete(is_t, page, [source]))
    assert [b.reason for b in plan.blockers] == ["limit"]
    assert peak < 10 * 200_000


def test_a_legacy_source_over_the_cap_that_inlines_nothing_new_stays_deletable():
    # level is allowed: only the link goes
    source = SourceBlock(SRC, OTHER, "z" * 1_000_100 + " [[T]]")
    plan = plan_page_delete(is_t, {}, [source])
    assert plan.blockers == () and plan.rewrites[SRC].endswith(" T")


def test_a_projected_limit_outranks_the_rewrite_s_own_blockers():
    # Inlining makes the text an attribute block too long to store: the
    # length is judged before the rewrite it would take to see the rest.
    page = {TARGET: "x" * 1_000_000}
    source = SourceBlock(SRC, OTHER, f"(({TARGET}))y:: v")
    plan = plan_page_delete(is_t, page, [source])
    assert [b.reason for b in plan.blockers] == ["limit"]


def _long_page(blocks: int, long_chars: int) -> dict[BlockUid, str]:
    # one long block, and `blocks` blocks that each refer to it twice:
    # every copy of them is twice the long block
    page: dict[BlockUid, str] = {PAGE_B: "x" * long_chars}
    for i in range(blocks):
        page[uid_of(f"page_blk_{i:04d}")] = f"(({PAGE_B})) (({PAGE_B}))"
    return page


def test_copies_nothing_refers_to_are_never_built():
    page = _long_page(40, 300_000)
    source = SourceBlock(SRC, OTHER, "see [[T]]")
    plan, peak = _traced(lambda: plan_page_delete(is_t, page, [source]))
    assert plan.blockers == () and plan.rewrites[SRC] == "see T"
    # 40 copies of 600,000 characters were built before
    assert peak < 10 * 300_000


def test_a_source_past_the_cap_stops_building_copies_once_it_is_known():
    page = _long_page(40, 300_000)
    refs = " ".join(f"(({uid}))" for uid in page if uid != PAGE_B)
    source = SourceBlock(SRC, OTHER, refs)
    plan, peak = _traced(lambda: plan_page_delete(is_t, page, [source]))
    assert [b.reason for b in plan.blockers] == ["limit"]
    # the copies it refers to come to 24M characters; two pass the cap
    assert peak < 10 * 300_000


def test_copies_that_blank_to_nothing_still_count_toward_the_stop():
    # Each page block's copy splices in a block of 76,000 refs, which the
    # blank pass then empties: the copies cost the cap's worth of work
    # each and come out "". The source must stop fetching them once that
    # work passes the cap, however many it refers to.
    long = uid_of("pgblkCCCC")  # 13 characters a ref: 988,000 in all

    def steps(count: int) -> int:
        page: dict[BlockUid, str] = {long: "c",
                                     PAGE_B: f"(({long}))" * 76_000}
        for i in range(count):
            page[uid_of(f"page_blk_{i:04d}")] = f"(({PAGE_B}))"
        refs = "".join(f"(({uid}))" for uid in page if uid not in (long, PAGE_B))
        source = SourceBlock(SRC, OTHER, refs)
        return loop_steps(unlink, lambda: plan_page_delete(is_t, page, [source]))

    small, large = steps(4), steps(16)
    # Building even one copy loops over its 76,000 refs. The source is
    # refused on the copies' projected lengths before any is built, so all
    # that is left is bookkeeping per ref.
    assert small < 10_000 and large < 10_000, (small, large)


def _blanking_page(count: int) -> dict[BlockUid, str]:
    # page_blk_b splices in 76,000 refs (988,000 characters) that the
    # blank pass then empties; each of `count` blocks refers to it once
    long = uid_of("pgblkCCCC")
    page: dict[BlockUid, str] = {long: "c", PAGE_B: f"(({long}))" * 76_000}
    for i in range(count):
        page[uid_of(f"page_blk_{i:04d}")] = f"(({PAGE_B}))"
    return page


def test_a_delete_s_copies_share_one_budget_across_its_referrers():
    # One referrer per page block: each is within the cap on its own, but
    # together they would have the delete build a copy each.
    def run(count: int):
        page = _blanking_page(count)
        sources = [SourceBlock(uid_of(f"src_blk_{i:04d}"), OTHER,
                               f"((page_blk_{i:04d}))") for i in range(count)]
        plan = None

        def go():
            nonlocal plan
            plan = plan_page_delete(is_t, page, sources)
        steps = loop_steps(unlink, go)
        assert plan is not None
        return steps, plan

    (small, _), (large, plan) = run(8), run(32)
    # Bounded work stays level from 8 to 32 referrers; a copy each grows 4x.
    assert large < 1.5 * small, (small, large)
    within = MAX_DELETE_COPY_CHARS // 988_000
    assert [b.reason for b in plan.blockers] == ["limit"] * (32 - within)
    assert len(plan.rewrites) == within


@pytest.mark.parametrize("fill", ["", "c"])
def test_many_referrers_to_one_ref_heavy_block_cost_one_projection(fill):
    # A page block holding 76,000 refs, and N tiny blocks elsewhere that
    # each refer to it. Its projected length is found once, however many
    # blocks refer to it: summed again per referrer, the work grew with N
    # while the budget counted nothing (an empty fill projects to 0).
    long = uid_of("pgblkCCCC")

    def steps(count: int) -> int:
        page: dict[BlockUid, str] = {long: fill,
                                     PAGE_B: f"(({long}))" * 76_000}
        sources = [SourceBlock(uid_of(f"src_blk_{i:04d}"), OTHER,
                               f"(({PAGE_B}))") for i in range(count)]
        plan = None

        def go():
            nonlocal plan
            plan = plan_page_delete(is_t, page, sources)
        work = loop_steps((unlink, spans), go)
        assert plan is not None and plan.blockers == ()
        assert set(plan.rewrites.values()) == {fill * 76_000}
        return work

    small, large = steps(8), steps(32)
    # the span sum lives in pkm.spans, so both modules are counted
    assert large < 1.5 * small, (small, large)


# -- link nesting, judged on the inlined text before unlinking -----------

OPEN_BLK = uid_of("open_blk01")
CLOSE_BLK = uid_of("close_blk1")
JOIN_BLK = uid_of("join_blk01")
PLAIN_BLK = uid_of("plain_blk1")


def _joining_refs(m: int) -> str:
    # each ref to OPEN_BLK opens 32 runs that only CLOSE_BLK's copies close
    return f"(({OPEN_BLK}))" * m + "[[T]]" + f"(({CLOSE_BLK}))" * m


def _joining_page() -> dict[BlockUid, str]:
    # each block alone is within the nesting cap; copies join them
    return {OPEN_BLK: "[[" * MAX_LINK_NESTING, CLOSE_BLK: "]]" * MAX_LINK_NESTING}


@pytest.mark.parametrize("where", ["source", "page_copy"])
def test_copies_joined_into_one_deep_link_are_refused_before_unlinking(where):
    # Inlined, m refs a side make `[[` x 32m around `[[T]]`, which the
    # unlink peels one layer per pass, each pass reading the whole text:
    # work that grew with the cube of m. The depth is judged first, on the
    # source with its copies inlined or on a page block's copy.
    def run(m: int) -> tuple[int, list[str]]:
        page = _joining_page()
        if where == "source":
            source = SourceBlock(SRC, OTHER, _joining_refs(m))
        else:
            page[JOIN_BLK] = _joining_refs(m)
            source = SourceBlock(SRC, OTHER, f"see (({JOIN_BLK}))")
        plan = None

        def go():
            nonlocal plan
            plan = plan_page_delete(is_t, page, [source])
        work = loop_steps((unlink, refs, spans), go)
        assert plan is not None
        return work, [b.reason for b in plan.blockers]

    (small, _), (large, reasons) = run(5), run(20)
    # four times the text: linear work grows about 4x
    assert large < 6 * small, (small, large)
    assert reasons == ["limit"]


def test_a_legacy_source_nested_past_the_cap_stays_deletable_when_level():
    # level is allowed: the copy adds no depth to a source already past it
    deep = "[[" * 40 + "[[T]]" + "]]" * 40
    page = {PLAIN_BLK: "plain"}
    source = SourceBlock(SRC, OTHER, f"{deep} (({PLAIN_BLK}))")
    plan = plan_page_delete(is_t, page, [source])
    assert plan.blockers == ()
    assert plan.rewrites[SRC] == "T plain"


@pytest.mark.parametrize("link,refused", [("[[T]]", False),
                                          ("[[[[T]]]]", True)])
def test_copies_may_nest_a_source_to_the_cap_and_no_further(link, refused):
    # Judged before unlinking: one level past the cap is refused although
    # the unlink would peel every layer, as the length is judged.
    page = {OPEN_BLK: "[[" * (MAX_LINK_NESTING - 1),
            CLOSE_BLK: "]]" * (MAX_LINK_NESTING - 1)}
    source = SourceBlock(SRC, OTHER, f"(({OPEN_BLK})){link}(({CLOSE_BLK}))")
    plan = plan_page_delete(is_t, page, [source])
    if refused:
        assert [b.reason for b in plan.blockers] == ["limit"]
    else:
        assert plan.blockers == () and plan.rewrites[SRC] == "T"


# -- each unlink pass is linear in its text ------------------------------

@pytest.mark.parametrize("unit", ["[[T]] ", "[a]([[T]]) "])
def test_an_unlink_pass_is_linear_in_the_links_it_removes(unit):
    # A text within every limit, dense with links to the page. Each link
    # once searched the whole text before it for an alias label, and each
    # alias rebuilt the list of spans collected so far: 40,000 links took
    # 23 s, and a million characters of them minutes, under the write
    # lock. The slow path ran in C (a regex), hence a wall-clock bound.
    text = unit * 40_000
    started = time.perf_counter()
    out = unlink_title_refs(text, is_t)
    assert time.perf_counter() - started < 3
    assert out == unit.replace("[[T]]", "T").replace("[a](T)", "a") * 40_000


# The alias label as the prefix search found it, kept as the oracle.
_PREFIX_ALIAS = re.compile(r"\[([^\[\]\n]*)\]\(\Z")


@settings(max_examples=2000, deadline=None)
@given(st.lists(st.sampled_from(["[", "]", "(", ")", "\n", "a", " ", "]("]),
                max_size=12).map("".join), st.data())
def test_the_alias_lookback_finds_the_label_the_prefix_search_did(clean, data):
    end = data.draw(st.integers(0, len(clean)))
    found = _PREFIX_ALIAS.search(clean, 0, end)
    assert unlink._alias_label(clean, end) == (
        None if found is None else found.span(1))
