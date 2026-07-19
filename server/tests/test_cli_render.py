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
