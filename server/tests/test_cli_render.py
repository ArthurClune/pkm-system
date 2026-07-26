from pkm.cli.render import (render_backlinks, render_block, render_groups,
                            render_page, render_search)


def _node(uid, text, children=(), heading=None):
    return {"uid": uid, "text": text, "heading": heading, "view_type": None,
            "collapsed": False, "order_idx": 0, "created_at": None,
            "updated_at": None, "children": list(children)}


PAGE = {
    "page": {"id": 1, "title": "Machine Learning", "created_at": None,
             "updated_at": None},
    "blocks": [
        _node("u1", "Tags:: #AI"),
        _node("u2", "Papers", heading=2,
              children=[_node("u3", "[[Attention Is All You Need]]")]),
    ],
    "backlinks": {"groups": [], "total_pages": 0, "offset": 0, "limit": 100},
    "block_ref_texts": {},
}


def test_render_page_markdown():
    assert render_page(PAGE) == (
        "# Machine Learning\n"
        "\n"
        "- Tags:: #AI\n"
        "- ## Papers\n"
        "  - [[Attention Is All You Need]]\n")


def test_render_page_with_uids():
    out = render_page(PAGE, include_uids=True)
    assert "- Tags:: #AI  ^u1\n" in out
    assert "  - [[Attention Is All You Need]]  ^u3\n" in out


def test_render_block_with_breadcrumbs():
    payload = {"page": PAGE["page"],
               "block": _node("u3", "leaf"),
               "breadcrumbs": ["Papers"], "block_ref_texts": {}}
    assert render_block(payload) == (
        "(in: Machine Learning > Papers)\n"
        "\n"
        "- leaf\n")


def test_render_search():
    payload = {"pages": [{"id": 1, "title": "AI"}],
               "blocks": [{"uid": "u1", "page_title": "ML",
                           "snippet": "…<mark>hit</mark>…"}]}
    assert render_search(payload) == (
        "## Pages\n"
        "- AI\n"
        "\n"
        "## Blocks\n"
        "- [ML] …<mark>hit</mark>…\n")


def test_render_search_empty():
    assert render_search({"pages": [], "blocks": []}) == "no results\n"


def test_render_groups_with_uids_and_total():
    payload = {"groups": [{"page_id": 1, "page_title": "AI",
                           "items": [{"uid": "t1", "text": "{{TODO}} x"}]}],
               "total": 1}
    assert render_groups(payload) == (
        "## AI\n"
        "- {{TODO}} x  ^t1\n"
        "\n"
        "(1 total)\n")


def test_render_groups_empty_with_ref_counts_hint():
    payload = {"groups": [], "total": 0,
               "ref_counts": {"Meeting": 312, "Databases": 51}}
    out = render_groups(payload)
    assert out == ("(0 total)\n"
                   "per-ref block counts: [[Meeting]] 312, [[Databases]] 51\n")


def test_render_groups_no_hint_when_results_exist():
    payload = {"groups": [{"page_id": 1, "page_title": "AI",
                           "items": [{"uid": "t1", "text": "x"}]}],
               "total": 1, "ref_counts": {"AI": 1}}
    assert "per-ref" not in render_groups(payload)


def test_render_backlinks():
    backlinks = {"groups": [{"page_id": 3, "page_title": "July 7th, 2026",
                             "items": [{"uid": "b4", "text": "Studying",
                                        "breadcrumbs": []}]}],
                 "total_pages": 1, "offset": 0, "limit": 100}
    assert render_backlinks("Machine Learning", backlinks) == (
        "# Backlinks: Machine Learning (1 pages)\n"
        "\n"
        "## July 7th, 2026\n"
        "- Studying\n")


def test_render_empty_text_block():
    payload = {
        "page": {"id": 1, "title": "Test", "created_at": None,
                 "updated_at": None},
        "blocks": [
            _node("u1", ""),  # empty text
        ],
        "backlinks": {"groups": [], "total_pages": 0, "offset": 0, "limit": 100},
        "block_ref_texts": {},
    }
    assert render_page(payload) == "# Test\n\n-\n"
    assert render_page(payload, include_uids=True) == "# Test\n\n-  ^u1\n"


def test_resolve_ref_texts_inlines_and_keeps_uid():
    from pkm.cli.render import resolve_ref_texts
    ref_map = {"u9": {"text": "the target", "page_title": "P"}}
    assert resolve_ref_texts("see ((u9)) here", ref_map) == \
        'see "the target" ((u9)) here'


def test_resolve_ref_texts_unknown_uid_untouched():
    from pkm.cli.render import resolve_ref_texts
    assert resolve_ref_texts("see ((zz)) here", {}) == "see ((zz)) here"


def test_resolve_ref_texts_nested_and_cyclic():
    from pkm.cli.render import resolve_ref_texts
    ref_map = {"a": {"text": "A says ((b))", "page_title": "P"},
               "b": {"text": "B says ((a))", "page_title": "P"}}
    out = resolve_ref_texts("root ((a))", ref_map)
    # a inlined; b inlined inside it; the cyclic ((a)) inside b stays bare
    assert out == 'root "A says "B says ((a))" ((b))" ((a))'


def test_render_page_resolve_refs():
    payload = {"page": PAGE["page"],
               "blocks": [_node("u1", "see ((u9))")],
               "backlinks": PAGE["backlinks"],
               "block_ref_texts": {"u9": {"text": "target",
                                          "page_title": "X"}}}
    out = render_page(payload, resolve_refs=True)
    assert '- see "target" ((u9))\n' in out
    assert "see ((u9))" in render_page(payload)  # default unchanged
