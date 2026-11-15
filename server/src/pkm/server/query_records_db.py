# pattern: Imperative Shell
"""Read what `query_records.build_records` needs for a query's results.

Every per-record read is one statement per `chunk_ids` chunk of the record
ids, never one per record, so the statements a request runs grow with the
chunk count only. A `::` line is a block with an attribute ref, and its key
is the attribute page's `pages.title`, so two spellings that resolve to one
page are one column. A page record's lines are its top-level ones and a line
record's its direct children: `build_records` trusts `AttrBlock.holder`, so
a deeper `::` line must never be sent under a record. The reads share one
snapshot: `build_records` needs a holder for every result, and a sync write
deleting a result or its record between two statements would leave one
without."""
from __future__ import annotations

from collections.abc import Sequence

from pkm.contracts.ops import BlockUid, OrderIdx, PageId
from pkm.database import Db
from pkm.refs import CanonicalTitle
from pkm.rows import Row
from pkm.server.db import read_txn
from pkm.server.query_exec import iter_plan_rows
from pkm.server.query_records import (AttrBlock, HolderInfo, RecordsResult,
                                      ResultBlock, build_records,
                                      line_record_key, page_record_key,
                                      record_key)
from pkm.server.sync_core import chunk_ids

# A block's attribute page, joined from its one `attribute` ref.
_ATTRIBUTE_JOIN = """JOIN refs r ON r.src_block_uid = c.uid
                       AND r.kind = 'attribute'
                     JOIN pages a ON a.id = r.target_page_id"""


def _marks(chunk: Sequence[object]) -> str:
    return ",".join("?" * len(chunk))


def _result_blocks(db: Db, rows: Sequence[Row]) -> list[ResultBlock]:
    found: dict[BlockUid, Row] = {}
    for chunk in chunk_ids([r["uid"] for r in rows]):
        for r in db.select(
                f"""SELECT c.uid, c.parent_uid, a.title AS attribute_title
                      FROM blocks c
                      LEFT JOIN (refs r JOIN pages a
                                   ON a.id = r.target_page_id)
                        ON r.src_block_uid = c.uid AND r.kind = 'attribute'
                     WHERE c.uid IN ({_marks(chunk)})""", chunk):
            found[r["uid"]] = r
    return [ResultBlock(uid=r["uid"], page_id=r["page_id"],
                        page_title=r["page_title"],
                        parent_uid=found[r["uid"]]["parent_uid"],
                        text=r["text"],
                        attribute=found[r["uid"]]["attribute_title"])
            for r in rows]


def _attr_block(holder: str, r: Row) -> AttrBlock:
    return AttrBlock(uid=r["uid"], holder=holder, key=r["title"],
                     text=r["text"], order_idx=r["order_idx"],
                     child_count=r["n"])


# A `::` line's columns, its child count (`n`) by the parent index.
_ATTR_COLUMNS = """c.uid, c.page_id, c.parent_uid, c.text, c.order_idx,
                   a.title,
                   (SELECT count(*) FROM blocks g
                     WHERE g.parent_uid = c.uid) AS n"""


def _page_attrs(db: Db, page_ids: list[PageId]) -> list[AttrBlock]:
    out: list[AttrBlock] = []
    for chunk in chunk_ids(page_ids):
        out += [_attr_block(page_record_key(r["page_id"]), r) for r in db.select(
            f"""SELECT {_ATTR_COLUMNS} FROM blocks c {_ATTRIBUTE_JOIN}
                 WHERE c.page_id IN ({_marks(chunk)})
                   AND c.parent_uid IS NULL""", chunk)]
    return out


def _line_attrs(db: Db, uids: list[BlockUid]) -> list[AttrBlock]:
    out: list[AttrBlock] = []
    for chunk in chunk_ids(uids):
        for r in db.select(
                f"""SELECT {_ATTR_COLUMNS} FROM blocks c {_ATTRIBUTE_JOIN}
                     WHERE c.parent_uid IN ({_marks(chunk)})""", chunk):
            parent = r["parent_uid"]
            assert parent is not None  # selected by parent_uid
            out.append(_attr_block(line_record_key(parent), r))
    return out


def page_insert_points(db: Db,
                       page_ids: list[PageId]) -> dict[PageId, OrderIdx]:
    """Per page, the top-level block a new `::` line goes before: the one
    after its last top-level `::` line, or its first top-level block when
    it has none. A page with no such block is absent (append)."""
    out: dict[PageId, OrderIdx] = {}
    for chunk in chunk_ids(page_ids):
        marks = _marks(chunk)
        for r in db.select(
                f"""SELECT s.page_id, min(s.order_idx) AS next_order_idx
                      FROM blocks s
                      LEFT JOIN (SELECT c.page_id AS holder,
                                        max(c.order_idx) AS last
                                   FROM blocks c {_ATTRIBUTE_JOIN}
                                  WHERE c.page_id IN ({marks})
                                    AND c.parent_uid IS NULL
                                  GROUP BY c.page_id) l
                        ON l.holder = s.page_id
                     WHERE s.page_id IN ({marks}) AND s.parent_uid IS NULL
                       AND (l.last IS NULL OR s.order_idx > l.last)
                     GROUP BY s.page_id""", [*chunk, *chunk]):
            out[r["page_id"]] = r["next_order_idx"]
    return out


def line_insert_points(db: Db,
                       uids: list[BlockUid]) -> dict[BlockUid, OrderIdx]:
    """`page_insert_points` for line records: the child after a line's last
    `::` child, or its first child when it has none."""
    out: dict[BlockUid, OrderIdx] = {}
    for chunk in chunk_ids(uids):
        marks = _marks(chunk)
        for r in db.select(
                f"""SELECT s.parent_uid, min(s.order_idx) AS next_order_idx
                      FROM blocks s
                      LEFT JOIN (SELECT c.parent_uid AS holder,
                                        max(c.order_idx) AS last
                                   FROM blocks c {_ATTRIBUTE_JOIN}
                                  WHERE c.parent_uid IN ({marks})
                                  GROUP BY c.parent_uid) l
                        ON l.holder = s.parent_uid
                     WHERE s.parent_uid IN ({marks})
                       AND (l.last IS NULL OR s.order_idx > l.last)
                     GROUP BY s.parent_uid""", [*chunk, *chunk]):
            parent = r["parent_uid"]
            assert parent is not None  # selected by parent_uid
            out[parent] = r["next_order_idx"]
    return out


def _lines(db: Db, uids: list[BlockUid]) -> list[Row]:
    out: list[Row] = []
    for chunk in chunk_ids(uids):
        out += db.select(
            f"""SELECT b.uid, b.text, b.page_id, p.title AS page_title
                  FROM blocks b JOIN pages p ON p.id = b.page_id
                 WHERE b.uid IN ({_marks(chunk)})""", chunk)
    return out


def _holders(db: Db, results: Sequence[ResultBlock]
             ) -> tuple[dict[str, HolderInfo], list[AttrBlock]]:
    pages: dict[PageId, CanonicalTitle] = {}
    lines: list[BlockUid] = []
    for res in results:
        _, kind, line = record_key(res)
        if kind == "page":
            pages[res.page_id] = res.page_title
        elif line is not None:
            lines.append(line)
    page_ids = list(pages)
    line_uids = list(dict.fromkeys(lines))

    holders: dict[str, HolderInfo] = {}
    page_points = page_insert_points(db, page_ids)
    for page_id, title in pages.items():
        key = page_record_key(page_id)
        holders[key] = HolderInfo(
            key=key, kind="page", page_id=page_id, page_title=title, uid=None,
            row_title=title, insert_before_order_idx=page_points.get(page_id))
    line_points = line_insert_points(db, line_uids)
    for r in _lines(db, line_uids):
        key = line_record_key(r["uid"])
        holders[key] = HolderInfo(
            key=key, kind="line", page_id=r["page_id"],
            page_title=r["page_title"], uid=r["uid"], row_title=r["text"],
            insert_before_order_idx=line_points.get(r["uid"]))
    return holders, _page_attrs(db, page_ids) + _line_attrs(db, line_uids)


def fetch_records(db: Db, sql: str, params: Sequence[str]) -> RecordsResult:
    """The records of a `query.plan_sql` plan, in its result order, with the
    query's own macro blocks left out as `/api/query` leaves them out."""
    with read_txn(db):
        results = _result_blocks(db, list(iter_plan_rows(db, sql, params)))
        holders, attrs = _holders(db, results)
    return build_records(results, holders, attrs)
