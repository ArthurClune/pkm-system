from pkm.importer.parse_export import Block, Export, Page
from pkm.importer.rows import to_rows


def _block(uid, text, children=(), heading=None, open_=True):
    return Block(uid=uid, text=text, heading=heading, open=open_,
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
                                   None, 0, None, None)
    assert by_uid["uid-head1"][3] == 1          # order_idx
    assert by_uid["uid-head1"][5] == 2          # heading
    assert by_uid["uid-head1"][6] == 1          # collapsed (open=False)
    assert by_uid["uid-link1"][2] == "uid-head1"  # parent_uid
    uids = [r[0] for r in rows.blocks]
    assert uids.index("uid-head1") < uids.index("uid-link1")  # parent first


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
