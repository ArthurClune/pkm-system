"""Pure row-grouping helpers. The routes that feed them are covered by
test_backlinks.py, test_query_parity.py, test_todos_endpoint.py and
test_unlinked.py."""
from pkm.contracts.ops import BlockUid, PageId
from pkm.refs import CanonicalTitle, NormalizedTitle
from pkm.rows import Row
from pkm.server.grouping import group_backlinks, group_by_page


def _block(uid: str, text: str, page_id: int, title: str) -> Row:
    return {"uid": BlockUid(uid), "text": text, "page_id": PageId(page_id),
            "page_title": CanonicalTitle(NormalizedTitle(title))}


def _backlink(uid: str, text: str, page_id: int, title: str) -> Row:
    return {"uid": BlockUid(uid), "text": text,
            "src_page_id": PageId(page_id),
            "src_page_title": CanonicalTitle(NormalizedTitle(title))}


def test_group_by_page_groups_in_row_order():
    rows = [
        _block("a1", "t1", 4, "Alpha"),
        _block("z1", "t2", 3, "Zulu"),
        _block("z2", "t3", 3, "Zulu"),
    ]

    assert group_by_page(rows) == [
        {"page_id": 4, "page_title": "Alpha",
         "items": [{"uid": "a1", "text": "t1"}]},
        {"page_id": 3, "page_title": "Zulu",
         "items": [{"uid": "z1", "text": "t2"}, {"uid": "z2", "text": "t3"}]},
    ]


def test_group_by_page_merges_interleaved_rows_into_one_group():
    """Group order is first appearance, and a page seen again later appends
    to its existing group rather than opening a second one -- callers order
    rows by page title, but nothing here depends on that."""
    rows = [
        _block("a1", "t1", 1, "P1"),
        _block("b1", "t2", 2, "P2"),
        _block("a2", "t3", 1, "P1"),
    ]

    groups = group_by_page(rows)

    assert [g["page_id"] for g in groups] == [1, 2]
    assert [i["uid"] for i in groups[0]["items"]] == ["a1", "a2"]


def test_group_by_page_of_no_rows():
    assert group_by_page([]) == []


def test_group_backlinks_pure():
    rows = [
        _backlink("x1", "t1", 7, "P1"),
        _backlink("x2", "t2", 7, "P1"),
        _backlink("y1", "t3", 9, "P2"),
    ]
    groups = group_backlinks(rows, {BlockUid("x2"): ["root text"]})
    assert [g["page_title"] for g in groups] == ["P1", "P2"]
    assert groups[0]["items"][0] == {"uid": "x1", "text": "t1", "breadcrumbs": []}
    assert groups[0]["items"][1]["breadcrumbs"] == ["root text"]
