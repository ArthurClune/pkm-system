"""Pure row-grouping helpers. The routes that feed them are covered by
test_backlinks.py, test_query_parity.py, test_todos_endpoint.py and
test_unlinked.py."""
from pkm.rows import Row
from pkm.server.grouping import group_backlinks, group_by_page
from pkm.test_data.ids import canonical_title_of, page_id_of, uid_of
from pkm.contracts.ops import BlockUid, PageId


def _block(uid: BlockUid, text: str, page_id: PageId, title: str) -> Row:
    return {"uid": uid, "text": text, "page_id": page_id,
            "page_title": canonical_title_of(title)}


def _backlink(uid: BlockUid, text: str, page_id: PageId, title: str) -> Row:
    return {"uid": uid, "text": text,
            "src_page_id": page_id,
            "src_page_title": canonical_title_of(title)}


def test_group_by_page_groups_in_row_order():
    rows = [
        _block(uid_of("tuid-a1"), "t1", page_id_of(4), "Alpha"),
        _block(uid_of("tuid-z1"), "t2", page_id_of(3), "Zulu"),
        _block(uid_of("tuid-z2"), "t3", page_id_of(3), "Zulu"),
    ]

    assert group_by_page(rows) == [
        {"page_id": 4, "page_title": "Alpha",
         "items": [{"uid": "tuid-a1", "text": "t1"}]},
        {"page_id": 3, "page_title": "Zulu",
         "items": [{"uid": "tuid-z1", "text": "t2"}, {"uid": "tuid-z2", "text": "t3"}]},
    ]


def test_group_by_page_merges_interleaved_rows_into_one_group():
    """Group order is first appearance, and a page seen again later appends
    to its existing group rather than opening a second one -- callers order
    rows by page title, but nothing here depends on that."""
    rows = [
        _block(uid_of("tuid-a1"), "t1", page_id_of(1), "P1"),
        _block(uid_of("tuid-b1"), "t2", page_id_of(2), "P2"),
        _block(uid_of("tuid-a2"), "t3", page_id_of(1), "P1"),
    ]

    groups = group_by_page(rows)

    assert [g["page_id"] for g in groups] == [1, 2]
    assert [i["uid"] for i in groups[0]["items"]] == ["tuid-a1", "tuid-a2"]


def test_group_by_page_of_no_rows():
    assert group_by_page([]) == []


def test_group_backlinks_pure():
    rows = [
        _backlink(uid_of("tuid-x1"), "t1", page_id_of(7), "P1"),
        _backlink(uid_of("tuid-x2"), "t2", page_id_of(7), "P1"),
        _backlink(uid_of("tuid-y1"), "t3", page_id_of(9), "P2"),
    ]
    groups = group_backlinks(rows, {uid_of("tuid-x2"): ["root text"]})
    assert [g["page_title"] for g in groups] == ["P1", "P2"]
    assert groups[0]["items"][0] == {"uid": "tuid-x1", "text": "t1", "breadcrumbs": []}
    assert groups[0]["items"][1]["breadcrumbs"] == ["root text"]
