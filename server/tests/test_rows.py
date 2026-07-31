from pkm.edn import parse_edn
from pkm.importer.parse_export import Block, Export, Page, parse_export
from pkm.importer.rows import RECOVERY_PAGE_TITLE, to_rows


def _block(uid, text, children=(), heading=None, open_=True, view_type=None):
    return Block(uid=uid, text=text, heading=heading, view_type=view_type, open=open_,
                 created_at=None, edited_at=None, children=tuple(children))


EXPORT = Export(
    pages=(
        Page("Machine Learning", 1600000000000, 1600000001000, (
            _block("uid-attr1", "Tags:: #AI"),
            _block("uid-head1", "Papers", heading=2, open_=False, children=(
                _block("uid-link1", "read [[Attention]] and [[AI]]"),
            )),
        )),
    ),
    orphan_block_count=0,
    skipped_entities=0,
    attr_counts={},
)


def test_pages_include_implicit_targets():
    rows = to_rows(EXPORT, lambda t: t)
    titles = {r[1] for r in rows.pages}
    assert titles == {"Machine Learning", "Tags", "AI", "Attention"}
    assert rows.implicit_page_count == 3
    ml = next(r for r in rows.pages if r[1] == "Machine Learning")
    assert ml[2] == 1600000000000


def test_block_rows_shape_and_order():
    rows = to_rows(EXPORT, lambda t: t)
    by_uid = {r[0]: r for r in rows.blocks}
    page_id = next(r[0] for r in rows.pages if r[1] == "Machine Learning")
    assert by_uid["uid-attr1"] == ("uid-attr1", page_id, None, 0, "Tags:: #AI",
                                   None, 0, None, None, None)
    assert by_uid["uid-head1"][3] == 1          # order_idx
    assert by_uid["uid-head1"][5] == 2          # heading
    assert by_uid["uid-head1"][6] == 1          # collapsed (open=False)
    assert by_uid["uid-link1"][2] == "uid-head1"  # parent_uid
    uids = [r[0] for r in rows.blocks]
    assert uids.index("uid-head1") < uids.index("uid-link1")  # parent first


def test_numbered_children_view_reaches_the_flat_block_row():
    raw = """#datascript/DB {:schema {:block/children {:db/valueType :db.type/ref, :db/cardinality :db.cardinality/many}}
     :datoms [[1 :node/title "P" 1]
              [1 :block/children 2 1]
              [2 :block/uid "uid-view1" 1]
              [2 :block/string "parent" 1]
              [2 :block/order 0 1]
              [2 :children/view-type :numbered 1]]}"""
    rows = to_rows(parse_export(parse_edn(raw)), lambda t: t)
    assert rows.blocks[0][-1] == "numbered"


def test_refs_rows():
    rows = to_rows(EXPORT, lambda t: t)
    page_ids = {r[1]: r[0] for r in rows.pages}
    assert set(rows.refs) == {
        ("uid-attr1", page_ids["Tags"], "attribute"),
        ("uid-attr1", page_ids["AI"], "tag"),
        ("uid-link1", page_ids["Attention"], "link"),
        ("uid-link1", page_ids["AI"], "link"),
    }


def test_transform_applied_before_extraction():
    rows = to_rows(EXPORT, lambda t: t.replace("[[Attention]]", "[[Rewritten]]"))
    titles = {r[1] for r in rows.pages}
    assert "Rewritten" in titles and "Attention" not in titles


MERMAID_EXPORT = Export(
    pages=(
        Page("Diagrams", None, None, (
            _block("uid-mermaid1", "{{[[mermaid]]}}", children=(
                _block("uid-line1", "flowchart TB"),
                _block("uid-line2", "a --> b"),
            )),
            _block("uid-plain1", "not a diagram, mentions [[mermaid]] in passing"),
            _block("uid-mention1", "{{[[mermaid]]}}"),  # childless mention
        )),
    ),
    orphan_block_count=0,
    skipped_entities=0,
    attr_counts={},
)


def test_mermaid_component_block_becomes_single_fenced_block():
    rows = to_rows(MERMAID_EXPORT, lambda t: t)
    uids = [r[0] for r in rows.blocks]
    assert "uid-line1" not in uids and "uid-line2" not in uids  # children consumed
    by_uid = {r[0]: r for r in rows.blocks}
    assert by_uid["uid-mermaid1"][4] == "```mermaid\nflowchart TB\na --> b\n```"


def test_mermaid_fence_has_no_mermaid_ref():
    rows = to_rows(MERMAID_EXPORT, lambda t: t)
    mermaid_refs_from_fence = [r for r in rows.refs if r[0] == "uid-mermaid1"]
    assert mermaid_refs_from_fence == []


def test_childless_mermaid_mention_is_left_alone():
    rows = to_rows(MERMAID_EXPORT, lambda t: t)
    by_uid = {r[0]: r for r in rows.blocks}
    assert by_uid["uid-mention1"][4] == "{{[[mermaid]]}}"
    page_ids = {r[1]: r[0] for r in rows.pages}
    assert ("uid-mention1", page_ids["mermaid"], "link") in rows.refs


def test_unreferenced_mermaid_subtree_reports_no_preserved_refs():
    rows = to_rows(MERMAID_EXPORT, lambda t: t)
    assert rows.mermaid_preserved_refs == ()


MERMAID_REF_EXPORT = Export(
    pages=(
        Page("Diagrams", None, None, (
            _block("uid-mermaid2", "{{[[mermaid]]}}", children=(
                _block("uid-refline1", "flowchart TB"),
                _block("uid-refline2", "a --> b"),
            )),
            _block("uid-citer", "see ((uid-refline2)) for detail"),
        )),
    ),
    orphan_block_count=0,
    skipped_entities=0,
    attr_counts={},
)


def test_externally_referenced_descendant_prevents_flattening():
    rows = to_rows(MERMAID_REF_EXPORT, lambda t: t)
    by_uid = {r[0]: r for r in rows.blocks}
    # the referenced descendant's own row must survive -- flattening
    # would have dropped it, breaking the ((uid-refline2)) reference
    assert by_uid["uid-refline2"][4] == "a --> b"
    assert by_uid["uid-refline2"][2] == "uid-mermaid2"  # still nested normally
    assert by_uid["uid-refline1"][2] == "uid-mermaid2"
    # the would-be component block is left as an ordinary block, not fenced
    assert by_uid["uid-mermaid2"][4] == "{{[[mermaid]]}}"
    # reported so the affected uid and its referrer are visible
    assert ("uid-refline2", ("uid-citer",)) in rows.mermaid_preserved_refs


MERMAID_INTERNAL_REF_EXPORT = Export(
    pages=(
        Page("Diagrams", None, None, (
            _block("uid-mermaid3", "{{[[mermaid]]}}", children=(
                _block("uid-iline1", "flowchart TB"),
                # references a sibling *within the same subtree* -- this
                # must NOT count as an external reference: the whole
                # subtree (this block included) is dropped together, so
                # nothing outside the flatten ever needed it to resolve
                _block("uid-iline2", "see ((uid-iline1)) for the start node"),
            )),
        )),
    ),
    orphan_block_count=0,
    skipped_entities=0,
    attr_counts={},
)


def test_internal_only_reference_does_not_block_flattening():
    # Guards the `- in_subtree` subtraction in rows.py's walk(): without
    # it, a source uid inside the subtree itself would look "external"
    # and this ordinary, self-contained mermaid diagram would never
    # convert -- a false-positive block on every diagram whose lines
    # cross-reference each other's uids.
    rows = to_rows(MERMAID_INTERNAL_REF_EXPORT, lambda t: t)
    by_uid = {r[0]: r for r in rows.blocks}
    assert by_uid["uid-mermaid3"][4] == (
        "```mermaid\nflowchart TB\nsee ((uid-iline1)) for the start node\n```"
    )
    assert "uid-iline1" not in by_uid and "uid-iline2" not in by_uid
    assert rows.mermaid_preserved_refs == ()


def test_no_recovery_page_when_no_orphans():
    rows = to_rows(EXPORT, lambda t: t)
    assert rows.recovery_page_title is None
    assert RECOVERY_PAGE_TITLE not in {r[1] for r in rows.pages}


ORPHAN_EXPORT = Export(
    pages=(
        Page("Machine Learning", None, None, (
            _block("uid-attr1", "Tags:: #AI"),
        )),
    ),
    orphan_block_count=2,
    orphan_blocks=(
        _block("uid-orphan-root", "orphan root [[AI]]", children=(
            _block("uid-orphan-child", "orphan child"),
        )),
    ),
    skipped_entities=0,
    attr_counts={},
)


def test_orphan_blocks_land_on_a_recovery_page_with_structure_intact():
    rows = to_rows(ORPHAN_EXPORT, lambda t: t)
    assert rows.recovery_page_title == RECOVERY_PAGE_TITLE
    titles = {r[1] for r in rows.pages}
    assert RECOVERY_PAGE_TITLE in titles

    recovery_pid = next(r[0] for r in rows.pages if r[1] == RECOVERY_PAGE_TITLE)
    by_uid = {r[0]: r for r in rows.blocks}
    assert by_uid["uid-orphan-root"][1] == recovery_pid       # page_id
    assert by_uid["uid-orphan-root"][2] is None                # top-level, no parent
    assert by_uid["uid-orphan-child"][2] == "uid-orphan-root"  # nested structure kept
    assert by_uid["uid-orphan-child"][1] == recovery_pid

    # the orphan's own text still runs through ref extraction like any block
    ai_pid = next(r[0] for r in rows.pages if r[1] == "AI")
    assert ("uid-orphan-root", ai_pid, "link") in rows.refs


def test_recovery_page_title_avoids_collision_with_an_existing_page():
    collide = Export(
        pages=(
            Page(RECOVERY_PAGE_TITLE, None, None, (
                _block("uid-real", "a page the user actually made"),
            )),
        ),
        orphan_block_count=1,
        orphan_blocks=(_block("uid-orphan-x", "orphan text"),),
        skipped_entities=0,
        attr_counts={},
    )
    rows = to_rows(collide, lambda t: t)
    assert rows.recovery_page_title == f"{RECOVERY_PAGE_TITLE} (2)"
    titles = [r[1] for r in rows.pages]
    assert titles.count(RECOVERY_PAGE_TITLE) == 1
    assert f"{RECOVERY_PAGE_TITLE} (2)" in titles
    by_uid = {r[0]: r for r in rows.blocks}
    recovery_pid = next(r[0] for r in rows.pages if r[1] == f"{RECOVERY_PAGE_TITLE} (2)")
    assert by_uid["uid-orphan-x"][1] == recovery_pid
