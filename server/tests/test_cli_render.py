from pkm.cli.render import (render_assets, render_backlinks, render_block,
                            render_groups, render_page, render_search,
                            render_title_migration_apply,
                            render_title_migration_audit)
from pkm.contracts.responses import (AssetSearchPayload, Backlinks,
                                     BlockNode, BlockPayload, GroupsPayload,
                                     PagePayload, QueryPayload, SearchPayload,
                                     TitleMigrationApplyResponse,
                                     TitleMigrationAuditPayload)


def _node(uid, text, children=(), heading=None) -> BlockNode:
    return BlockNode(uid=uid, text=text, heading=heading, view_type=None,
                     collapsed=False, order_idx=0, created_at=None,
                     updated_at=None, children=list(children))


NO_BACKLINKS = {"groups": [], "total_pages": 0, "offset": 0, "limit": 100}
PAGE = PagePayload.model_validate({
    "page": {"id": 1, "title": "Machine Learning", "created_at": None,
             "updated_at": None},
    "blocks": [
        _node("u1", "Tags:: #AI"),
        _node("u2", "Papers", heading=2,
              children=[_node("u3", "[[Attention Is All You Need]]")]),
    ],
    "backlinks": NO_BACKLINKS,
    "block_ref_texts": {},
})


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
    payload = BlockPayload(page=PAGE.page, block=_node("u3", "leaf"),
                           breadcrumbs=["Papers"], block_ref_texts={})
    assert render_block(payload) == (
        "(in: Machine Learning > Papers)\n"
        "\n"
        "- leaf\n")


def _search(**kw) -> SearchPayload:
    return SearchPayload.model_validate(
        {"pages": [{"id": 1, "title": "AI"}],
         "blocks": [{"uid": "u1", "page_title": "ML",
                     "snippet": "…<mark>hit</mark>…"}], **kw})


def test_render_search():
    assert render_search(_search()) == (
        "## Pages\n"
        "- AI\n"
        "\n"
        "## Blocks\n"
        "- [ML] …<mark>hit</mark>…\n")


def test_render_search_empty():
    assert render_search(SearchPayload(pages=[], blocks=[])) == "no results\n"


def test_render_search_compact():
    assert render_search(_search(), compact=True) == (
        "## Pages\n"
        "- AI\n"
        "\n"
        "## Blocks\n"
        "- [ML] ^u1\n")


def test_render_groups_with_uids_and_total():
    payload = GroupsPayload.model_validate(
        {"groups": [{"page_id": 1, "page_title": "AI",
                     "items": [{"uid": "t1", "text": "{{TODO}} x"}]}],
         "total": 1})
    assert render_groups(payload) == (
        "## AI\n"
        "- {{TODO}} x  ^t1\n"
        "\n"
        "(1 total)\n")


def test_render_groups_empty_with_ref_counts_hint():
    payload = QueryPayload(groups=[], total=0,
                           ref_counts={"Meeting": 312, "Databases": 51})
    out = render_groups(payload)
    assert out == ("(0 total)\n"
                   "per-ref block counts: [[Meeting]] 312, [[Databases]] 51\n")


def test_render_groups_no_hint_when_results_exist():
    payload = QueryPayload.model_validate(
        {"groups": [{"page_id": 1, "page_title": "AI",
                     "items": [{"uid": "t1", "text": "x"}]}],
         "total": 1, "ref_counts": {"AI": 1}})
    assert "per-ref" not in render_groups(payload)


def test_render_groups_without_ref_counts_prints_no_hint():
    # /api/todos returns a plain GroupsPayload -- no ref_counts field at
    # all, so an empty result must not try to read one.
    assert render_groups(GroupsPayload(groups=[], total=0)) == "(0 total)\n"


def test_render_backlinks():
    backlinks = Backlinks.model_validate(
        {"groups": [{"page_id": 3, "page_title": "July 7th, 2026",
                     "items": [{"uid": "b4", "text": "Studying",
                                "breadcrumbs": []}]}],
         "total_pages": 1, "offset": 0, "limit": 100})
    assert render_backlinks("Machine Learning", backlinks) == (
        "# Backlinks: Machine Learning (1 pages)\n"
        "\n"
        "## July 7th, 2026\n"
        "- Studying\n")


def test_render_empty_text_block():
    payload = PagePayload.model_validate({
        "page": {"id": 1, "title": "Test", "created_at": None,
                 "updated_at": None},
        "blocks": [_node("u1", "")],  # empty text
        "backlinks": NO_BACKLINKS,
        "block_ref_texts": {},
    })
    assert render_page(payload) == "# Test\n\n-\n"
    assert render_page(payload, include_uids=True) == "# Test\n\n-  ^u1\n"


def test_resolve_ref_texts_inlines_and_keeps_uid():
    from pkm.cli.render import resolve_ref_texts
    from pkm.contracts.responses import BlockRefText
    ref_map = {"u9": BlockRefText(text="the target", page_title="P")}
    assert resolve_ref_texts("see ((u9)) here", ref_map) == \
        'see "the target" ((u9)) here'


def test_resolve_ref_texts_unknown_uid_untouched():
    from pkm.cli.render import resolve_ref_texts
    assert resolve_ref_texts("see ((zz)) here", {}) == "see ((zz)) here"


def test_resolve_ref_texts_nested_and_cyclic():
    from pkm.cli.render import resolve_ref_texts
    from pkm.contracts.responses import BlockRefText
    ref_map = {"a": BlockRefText(text="A says ((b))", page_title="P"),
               "b": BlockRefText(text="B says ((a))", page_title="P")}
    out = resolve_ref_texts("root ((a))", ref_map)
    # a inlined; b inlined inside it; the cyclic ((a)) inside b stays bare
    assert out == 'root "A says "B says ((a))" ((b))" ((a))'


def test_render_page_resolve_refs():
    payload = PagePayload.model_validate(
        {"page": PAGE.page, "blocks": [_node("u1", "see ((u9))")],
         "backlinks": NO_BACKLINKS,
         "block_ref_texts": {"u9": {"text": "target", "page_title": "X"}}})
    out = render_page(payload, resolve_refs=True)
    assert '- see "target" ((u9))\n' in out
    assert "see ((u9))" in render_page(payload)  # default unchanged


def test_render_assets():
    payload = AssetSearchPayload.model_validate({"total": 2, "assets": [
        {"sha256": "ab" * 32, "filename": "graph.png", "mime": "image/png",
         "size": 1234, "created_at": 1753500000000,
         "url": "/assets/" + "ab" * 32 + "/graph.png",
         "description": "a bar chart of revenue", "status": "described",
         "describe_error": None,
         "refs": [{"uid": "u1", "page_title": "Holiday 2026"},
                  {"uid": "u2", "page_title": "July 26th, 2026"}]},
        {"sha256": "cd" * 32, "filename": "raw.png", "mime": "image/png",
         "size": 99, "created_at": None,
         "url": "/assets/" + "cd" * 32 + "/raw.png",
         "description": None, "status": "pending", "describe_error": None,
         "refs": []},
    ]})
    out = render_assets(payload)
    assert "graph.png" in out
    assert "a bar chart of revenue" in out
    assert "/assets/" + "ab" * 32 + "/graph.png" in out
    assert "pending" in out
    assert "  in [[Holiday 2026]] ((u1))" in out
    assert "  in [[July 26th, 2026]] ((u2))" in out
    # unreferenced asset gets no "in [[" line (its ref lines would come
    # after its URL line, i.e. after the LAST "raw.png" occurrence)
    assert "in [[" not in out.split("raw.png")[-1]


def test_render_assets_empty():
    assert render_assets(AssetSearchPayload(total=0, assets=[])) == \
        "no assets found"


def test_render_title_migration_audit_includes_state_group_details_and_merge_order():
    payload = TitleMigrationAuditPayload.model_validate({
        "active": False,
        "digest": "7" * 64,
        "groups": [
            {
                "canonical_title": "Acme",
                "survivor": {"page_id": 10, "title": "Acme"},
                "sources": [
                    {"page_id": 11, "title": " Acme"},
                    {"page_id": 12, "title": "Acme "},
                ],
                "has_clean_twin": True,
                "block_count": 4,
                "inbound_ref_count": 4,
                "sidebar_count": 2,
            },
            {
                "canonical_title": "Beta",
                "survivor": {"page_id": 13, "title": " Beta "},
                "sources": [{"page_id": 14, "title": "Beta "}],
                "has_clean_twin": False,
                "block_count": 2,
                "inbound_ref_count": 2,
                "sidebar_count": 1,
            },
        ],
        "blockers": [{"page_id": 19, "title": "   "}],
    })
    assert render_title_migration_audit(payload) == (
        "# Title migration audit\n"
        "\n"
        "state: blocked\n"
        "digest: " + "7" * 64 + "\n"
        "groups: 2\n"
        "blockers: 1\n"
        "\n"
        "## Acme\n"
        "survivor: [10] \"Acme\"\n"
        "sources:\n"
        "- [11] \" Acme\"\n"
        "- [12] \"Acme \"\n"
        "has clean twin: yes\n"
        "counts: 4 blocks, 4 inbound refs, 2 sidebar entries\n"
        "merge order:\n"
        "- [11] \" Acme\" -> [10] \"Acme\"\n"
        "- [12] \"Acme \" -> [10] \"Acme\"\n"
        "\n"
        "## Beta\n"
        "survivor: [13] \" Beta \"\n"
        "sources:\n"
        "- [14] \"Beta \"\n"
        "has clean twin: no\n"
        "counts: 2 blocks, 2 inbound refs, 1 sidebar entry\n"
        "merge order:\n"
        "- [14] \"Beta \" -> [13] \" Beta \"\n"
        "\n"
        "## Blockers\n"
        "- [19] \"   \"\n"
    )


def test_render_title_migration_audit_empty_explains_that_only_a_reviewed_audit_can_be_applied():
    payload = TitleMigrationAuditPayload(
        active=False,
        digest="1" * 64,
        groups=[],
        blockers=[],
    )
    assert render_title_migration_audit(payload) == (
        "# Title migration audit\n"
        "\n"
        "state: clean\n"
        "digest: " + "1" * 64 + "\n"
        "groups: 0\n"
        "blockers: 0\n"
        "\n"
        "No padded plain-space titles need migration.\n"
        "Apply mode is disabled until you provide an audit digest explicitly.\n"
    )


def test_render_title_migration_audit_active_empty_says_apply_is_unavailable_because_it_is_already_active():
    payload = TitleMigrationAuditPayload(
        active=True,
        digest="2" * 64,
        groups=[],
        blockers=[],
    )
    assert render_title_migration_audit(payload) == (
        "# Title migration audit\n"
        "\n"
        "state: active\n"
        "digest: " + "2" * 64 + "\n"
        "groups: 0\n"
        "blockers: 0\n"
        "\n"
        "No padded plain-space titles need migration.\n"
        "Migration is already active; apply mode is unavailable.\n"
    )


def test_render_title_migration_apply_includes_applied_counts_and_generation():
    payload = TitleMigrationApplyResponse(
        digest="8" * 64,
        groups_applied=2,
        pages_retitled=1,
        pages_merged=3,
        blocks_moved=4,
        blocks_rewritten=3,
        generation="0123456789abcdef0123456789abcdef",
    )
    assert render_title_migration_apply(payload) == (
        "# Title migration applied\n"
        "\n"
        "digest: " + "8" * 64 + "\n"
        "groups applied: 2\n"
        "pages retitled: 1\n"
        "pages merged: 3\n"
        "blocks moved: 4\n"
        "blocks rewritten: 3\n"
        "generation: 0123456789abcdef0123456789abcdef\n"
    )


def test_select_section_and_clip_depth():
    import pytest

    from pkm.cli.render import RenderError, clip_depth, select_section
    blocks = PAGE.blocks
    [sec] = select_section(blocks, "## Papers")
    assert sec.uid == "u2"
    assert select_section(blocks, "Papers")[0].uid == "u2"
    with pytest.raises(RenderError, match="Papers"):
        select_section(blocks, "## Missing")
    clipped = clip_depth(blocks, 1)
    assert clipped[1].children == []
    assert PAGE.blocks[1].children  # original not mutated
