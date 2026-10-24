"""Core resolution/rendering for the end-user single-page export:
((block refs)) resolved recursively to plain text, {{query: ...}} macros
executed to their matching results. Unlike pkm.export.markdown.render_page
(the backup renderer, untested here -- see test_export_markdown.py), which
keeps the raw query command and one-level, parens-wrapped ref resolution."""
import tracemalloc

import pytest
from conftest import tree_node as node
from pkm.export.resolve import (
    EXPORT_MAX_CHARS, ExportTooLarge, QueryResult, QueryResultGroup,
    QueryResultItem, find_query_macros, render_page_resolved,
    render_query_result, resolve_text)
from pkm.test_data.ids import canonical_title_of


# -- find_query_macros --------------------------------------------------

def test_find_query_macros_finds_query_prefix():
    text = "before {{query: {and: [[Foo]]}}} after"
    macros = find_query_macros(text)
    assert len(macros) == 1
    start, end, expr = macros[0]
    assert expr == "{and: [[Foo]]}"
    assert text[start:end] == "{{query: {and: [[Foo]]}}}"


def test_find_query_macros_accepts_bracketed_query_spelling():
    text = "{{[[query]]: {or: [[A]] [[B]]}}}"
    macros = find_query_macros(text)
    assert len(macros) == 1
    assert macros[0][2] == "{or: [[A]] [[B]]}"


def test_find_query_macros_none_when_absent():
    assert find_query_macros("just plain text, no macros here") == []


# -- resolve_text: block refs --------------------------------------------

def test_resolve_text_replaces_known_ref_with_bare_text():
    out = resolve_text("see ((uid_a1))", {"uid_a1": "the target"}, {})
    assert out == "see the target"


def test_resolve_text_resolves_a_32_char_ref():
    # The accepted side of the boundary: a 32-char token still resolves.
    uid32 = "a" * 32
    out = resolve_text(f"see (({uid32}))", {uid32: "the target"}, {})
    assert out == "see the target"


def test_resolve_text_leaves_overlong_ref_raw():
    # Bounded at 32 to match UID_RE: a 33-char token is never recognized as
    # a ((ref)) at all, map entry or not.
    overlong = "a" * 33
    out = resolve_text(f"see (({overlong}))", {overlong: "the target"}, {})
    assert out == f"see (({overlong}))"


def test_resolve_text_leaves_unknown_ref_raw():
    out = resolve_text("see ((uid_gone))", {}, {})
    assert out == "see ((uid_gone))"


def test_resolve_text_resolves_refs_recursively():
    # a -> b -> c: exporting a's text should show c's actual text inlined,
    # not stop at b's raw ((uid_c)).
    uid_to_text = {
        "uid_b1": "b says ((uid_c1))",
        "uid_c1": "c's own words",
    }
    out = resolve_text("a points to ((uid_b1))", uid_to_text, {})
    assert out == "a points to b says c's own words"


def test_resolve_text_caps_ref_recursion_depth():
    # A chain four refs deep must stop resolving at BLOCK_REF_MAX_DEPTH (3):
    # the innermost ref is left raw rather than expanded forever.
    uid_to_text = {
        "uid_01": "one -> ((uid_02))",
        "uid_02": "two -> ((uid_03))",
        "uid_03": "three -> ((uid_04))",
        "uid_04": "four (should not appear)",
    }
    out = resolve_text("start -> ((uid_01))", uid_to_text, {})
    assert "four" not in out
    assert "((uid_04))" in out
    assert "one -> two -> three ->" in out


def test_resolve_text_cyclic_refs_terminate():
    # A <-> B: must not hang, and must eventually fall back to a raw ref
    # once the depth cap is hit.
    uid_to_text = {
        "uid_a1": "A loops to ((uid_b1))",
        "uid_b1": "B loops to ((uid_a1))",
    }
    out = resolve_text("root -> ((uid_a1))", uid_to_text, {})
    assert out.count("loops to") == 3  # depth cap: 3 successful hops
    assert "((uid_a1))" in out or "((uid_b1))" in out  # final hop left raw


# -- resolve_text / render_query_result: queries -------------------------

def _groups(*pages_and_items):
    return tuple(
        QueryResultGroup(page_title=title,
                         items=tuple(QueryResultItem(uid=u, text=t) for u, t in items))
        for title, items in pages_and_items)


def test_render_query_result_lists_grouped_items():
    result = QueryResult(total=2, groups=_groups(
        ("Page A", [("u1", "first match"), ("u2", "second match")])))
    out = render_query_result("{and: [[Tag]]}", result, {}, {}, item_depth=1)
    assert "2 results" in out
    assert "Page A" in out
    assert "first match" in out
    assert "second match" in out


def test_render_query_result_singular_result_count():
    result = QueryResult(total=1, groups=_groups(("Page A", [("u1", "only match")])))
    out = render_query_result("{and: [[Tag]]}", result, {}, {}, item_depth=1)
    assert "1 result" in out
    assert "1 results" not in out


def test_render_query_result_empty_results_says_so():
    result = QueryResult(total=0, groups=())
    out = render_query_result("{and: [[Nowhere]]}", result, {}, {}, item_depth=1)
    assert "0 result" in out
    assert "no matching blocks" in out.lower()


def test_resolve_text_executes_query_macro_when_known():
    result = QueryResult(total=1, groups=_groups(("Page A", [("u1", "matched block")])))
    out = resolve_text("{{query: {and: [[Tag]]}}}",
                       {}, {"{and: [[Tag]]}": result})
    assert "matched block" in out
    assert "{{query:" not in out  # the raw command is gone, not just wrapped


def test_resolve_text_leaves_unknown_query_expr_raw():
    # e.g. a QueryParseError while gathering -- the shell didn't add it to
    # the map, so the export falls back to showing the command verbatim.
    out = resolve_text("{{query: {and: [[Tag]]}}}", {}, {})
    assert out == "{{query: {and: [[Tag]]}}}"


def test_resolve_text_query_item_text_is_itself_resolved():
    # A query result item whose own text contains a ((ref)) must have that
    # ref resolved too -- matching a live reader seeing the fully rendered
    # nested content.
    result = QueryResult(total=1, groups=_groups(("Page A", [("u1", "see ((uid_x1))")])))
    out = resolve_text("{{query: {and: [[Tag]]}}}",
                       {"uid_x1": "the resolved detail"},
                       {"{and: [[Tag]]}": result})
    assert "the resolved detail" in out
    assert "((uid_x1))" not in out


def test_resolve_text_caps_nested_query_depth():
    # Queries nest through two nested result levels: a query one level deep
    # (depth 1) still resolves, but a query two levels deep (depth 2) hits
    # QUERY_MAX_DEPTH and is left as a raw command instead of expanding --
    # matching QueryBlock.tsx's own MAX_DEPTH = 2 cutoff exactly.
    inner_expr = "{and: [[Inner]]}"
    mid_expr = "{and: [[Mid]]}"
    inner_result = QueryResult(total=1, groups=_groups(("Page C", [("u3", "inner hit")])))
    mid_result = QueryResult(total=1, groups=_groups(
        ("Page B", [("u2", f"mid item nested {{{{query: {inner_expr}}}}}")])))
    outer_result = QueryResult(total=1, groups=_groups(
        ("Page A", [("u1", f"outer item nested {{{{query: {mid_expr}}}}}")])))
    out = resolve_text("{{query: {and: [[Outer]]}}}", {},
                       {"{and: [[Outer]]}": outer_result,
                        mid_expr: mid_result,
                        inner_expr: inner_result})
    assert "mid item" in out       # depth 1: still resolves
    assert "inner hit" not in out  # depth 2: capped
    assert "{{query:" in out       # the capped inner command stays raw


# -- render_page_resolved: full page assembly -----------------------------

def test_render_page_resolved_combines_refs_and_queries():
    result = QueryResult(total=1, groups=_groups(("Page A", [("u1", "hit text")])))
    tree = [node("intro"),
            node("see ((uid_a1)) and {{query: {and: [[Tag]]}}}")]
    out = render_page_resolved(canonical_title_of("My Page"), tree, {"uid_a1": "the target"},
                               {"{and: [[Tag]]}": result})
    assert out.startswith("# My Page\n\n")
    assert "- intro\n" in out
    assert "the target" in out
    assert "hit text" in out
    assert "((uid_a1))" not in out
    assert "{{query:" not in out


def test_render_page_resolved_nests_multiline_query_output_under_its_block():
    result = QueryResult(total=1, groups=_groups(("Page A", [("u1", "hit")])))
    tree = [node("{{query: {and: [[Tag]]}}}", [node("child")])]
    out = render_page_resolved(canonical_title_of("P"), tree, {}, {"{and: [[Tag]]}": result})
    lines = out.splitlines()
    # the query's own multi-line rendering is indented like any other
    # multi-line block continuation (render_page's existing convention).
    assert any(line.startswith("- Query:") for line in lines)
    assert any(line.startswith("  - Page A") for line in lines)
    assert any(line.strip() == "- child" for line in lines)


# -- render_page_resolved: the character bound ----------------------------

def _amp(k: int, leaf: str) -> dict[str, str]:
    # The probe's shape: three levels of K refs each over one leaf.
    return {"amp_lvl1": " ".join(["((amp_lvl2))"] * k),
            "amp_lvl2": " ".join(["((amp_lvl3))"] * k),
            "amp_lvl3": leaf}


def _amp_tree(k: int):
    return [node(" ".join(["((amp_lvl1))"] * k))]


def test_the_real_bound_is_ten_million_characters():
    assert EXPORT_MAX_CHARS == 10_000_000


def test_render_page_resolved_refuses_a_k_cubed_fan_out():
    # Uncharged, this is 200**3 * 100 = 800M characters.
    with pytest.raises(ExportTooLarge):
        render_page_resolved(canonical_title_of("Amp"), _amp_tree(200),
                             _amp(200, "Z" * 100), {}, max_chars=10_000)


def _refusal_peak(k: int, max_chars: int) -> int:
    uid_to_text = _amp(k, "Z" * 100)
    tree = _amp_tree(k)
    tracemalloc.start()
    try:
        with pytest.raises(ExportTooLarge):
            render_page_resolved(canonical_title_of("Amp"), tree,
                                 uid_to_text, {}, max_chars=max_chars)
        return tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


def test_a_refused_export_never_builds_a_string_far_past_the_bound():
    # Expansion is built bottom-up, so a bound checked only on the finished
    # body would first build all of it. Charged on the way in, a refusal's
    # peak memory is about the bound plus a term linear in the stored text
    # (measured 1.1x to 1.3x here), and quadrupling K, which multiplies the
    # uncharged output by 64 (to 6.4G characters at K=400), barely moves it.
    max_chars = 1_000_000
    peaks = {k: _refusal_peak(k, max_chars) for k in (100, 200, 400)}
    assert all(peak < 3 * max_chars for peak in peaks.values()), peaks
    assert peaks[400] < 1.5 * peaks[100], peaks


def test_the_bound_is_shared_across_top_level_blocks():
    # Each block renders about 1_000 characters; only their sum is past
    # the bound.
    tree = [node(f"block {i} " + "y" * 1_000) for i in range(50)]
    title = canonical_title_of("Many")
    with pytest.raises(ExportTooLarge):
        render_page_resolved(title, tree, {}, {}, max_chars=10_000)
    out = render_page_resolved(title, tree, {}, {}, max_chars=100_000)
    assert out.count("\n- block ") == 50


def test_query_results_are_charged():
    expr = "{and: [[Tag]]}"
    result = QueryResult(total=3, groups=_groups(
        ("Page A", [(f"u{i}", "((amp_lvl1))") for i in range(3)])))
    tree = [node(f"{{{{query: {expr}}}}}")]
    with pytest.raises(ExportTooLarge):
        render_page_resolved(canonical_title_of("Q"), tree,
                             _amp(50, "Z" * 100), {expr: result},
                             max_chars=10_000)


def _rich_page():
    # Every kind of text the renderer adds: a page header, nested padding,
    # multi-line blocks, multi-line ref text inside a query result, two
    # groups, an empty query, refs left raw, and asset links (which grow by
    # two characters each when rewritten).
    expr, empty = "{and: [[Tag]]}", "{and: [[Nowhere]]}"
    result = QueryResult(total=3, groups=_groups(
        ("Page A", [("u1", "item one\nsecond line ((uid_m1))"),
                    ("u2", "![pic](/assets/a.png)")]),
        ("Page B", [("u3", "see ((uid_m1)) and ((uid_gone))")])))
    uid_to_text = {"uid_m1": "multi\nline ((uid_m2))\n![x](/assets/x.png)",
                   "uid_m2": "deep\ntext"}
    tree = [
        node("intro ![a](/assets/i.png)"),
        node(f"q {{{{query: {expr}}}}} tail\nmore", [
            node("child ((uid_m1))", [node(f"{{{{query: {empty}}}}}")]),
            node("raw {{query: {and: [[Unknown]]}}}")]),
        node("last"),
    ]
    return (canonical_title_of("Rich"), tree, uid_to_text,
            {expr: result, empty: QueryResult(total=0, groups=())})


def test_the_bound_is_exact_on_the_finished_body():
    page = _rich_page()
    body = render_page_resolved(*page)
    n = len(body)
    assert render_page_resolved(*page, max_chars=n) == body
    with pytest.raises(ExportTooLarge):
        render_page_resolved(*page, max_chars=n - 1)
