"""Mapping query results to records, and gathering their `::` cells."""
from __future__ import annotations

from pkm.contracts.ops import BlockUid, OrderIdx, PageId
from pkm.refs import CanonicalTitle
from pkm.server.query_records import (AttrBlock, HolderInfo, ResultBlock,
                                      build_records, record_key)
from pkm.test_data.ids import (canonical_title_of, order_idx_of, page_id_of,
                               uid_of)

_BOOKS = page_id_of(1)
_PAPERS = page_id_of(2)
_BOOKS_TITLE = canonical_title_of("Book/Dune")
_PAPERS_TITLE = canonical_title_of("Papers")


def _result(uid: BlockUid, *, page_id: PageId = _BOOKS,
            parent_uid: BlockUid | None = None,
            attribute: CanonicalTitle | None = None,
            text: str = "") -> ResultBlock:
    title = _BOOKS_TITLE if page_id == _BOOKS else _PAPERS_TITLE
    return ResultBlock(uid=uid, page_id=page_id, page_title=title,
                       parent_uid=parent_uid, text=text, attribute=attribute)


def _page_holder(page_id: PageId = _BOOKS,
                 insert_before_order_idx: OrderIdx | None = None
                 ) -> HolderInfo:
    title = _BOOKS_TITLE if page_id == _BOOKS else _PAPERS_TITLE
    return HolderInfo(key=f"page:{page_id}", kind="page", page_id=page_id,
                      page_title=title, uid=None, row_title=title,
                      insert_before_order_idx=insert_before_order_idx)


def _line_holder(uid: BlockUid, row_title: str, page_id: PageId = _PAPERS,
                 insert_before_order_idx: OrderIdx | None = None
                 ) -> HolderInfo:
    page_title = _BOOKS_TITLE if page_id == _BOOKS else _PAPERS_TITLE
    return HolderInfo(key=f"block:{uid}", kind="line", page_id=page_id,
                      page_title=page_title, uid=uid, row_title=row_title,
                      insert_before_order_idx=insert_before_order_idx)


def _attr(uid: BlockUid, holder: str, text: str, position: int,
          key: str | None = None, child_count: int = 0) -> AttrBlock:
    name = key if key is not None else text.split("::", 1)[0].strip()
    return AttrBlock(uid=uid, holder=holder, key=canonical_title_of(name),
                     text=text, order_idx=order_idx_of(position),
                     child_count=child_count)


_TAGS = canonical_title_of("Tags")
_AUTHOR = canonical_title_of("Author")
_STATUS = canonical_title_of("Reading Status")


def test_top_level_attribute_maps_to_page() -> None:
    r = _result(uid_of("tags_1"), attribute=_TAGS, text="Tags:: #Book")
    key, kind, uid = record_key(r)
    assert (key, kind, uid) == (f"page:{_BOOKS}", "page", None)

    holder = _page_holder(insert_before_order_idx=order_idx_of(30))
    got = build_records(
        [r], {holder.key: holder},
        [_attr(uid_of("tags_1"), holder.key, "Tags:: #Book", 10),
         _attr(uid_of("auth_1"), holder.key, "Author:: Herbert", 20)])
    [rec] = got.records
    assert rec.kind == "page"
    assert rec.key == f"page:{_BOOKS}"
    assert rec.uid is None
    assert rec.row_title == "Book/Dune"
    assert rec.page_id == _BOOKS
    assert rec.page_title == _BOOKS_TITLE
    assert rec.result_uids == [uid_of("tags_1")]
    assert list(rec.cells) == [_TAGS, _AUTHOR]
    assert rec.insert_parent_uid is None
    assert rec.insert_before_order_idx == 30
    assert rec.last_attr_order_idx == 20


def test_nested_attribute_maps_to_parent_line() -> None:
    parent = uid_of("paper_1")
    r = _result(uid_of("ptags_1"), page_id=_PAPERS, parent_uid=parent,
                attribute=_TAGS, text="Tags:: #Paper")
    assert record_key(r) == (f"block:{parent}", "line", parent)

    holder = _line_holder(parent, "Some Paper")
    got = build_records(
        [r], {holder.key: holder},
        [_attr(uid_of("ptags_1"), holder.key, "Tags:: #Paper", 0),
         _attr(uid_of("copy_1"), holder.key, "Local copy:: x", 1)])
    [rec] = got.records
    assert rec.kind == "line"
    assert rec.uid == parent
    assert rec.row_title == "Some Paper"
    assert rec.insert_parent_uid == parent
    assert rec.result_uids == [uid_of("ptags_1")]
    assert rec.cells[canonical_title_of("Local copy")].value == "x"


def test_plain_block_is_its_own_record() -> None:
    plain = uid_of("plain_1")
    nested_plain = _result(plain, page_id=_PAPERS,
                           parent_uid=uid_of("above_1"),
                           text="Read [[Dune]] again")
    assert record_key(nested_plain) == (f"block:{plain}", "line", plain)
    top_plain = _result(plain, page_id=_PAPERS, text="Read [[Dune]] again")
    assert record_key(top_plain) == (f"block:{plain}", "line", plain)

    holder = _line_holder(plain, "Read [[Dune]] again")
    got = build_records([nested_plain], {holder.key: holder}, [])
    [rec] = got.records
    assert rec.uid == plain
    assert rec.row_title == "Read [[Dune]] again"
    assert rec.cells == {}
    assert rec.last_attr_order_idx is None
    assert got.keys == []


def test_two_results_same_record_one_row() -> None:
    a = _result(uid_of("tags_1"), attribute=_TAGS, text="Tags:: #Book")
    b = _result(uid_of("auth_1"), attribute=_AUTHOR, text="Author:: X")
    holder = _page_holder()
    got = build_records(
        [a, b], {holder.key: holder},
        [_attr(uid_of("tags_1"), holder.key, "Tags:: #Book", 0),
         _attr(uid_of("auth_1"), holder.key, "Author:: X", 1)])
    [rec] = got.records
    assert rec.result_uids == [uid_of("tags_1"), uid_of("auth_1")]


def test_records_keep_first_result_order() -> None:
    first = _page_holder(_PAPERS)
    second = _page_holder(_BOOKS)
    got = build_records(
        [_result(uid_of("paper_res_1"), page_id=_PAPERS, attribute=_TAGS),
         _result(uid_of("book_res_1"), page_id=_BOOKS, attribute=_TAGS),
         _result(uid_of("paper_res_2"), page_id=_PAPERS, attribute=_AUTHOR)],
        {first.key: first, second.key: second}, [])
    assert [r.key for r in got.records] == [first.key, second.key]
    assert got.records[0].result_uids == [uid_of("paper_res_1"), uid_of("paper_res_2")]


def test_duplicate_key_first_wins() -> None:
    holder = _page_holder()
    got = build_records(
        [_result(uid_of("tags_1"), attribute=_TAGS)], {holder.key: holder},
        # Given out of order: the lower order_idx wins, not the first given.
        [_attr(uid_of("stat_2"), holder.key, "Reading Status:: Unread", 7,
               child_count=3),
         _attr(uid_of("stat_1"), holder.key, "Reading Status:: Read", 2)])
    [rec] = got.records
    cell = rec.cells[_STATUS]
    assert cell.uid == uid_of("stat_1")
    assert cell.value == "Read"
    assert cell.extra_uids == [uid_of("stat_2")]
    assert cell.child_count == 0
    assert rec.last_attr_order_idx == 7
    assert got.keys[0].count == 1


def test_value_offset() -> None:
    holder = _page_holder()
    text = "Reading Status::  Read"
    got = build_records(
        [_result(uid_of("tags_1"), attribute=_TAGS)], {holder.key: holder},
        [_attr(uid_of("stat_1"), holder.key, text, 0)])
    cell = got.records[0].cells[_STATUS]
    assert cell.text == text
    assert cell.value == "Read"
    assert cell.text[:cell.value_start] == "Reading Status::"
    assert cell.key_raw == "Reading Status"


def test_value_keeps_line_breaks_and_empty_value() -> None:
    holder = _page_holder()
    got = build_records(
        [_result(uid_of("tags_1"), attribute=_TAGS)], {holder.key: holder},
        [_attr(uid_of("note_1"), holder.key, "Notes:: \n first\nsecond ", 0),
         _attr(uid_of("stat_1"), holder.key, "Reading Status::", 1)])
    cells = got.records[0].cells
    assert cells[canonical_title_of("Notes")].value == "first\nsecond "
    status = cells[_STATUS]
    assert status.value == ""
    assert status.value_start == len("Reading Status::")


def test_value_start_skips_indent_and_code_in_value() -> None:
    holder = _page_holder()
    text = "  Author:: `x::y` Herbert"
    got = build_records(
        [_result(uid_of("tags_1"), attribute=_TAGS)], {holder.key: holder},
        [_attr(uid_of("auth_1"), holder.key, text, 0)])
    cell = got.records[0].cells[_AUTHOR]
    assert cell.text[:cell.value_start] == "  Author::"
    assert cell.value == "`x::y` Herbert"
    assert cell.key_raw == "Author"


def test_cell_key_is_the_attribute_page_not_the_spelling() -> None:
    holder = _page_holder()
    got = build_records(
        [_result(uid_of("tags_1"), attribute=_TAGS)], {holder.key: holder},
        [_attr(uid_of("stat_1"), holder.key, "Reading  status:: Read", 0,
               key="Reading Status")])
    cell = got.records[0].cells[_STATUS]
    assert cell.key_raw == "Reading  status"
    assert got.keys[0].key == _STATUS
    assert got.keys[0].label == "Reading  status"


def test_keys_ranked() -> None:
    p1, p2, p3 = (_page_holder(page_id_of(n)) for n in (11, 12, 13))
    holders = {h.key: h for h in (p1, p2, p3)}
    results = [_result(uid_of(f"res_{n}"), page_id=page_id_of(n),
                       attribute=_TAGS) for n in (11, 12, 13)]
    attrs = [
        # Record 1: Tags, Author, Year.
        _attr(uid_of("p1_tags"), p1.key, "Tags:: #Book", 0),
        _attr(uid_of("p1_auth"), p1.key, "author:: A", 1, key="Author"),
        _attr(uid_of("p1_year"), p1.key, "Year:: 1965", 2),
        # Record 2: Pages before Year in its own order; Tags, Year.
        _attr(uid_of("p2_year"), p2.key, "Year:: 1999", 5),
        _attr(uid_of("p2_tags"), p2.key, "Tags:: #Book", 1),
        _attr(uid_of("p2_page"), p2.key, "Pages:: 412", 3),
        # Record 3: Tags, Author (spelled as the page).
        _attr(uid_of("p3_tags"), p3.key, "Tags:: #Book", 0),
        _attr(uid_of("p3_auth"), p3.key, "Author:: B", 1),
    ]
    got = build_records(results, holders, attrs)
    assert [(k.key, k.label, k.count) for k in got.keys] == [
        (_TAGS, "Tags", 3),
        (_AUTHOR, "author", 2),
        (canonical_title_of("Year"), "Year", 2),
        (canonical_title_of("Pages"), "Pages", 1),
    ]


def test_keys_count_records_not_blocks() -> None:
    holder = _page_holder()
    got = build_records(
        [_result(uid_of("tags_1"), attribute=_TAGS)], {holder.key: holder},
        [_attr(uid_of("stat_1"), holder.key, "Reading Status:: Read", 0),
         _attr(uid_of("stat_2"), holder.key, "Reading Status:: Unread", 1)])
    assert [(k.key, k.count) for k in got.keys] == [(_STATUS, 1)]


def test_child_count_carried() -> None:
    holder = _page_holder()
    got = build_records(
        [_result(uid_of("tags_1"), attribute=_TAGS)], {holder.key: holder},
        [_attr(uid_of("note_1"), holder.key, "Notes:: see below", 0,
               child_count=2)])
    assert got.records[0].cells[canonical_title_of("Notes")].child_count == 2


def test_attr_blocks_of_other_holders_stay_out() -> None:
    page = _page_holder(_PAPERS)
    line = _line_holder(uid_of("paper_1"), "Some Paper")
    got = build_records(
        [_result(uid_of("ptop_1"), page_id=_PAPERS, attribute=_TAGS),
         _result(uid_of("ptags_1"), page_id=_PAPERS,
                 parent_uid=uid_of("paper_1"), attribute=_TAGS)],
        {page.key: page, line.key: line},
        [_attr(uid_of("ptop_1"), page.key, "Tags:: #Reading", 0),
         _attr(uid_of("ptags_1"), line.key, "Tags:: #Paper", 0),
         _attr(uid_of("copy_1"), line.key, "Local copy:: x", 1)])
    page_rec, line_rec = got.records
    assert list(page_rec.cells) == [_TAGS]
    assert page_rec.cells[_TAGS].value == "#Reading"
    assert list(line_rec.cells) == [_TAGS, canonical_title_of("Local copy")]
    assert line_rec.last_attr_order_idx == 1
    assert page_rec.last_attr_order_idx == 0


def test_line_without_a_key_gives_no_cell() -> None:
    holder = _page_holder()
    got = build_records(
        [_result(uid_of("tags_1"), attribute=_TAGS)], {holder.key: holder},
        [_attr(uid_of("code_1"), holder.key, "`Author`:: x", 0,
               key="Author")])
    assert got.records[0].cells == {}
    assert got.keys == []


def test_cell_json_leaves_out_empty_extras() -> None:
    holder = _page_holder()
    got = build_records(
        [_result(uid_of("tags_1"), attribute=_TAGS)], {holder.key: holder},
        [_attr(uid_of("stat_1"), holder.key, "Reading Status:: Read", 0),
         _attr(uid_of("stat_2"), holder.key, "Reading Status:: Unread", 1),
         _attr(uid_of("note_1"), holder.key, "Notes:: x", 2, child_count=2)])
    cells = got.records[0].model_dump(mode="json")["cells"]
    assert cells["Reading Status"]["extra_uids"] == ["stat_2"]
    assert "child_count" not in cells["Reading Status"]
    assert cells["Notes"]["child_count"] == 2
    assert "extra_uids" not in cells["Notes"]
