from datetime import timedelta, timezone

import pytest

from pkm.render import (clip_depth, render_assets, render_backlinks,
                        render_block, render_changed, render_groups,
                        render_page, render_search,
                        render_title_migration_apply,
                        render_title_migration_audit)
from pkm.contracts.responses import (AssetRef, AssetSearchItem,
                                     AssetSearchPayload, BacklinkGroup,
                                     BacklinkItem, Backlinks, BlockGroup,
                                     ChangedGroup, ChangedItem,
                                     GroupItem, SearchBlockHit, SearchPageHit,
                                     TitleMigrationBlocker, TitleMigrationGroup,
                                     TitleMigrationPage,
                                     BlockNode, BlockPayload, BlockRefText,
                                     ChangedPayload, GroupsPayload, PageMeta,
                                     PagePayload, QueryPayload,
                                     SearchPayload, TitleMigrationApplyResponse,
                                     TitleMigrationAuditPayload)
from pkm.test_data.ids import (
    canonical_title_of, malformed_canonical_title, malformed_uid, order_idx_of,
    page_id_of, raw_title_of, sha_of, uid_of)
from pkm.changed import ChangeStatus
from pkm.contracts.ops import BlockUid
from pkm.contracts.titles import CanonicalTitle

TZ = timezone(timedelta(hours=1))


def _node(uid: BlockUid, text, children=(), heading=None) -> BlockNode:
    return BlockNode(uid=uid, text=text, heading=heading, view_type=None,
                     collapsed=False, order_idx=order_idx_of(0), created_at=None,
                     updated_at=None, children=list(children))


NO_BACKLINKS = Backlinks(groups=[], total_pages=0, offset=0, limit=100)


def _meta(title: CanonicalTitle) -> PageMeta:
    return PageMeta(id=page_id_of(1), title=title,
                    created_at=None, updated_at=None)


PAGE = PagePayload(
    page=_meta(canonical_title_of("Machine Learning")),
    blocks=[
        _node(uid_of("tuid-u1"), "Tags:: #AI"),
        _node(uid_of("tuid-u2"), "Papers", heading=2,
              children=[_node(uid_of("tuid-u3"), "[[Attention Is All You Need]]")]),
    ],
    backlinks=NO_BACKLINKS,
    block_ref_texts={},
    block_ref_counts={},
)


def test_render_page_markdown():
    assert render_page(PAGE) == (
        "# Machine Learning\n"
        "\n"
        "- Tags:: #AI\n"
        "- ## Papers\n"
        "  - [[Attention Is All You Need]]\n")


def test_render_page_with_uids():
    out = render_page(PAGE, include_uids=True)
    assert "- Tags:: #AI  ^tuid-u1\n" in out
    assert "  - [[Attention Is All You Need]]  ^tuid-u3\n" in out


def test_render_block_with_breadcrumbs():
    payload = BlockPayload(page=PAGE.page, block=_node(uid_of("tuid-u3"), "leaf"),
                           breadcrumbs=["Papers"], block_ref_texts={})
    assert render_block(payload) == (
        "(in: Machine Learning > Papers)\n"
        "\n"
        "- leaf\n")


def _search() -> SearchPayload:
    return SearchPayload(
        pages=[SearchPageHit(id=page_id_of(1), title=canonical_title_of("AI"))],
        blocks=[SearchBlockHit(uid=uid_of("tuid-u1"),
                               page_title=canonical_title_of("ML"),
                               snippet="…<mark>hit</mark>…")])


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
        "- [ML] ^tuid-u1\n")


def _group(uid_text: str, text: str) -> BlockGroup:
    return BlockGroup(page_id=page_id_of(1), page_title=canonical_title_of("AI"),
                      items=[GroupItem(uid=uid_of(uid_text), text=text)])


def test_render_groups_with_uids_and_total():
    payload = GroupsPayload(
        groups=[_group("tuid-t1", "{{TODO}} x")], total=1)
    assert render_groups(payload) == (
        "## AI\n"
        "- {{TODO}} x  ^tuid-t1\n"
        "\n"
        "(1 total)\n")


def test_render_groups_empty_with_ref_counts_hint():
    payload = QueryPayload(groups=[], total=0,
                           ref_counts={canonical_title_of("Meeting"): 312,
                                       canonical_title_of("Databases"): 51})
    out = render_groups(payload)
    assert out == ("(0 total)\n"
                   "per-ref block counts: [[Meeting]] 312, [[Databases]] 51\n")


def test_render_groups_no_hint_when_results_exist():
    payload = QueryPayload(groups=[_group("tuid-t1", "x")], total=1,
                           ref_counts={canonical_title_of("AI"): 1})
    assert "per-ref" not in render_groups(payload)


def test_render_groups_without_ref_counts_prints_no_hint():
    # /api/todos returns a plain GroupsPayload -- no ref_counts field at
    # all, so an empty result must not try to read one.
    assert render_groups(GroupsPayload(groups=[], total=0)) == "(0 total)\n"


def test_render_backlinks():
    backlinks = Backlinks(
        groups=[BacklinkGroup(
            page_id=page_id_of(3),
            page_title=canonical_title_of("July 7th, 2026"),
            items=[BacklinkItem(uid=uid_of("tuid-b4"), text="Studying",
                                breadcrumbs=[])])],
        total_pages=1, offset=0, limit=100)
    assert render_backlinks(raw_title_of("Machine Learning"), backlinks) == (
        "# Backlinks: Machine Learning (1 pages)\n"
        "\n"
        "## July 7th, 2026\n"
        "- Studying\n")


def test_render_empty_text_block():
    payload = PagePayload(
        page=_meta(canonical_title_of("Test")),
        blocks=[_node(uid_of("tuid-u1"), "")],  # empty text
        backlinks=NO_BACKLINKS,
        block_ref_texts={},
        block_ref_counts={},
    )
    assert render_page(payload) == "# Test\n\n-\n"
    assert render_page(payload, include_uids=True) == "# Test\n\n-  ^tuid-u1\n"


def test_resolve_ref_texts_inlines_and_keeps_uid():
    from pkm.render import resolve_ref_texts
    from pkm.contracts.responses import BlockRefText
    ref_map = {uid_of("uid_u9"):
               BlockRefText(text="the target", page_title=canonical_title_of("P"))}
    assert resolve_ref_texts("see ((uid_u9)) here", ref_map) == \
        'see "the target" ((uid_u9)) here'


def test_resolve_ref_texts_unknown_uid_untouched():
    from pkm.render import resolve_ref_texts
    assert resolve_ref_texts("see ((uid_zz)) here", {}) == "see ((uid_zz)) here"


def test_resolve_ref_texts_nested_and_cyclic():
    from pkm.render import resolve_ref_texts
    from pkm.contracts.responses import BlockRefText
    ref_map = {uid_of("uid_a1"):
               BlockRefText(text="A says ((uid_b1))", page_title=canonical_title_of("P")),
               uid_of("uid_b1"):
               BlockRefText(text="B says ((uid_a1))", page_title=canonical_title_of("P"))}
    out = resolve_ref_texts("root ((uid_a1))", ref_map)
    # a inlined; b inlined inside it; the cyclic ((a)) inside b stays bare
    assert out == 'root "A says "B says ((uid_a1))" ((uid_b1))" ((uid_a1))'


def test_resolve_ref_texts_non_ascii_token_stays_bare():
    # render.py's old pattern was Unicode `\w`, so a non-ASCII token used to
    # resolve here even though refs.py's extractor never recognized it as a
    # block ref. Sharing refs.py's ASCII-only BLOCK_REF_TOKEN closes that
    # gap: a non-ASCII token is left bare, matching every other surface.
    from pkm.render import resolve_ref_texts
    from pkm.contracts.responses import BlockRefText
    ref_map = {malformed_uid("uidé12"):
               BlockRefText(text="unreachable", page_title=canonical_title_of("P"))}
    assert resolve_ref_texts("see ((uidé12)) here", ref_map) == \
        "see ((uidé12)) here"


def test_resolve_ref_texts_32_char_token_resolves():
    # The accepted side of the {6,32} boundary: a 32-char token is still a
    # recognized ref, same as any other length within bounds.
    from pkm.render import resolve_ref_texts
    from pkm.contracts.responses import BlockRefText
    uid32 = uid_of("a" * 32)
    ref_map = {uid32: BlockRefText(text="the target", page_title=canonical_title_of("P"))}
    assert resolve_ref_texts(f"see (({uid32})) here", ref_map) == \
        f'see "the target" (({uid32})) here'


def test_resolve_ref_texts_token_over_32_chars_stays_bare():
    # Bounded at 32 to match UID_RE: a token that long can never have been
    # minted, so it is left as plain text even when the map happens to hold
    # a matching key.
    from pkm.render import resolve_ref_texts
    from pkm.contracts.responses import BlockRefText
    overlong = malformed_uid("a" * 33)
    ref_map = {overlong: BlockRefText(text="unreachable", page_title=canonical_title_of("P"))}
    assert resolve_ref_texts(f"see (({overlong})) here", ref_map) == \
        f"see (({overlong})) here"


def test_render_page_resolve_refs():
    payload = PagePayload(
        page=PAGE.page, blocks=[_node(uid_of("tuid-u1"), "see ((uid_u9))")],
        backlinks=NO_BACKLINKS,
        block_ref_texts={uid_of("uid_u9"): BlockRefText(
            text="target", page_title=canonical_title_of("X"))},
        block_ref_counts={})
    out = render_page(payload, resolve_refs=True)
    assert '- see "target" ((uid_u9))\n' in out
    assert "see ((uid_u9))" in render_page(payload)  # default unchanged


def test_render_assets():
    ab, cd = sha_of("ab" * 32), sha_of("cd" * 32)
    payload = AssetSearchPayload(total=2, assets=[
        AssetSearchItem(
            sha256=ab, filename="graph.png", mime="image/png", size=1234,
            created_at=1753500000000, url=f"/assets/{ab}/graph.png",
            description="a bar chart of revenue", status="described",
            describe_error=None,
            refs=[AssetRef(uid=uid_of("tuid-u1"),
                           page_title=canonical_title_of("Holiday 2026")),
                  AssetRef(uid=uid_of("tuid-u2"),
                           page_title=canonical_title_of("July 26th, 2026"))]),
        AssetSearchItem(
            sha256=cd, filename="raw.png", mime="image/png", size=99,
            created_at=None, url=f"/assets/{cd}/raw.png", description=None,
            status="pending", describe_error=None, refs=[]),
    ])
    out = render_assets(payload)
    assert "graph.png" in out
    assert "a bar chart of revenue" in out
    assert "/assets/" + "ab" * 32 + "/graph.png" in out
    assert "pending" in out
    assert "  in [[Holiday 2026]] ((tuid-u1))" in out
    assert "  in [[July 26th, 2026]] ((tuid-u2))" in out
    # unreferenced asset gets no "in [[" line (its ref lines would come
    # after its URL line, i.e. after the LAST "raw.png" occurrence)
    assert "in [[" not in out.split("raw.png")[-1]


def test_render_assets_empty():
    assert render_assets(AssetSearchPayload(total=0, assets=[])) == \
        "no assets found"


def test_render_title_migration_audit_includes_state_group_details_and_merge_order():
    def page(number: int, title_text: str) -> TitleMigrationPage:
        return TitleMigrationPage(page_id=page_id_of(number),
                                  title=malformed_canonical_title(title_text))

    payload = TitleMigrationAuditPayload(
        active=False,
        digest=sha_of("7" * 64),
        groups=[
            TitleMigrationGroup(
                canonical_title=canonical_title_of("Acme"),
                survivor=page(10, "Acme"),
                sources=[page(11, " Acme"), page(12, "Acme ")],
                has_clean_twin=True,
                block_count=4,
                inbound_ref_count=4,
                sidebar_count=2,
            ),
            TitleMigrationGroup(
                canonical_title=canonical_title_of("Beta"),
                survivor=page(13, " Beta "),
                sources=[page(14, "Beta ")],
                has_clean_twin=False,
                block_count=2,
                inbound_ref_count=2,
                sidebar_count=1,
            ),
        ],
        blockers=[TitleMigrationBlocker(
            page_id=page_id_of(19), title=malformed_canonical_title("Bad #Title"),
            reason="forbidden_syntax")],
    )
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
        "- [19] \"Bad #Title\" (forbidden_syntax)\n"
    )


def test_render_title_migration_audit_empty_explains_that_only_a_reviewed_audit_can_be_applied():
    payload = TitleMigrationAuditPayload(
        active=False,
        digest=sha_of("1" * 64),
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
        digest=sha_of("2" * 64),
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


@pytest.mark.parametrize(
    ("active", "has_group", "has_blocker", "state"),
    [
        (False, True, False, "ready"),
        (False, True, True, "blocked"),
        (True, True, False, "active, ready"),
        (True, False, True, "active, blocked"),
        (True, True, True, "active, blocked"),
    ],
)
def test_render_title_migration_audit_state_says_when_an_active_database_has_work(
        active, has_group, has_blocker, state):
    """A fold rule changed after activation leaves an active database with
    groups to apply; the state must not read as plain "active" then."""
    pair = TitleMigrationGroup(
        canonical_title=canonical_title_of("A B"),
        survivor=TitleMigrationPage(page_id=page_id_of(1),
                                    title=canonical_title_of("A B")),
        sources=[TitleMigrationPage(
            page_id=page_id_of(2),
            title=malformed_canonical_title("A  B"))],
        has_clean_twin=True,
        block_count=0,
        inbound_ref_count=0,
        sidebar_count=0,
    )
    blocker = TitleMigrationBlocker(
        page_id=page_id_of(3), title=malformed_canonical_title("\u3000"),
        reason="all_space")
    payload = TitleMigrationAuditPayload(
        active=active,
        digest=sha_of("3" * 64),
        groups=[pair] if has_group else [],
        blockers=[blocker] if has_blocker else [],
    )

    assert f"\nstate: {state}\n" in render_title_migration_audit(payload)


def test_render_title_migration_apply_includes_applied_counts_and_generation():
    payload = TitleMigrationApplyResponse(
        digest=sha_of("8" * 64),
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


def test_clip_depth_preserves_original_and_copies_requested_depth():
    blocks = PAGE.blocks
    clipped = clip_depth(blocks, 1)
    assert clipped[1].children == []
    assert PAGE.blocks[1].children  # original not mutated


def test_clip_depth_carries_every_field_but_the_clipped_children():
    child = _node(uid_of("tuid-kid"), "kid")
    full = BlockNode(uid=uid_of("tuid-full"), text="t", heading=2,
                     view_type="numbered", collapsed=True,
                     order_idx=order_idx_of(3), created_at=11, updated_at=22,
                     children=[child])
    # a new BlockNode field fails here until this fixture sets it
    assert full.model_fields_set == set(BlockNode.model_fields)
    [shallow] = clip_depth([full], 1)
    assert shallow.children == []
    assert shallow.model_dump(exclude={"children"}) == \
        full.model_dump(exclude={"children"})
    [deep] = clip_depth([full], 2)
    assert deep.children == [child]
    assert deep.model_dump() == full.model_dump()


def _section_blocks() -> list[BlockNode]:
    """Document-order collisions on the text "Notes": a plain block, an
    H3, then two duplicate H2s -- exercises level-aware matching plus
    document-order tie-breaking for both bare and marked specs."""
    return [
        _node(uid_of("tuid-plain"), "Notes"),
        _node(uid_of("tuid-h3"), "Notes", heading=3),
        _node(uid_of("tuid-h2a"), "Notes", heading=2, children=[_node(uid_of("h2a-child"), "first")]),
        _node(uid_of("tuid-h2b"), "Notes", heading=2, children=[_node(uid_of("h2b-child"), "second")]),
        _node(uid_of("papers"), "Papers", heading=2),
    ]


def test_select_section_marked_spec_matches_heading_level_and_text():
    from pkm.render import select_section
    [sec] = select_section(_section_blocks(), "## Notes")
    assert sec.uid == "tuid-h2a"


def test_select_section_marked_spec_selects_different_level_same_text():
    from pkm.render import select_section
    [sec] = select_section(_section_blocks(), "### Notes")
    assert sec.uid == "tuid-h3"


def test_select_section_bare_spec_is_heading_agnostic_and_picks_first_in_document_order():
    from pkm.render import select_section
    [sec] = select_section(_section_blocks(), "Notes")
    assert sec.uid == "tuid-plain"


def test_select_section_miss_lists_available_marked_headings_in_document_order():
    import pytest

    from pkm.render import RenderError, select_section
    with pytest.raises(RenderError) as exc_info:
        select_section(_section_blocks(), "# Notes")
    message = str(exc_info.value)
    headings = message[message.index("headings: ") + len("headings: "):
                       -1].split(", ")
    assert headings == ["### Notes", "## Notes", "## Notes", "## Papers"]
    assert "## Papers" in message


def _changed(since: int, until: int, *, total: int, created_at: int | None,
             updated_at: int | None, status: ChangeStatus) -> ChangedPayload:
    item = ChangedItem(uid=uid_of("tuid-b1"), text="hello", created_at=created_at,
                       updated_at=updated_at, status=status)
    return ChangedPayload(
        groups=[ChangedGroup(page_id=page_id_of(1),
                             page_title=canonical_title_of("AI"), items=[item])],
        total=total, since=since, until=until)


def _ms(dt) -> int:
    return int(dt.timestamp() * 1000)


def test_render_changed_single_day_uses_hhmm():
    from datetime import datetime
    since = _ms(datetime(2026, 9, 24, 0, 0, tzinfo=TZ))
    until = _ms(datetime(2026, 9, 25, 0, 0, tzinfo=TZ))
    when = _ms(datetime(2026, 9, 24, 9, 5, tzinfo=TZ))
    payload = _changed(since, until, total=1, created_at=when,
                       updated_at=when, status="new")
    out = render_changed(payload, TZ)
    assert out == (
        "## AI\n"
        "- [09:05] new: hello  ^tuid-b1\n"
        "\n"
        "(1 total)\n")


def test_render_changed_multi_day_window_includes_date():
    from datetime import datetime
    since = _ms(datetime(2026, 9, 20, 0, 0, tzinfo=TZ))
    until = _ms(datetime(2026, 9, 25, 0, 0, tzinfo=TZ))
    when = _ms(datetime(2026, 9, 24, 9, 5, tzinfo=TZ))
    payload = _changed(since, until, total=1, created_at=None,
                       updated_at=when, status="edited")
    out = render_changed(payload, TZ)
    assert "[2026-09-24 09:05] edited: hello  ^tuid-b1" in out


def test_render_changed_truncation_shows_showing_n_of_m():
    from datetime import datetime
    since = _ms(datetime(2026, 9, 24, 0, 0, tzinfo=TZ))
    until = _ms(datetime(2026, 9, 25, 0, 0, tzinfo=TZ))
    when = _ms(datetime(2026, 9, 24, 9, 5, tzinfo=TZ))
    payload = _changed(since, until, total=5, created_at=when,
                       updated_at=when, status="new")
    out = render_changed(payload, TZ)
    assert "(showing 1 of 5 total)" in out


def test_render_ops_ack_clean_and_skipped():
    from pkm.contracts.responses import OpsAck, SkippedOp
    from pkm.render import render_ops_ack
    assert render_ops_ack(OpsAck(ok=True, ts=1, applied=3)) == "applied 3 ops"
    gone = SkippedOp(index=0, op="move", uid=uid_of("uid_x1"), reason="parent_not_found",
                     note_page=canonical_title_of("September 28th, 2026"))
    assert render_ops_ack(OpsAck(ok=True, ts=1, applied=1, skipped=[gone])) == (
        "warning: skipped 1 of 1 ops; nothing else was applied\n"
        "  move ^uid_x1: parent block not found; noted on"
        " [[September 28th, 2026]]\n"
        "the batch is committed: fix the skipped ops on their own, do not re-run it")
    assert render_ops_ack(OpsAck(ok=True, ts=1, applied=4, skipped=[gone])
                          ).startswith(
        "warning: skipped 1 of 4 ops; the other 3 were applied\n")


def test_render_ops_ack_names_a_cycle_skip():
    # A move nesting a block under its own descendant is skipped
    from pkm.contracts.responses import OpsAck, SkippedOp
    from pkm.render import render_ops_ack
    loop = SkippedOp(index=1, op="move", uid=uid_of("uid_b2"), reason="cycle",
                     note_page=canonical_title_of("September 28th, 2026"))
    assert render_ops_ack(OpsAck(ok=True, ts=1, applied=2, skipped=[loop])
                          ).splitlines()[1] == (
        "  move ^uid_b2: target is the block itself or one of its"
        " descendants; noted on [[September 28th, 2026]]")
