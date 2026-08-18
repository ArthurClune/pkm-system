"""Pure row-grouping helpers. The routes that feed them are covered by
test_backlinks.py, test_query_parity.py, test_todos_endpoint.py and
test_unlinked.py."""
from pkm.server.grouping import group_backlinks, group_by_page


def test_group_by_page_groups_in_row_order():
    rows = [
        {"uid": "a1", "text": "t1", "page_id": 4, "page_title": "Alpha"},
        {"uid": "z1", "text": "t2", "page_id": 3, "page_title": "Zulu"},
        {"uid": "z2", "text": "t3", "page_id": 3, "page_title": "Zulu"},
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
        {"uid": "a1", "text": "t1", "page_id": 1, "page_title": "P1"},
        {"uid": "b1", "text": "t2", "page_id": 2, "page_title": "P2"},
        {"uid": "a2", "text": "t3", "page_id": 1, "page_title": "P1"},
    ]

    groups = group_by_page(rows)

    assert [g["page_id"] for g in groups] == [1, 2]
    assert [i["uid"] for i in groups[0]["items"]] == ["a1", "a2"]


def test_group_by_page_of_no_rows():
    assert group_by_page([]) == []


def test_group_backlinks_pure():
    rows = [
        {"uid": "x1", "text": "t1", "src_page_id": 7, "src_page_title": "P1"},
        {"uid": "x2", "text": "t2", "src_page_id": 7, "src_page_title": "P1"},
        {"uid": "y1", "text": "t3", "src_page_id": 9, "src_page_title": "P2"},
    ]
    groups = group_backlinks(rows, {"x2": ["root text"]})
    assert [g["page_title"] for g in groups] == ["P1", "P2"]
    assert groups[0]["items"][0] == {"uid": "x1", "text": "t1", "breadcrumbs": []}
    assert groups[0]["items"][1]["breadcrumbs"] == ["root text"]
