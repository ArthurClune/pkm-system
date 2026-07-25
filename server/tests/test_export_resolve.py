"""Core resolution/rendering for the end-user single-page export (pkm-kplp):
((block refs)) resolved recursively to plain text, {{query: ...}} macros
executed to their matching results. Unlike pkm.export.markdown.render_page
(the backup renderer, untested here -- see test_export_markdown.py), which
keeps the raw query command and one-level, parens-wrapped ref resolution."""
from pkm.export.resolve import (
    QueryResult, QueryResultGroup, QueryResultItem, find_query_macros,
    render_page_resolved, render_query_result, resolve_text)


def node(text, children=()):
    return {"text": text, "children": list(children)}


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
    out = resolve_text("see ((uid_a))", {"uid_a": "the target"}, {})
    assert out == "see the target"


def test_resolve_text_leaves_unknown_ref_raw():
    out = resolve_text("see ((uid_gone))", {}, {})
    assert out == "see ((uid_gone))"


def test_resolve_text_resolves_refs_recursively():
    # a -> b -> c: exporting a's text should show c's actual text inlined,
    # not stop at b's raw ((uid_c)).
    uid_to_text = {
        "uid_b": "b says ((uid_c))",
        "uid_c": "c's own words",
    }
    out = resolve_text("a points to ((uid_b))", uid_to_text, {})
    assert out == "a points to b says c's own words"


def test_resolve_text_caps_ref_recursion_depth():
    # A chain four refs deep must stop resolving at BLOCK_REF_MAX_DEPTH (3):
    # the innermost ref is left raw rather than expanded forever.
    uid_to_text = {
        "uid_1": "one -> ((uid_2))",
        "uid_2": "two -> ((uid_3))",
        "uid_3": "three -> ((uid_4))",
        "uid_4": "four (should not appear)",
    }
    out = resolve_text("start -> ((uid_1))", uid_to_text, {})
    assert "four" not in out
    assert "((uid_4))" in out
    assert "one -> two -> three ->" in out


def test_resolve_text_cyclic_refs_terminate():
    # A <-> B: must not hang, and must eventually fall back to a raw ref
    # once the depth cap is hit.
    uid_to_text = {
        "uid_a": "A loops to ((uid_b))",
        "uid_b": "B loops to ((uid_a))",
    }
    out = resolve_text("root -> ((uid_a))", uid_to_text, {})
    assert out.count("loops to") == 3  # depth cap: 3 successful hops
    assert "((uid_a))" in out or "((uid_b))" in out  # final hop left raw


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
    result = QueryResult(total=1, groups=_groups(("Page A", [("u1", "see ((uid_x))")])))
    out = resolve_text("{{query: {and: [[Tag]]}}}",
                       {"uid_x": "the resolved detail"},
                       {"{and: [[Tag]]}": result})
    assert "the resolved detail" in out
    assert "((uid_x))" not in out


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
            node("see ((uid_a)) and {{query: {and: [[Tag]]}}}")]
    out = render_page_resolved("My Page", tree, {"uid_a": "the target"},
                               {"{and: [[Tag]]}": result})
    assert out.startswith("# My Page\n\n")
    assert "- intro\n" in out
    assert "the target" in out
    assert "hit text" in out
    assert "((uid_a))" not in out
    assert "{{query:" not in out


def test_render_page_resolved_nests_multiline_query_output_under_its_block():
    result = QueryResult(total=1, groups=_groups(("Page A", [("u1", "hit")])))
    tree = [node("{{query: {and: [[Tag]]}}}", [node("child")])]
    out = render_page_resolved("P", tree, {}, {"{and: [[Tag]]}": result})
    lines = out.splitlines()
    # the query's own multi-line rendering is indented like any other
    # multi-line block continuation (render_page's existing convention).
    assert any(line.startswith("- Query:") for line in lines)
    assert any(line.startswith("  - Page A") for line in lines)
    assert any(line.strip() == "- child" for line in lines)
