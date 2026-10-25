"""Pure row-grouping helpers. The routes that feed them are covered by
test_backlinks.py, test_query_parity.py, test_todos_endpoint.py and
test_unlinked.py."""
from pkm.contracts.responses import (BacklinkGroup, BlockGroup, ChangedGroup,
                                     ChangedItem, GroupItem)
from pkm.rows import Row
from pkm.server.tree import Ancestors
from pkm.server.grouping import (ChangedRow, group_backlinks, group_by_page,
                                 group_changed)
from pkm.test_data.ids import canonical_title_of, page_id_of, uid_of
from pkm.contracts.ops import BlockUid, PageId


def _block(uid: BlockUid, text: str, page_id: PageId, title_text: str) -> Row:
    return {"uid": uid, "text": text, "page_id": page_id,
            "page_title": canonical_title_of(title_text)}


def _backlink(uid: BlockUid, text: str, page_id: PageId, title_text: str) -> Row:
    return {"uid": uid, "text": text,
            "src_page_id": page_id,
            "src_page_title": canonical_title_of(title_text)}


def test_group_by_page_groups_in_row_order():
    rows = [
        _block(uid_of("tuid-a1"), "t1", page_id_of(4), "Alpha"),
        _block(uid_of("tuid-z1"), "t2", page_id_of(3), "Zulu"),
        _block(uid_of("tuid-z2"), "t3", page_id_of(3), "Zulu"),
    ]

    groups = group_by_page(rows)

    assert all(isinstance(g, BlockGroup) for g in groups)
    assert groups == [
        BlockGroup(page_id=page_id_of(4), page_title=canonical_title_of("Alpha"),
                   items=[GroupItem(uid=uid_of("tuid-a1"), text="t1")]),
        BlockGroup(page_id=page_id_of(3), page_title=canonical_title_of("Zulu"),
                   items=[GroupItem(uid=uid_of("tuid-z1"), text="t2"),
                          GroupItem(uid=uid_of("tuid-z2"), text="t3")]),
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

    assert [g.page_id for g in groups] == [1, 2]
    assert [i.uid for i in groups[0].items] == ["tuid-a1", "tuid-a2"]


def test_group_by_page_of_no_rows():
    assert group_by_page([]) == []


def test_group_backlinks_pure():
    rows = [
        _backlink(uid_of("tuid-x1"), "t1", page_id_of(7), "P1"),
        _backlink(uid_of("tuid-x2"), "t2", page_id_of(7), "P1"),
        _backlink(uid_of("tuid-y1"), "t3", page_id_of(9), "P2"),
    ]
    root, mid = uid_of("tuid-r"), uid_of("tuid-m")
    groups = group_backlinks(rows, Ancestors(
        trails={uid_of("tuid-x1"): [root], uid_of("tuid-x2"): [root, mid]},
        texts={root: "root text", mid: "mid text"}))
    assert [g.page_title for g in groups] == ["P1", "P2"]
    assert all(isinstance(g, BacklinkGroup) for g in groups)
    # each group lists its ancestors once, in first-appearance order, and
    # items name them by position
    assert groups[0].ancestor_texts == ["root text", "mid text"]
    assert [i.ancestors for i in groups[0].items] == [[0], [0, 1]]
    assert groups[1].model_dump(mode="json") == {
        "page_id": 9, "page_title": "P2",
        "items": [{"uid": "tuid-y1", "text": "t3", "breadcrumbs": []}]}


def test_group_changed_pure():
    def row(uid_text: str, page: int, title_text: str) -> ChangedRow:
        return ChangedRow(
            uid=uid_of(uid_text), text="t", page_id=page_id_of(page),
            page_title=canonical_title_of(title_text), created_at=1,
            updated_at=2, status="new")

    groups = group_changed([row("tuid-a", 1, "P1"), row("tuid-b", 2, "P2"),
                            row("tuid-c", 1, "P1")])
    assert all(isinstance(g, ChangedGroup) for g in groups)
    assert [g.page_id for g in groups] == [1, 2]
    assert all(isinstance(i, ChangedItem) for i in groups[0].items)
    assert [i.uid for i in groups[0].items] == ["tuid-a", "tuid-c"]
