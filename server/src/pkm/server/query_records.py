# pattern: Functional Core
"""Query results as records: the rows of a query's table view.

A result maps to its record by `record_key`: a top-level `Key::` line to its
page, a nested one to its parent line, any other block to itself. Records
that several results map to are one row. The shell fetches each record's
`::` lines (a page's top-level ones, a line's direct children) and its
`HolderInfo`; `build_records` turns them into cells and ranks the keys for
the default columns. The table, with its reasons, is the spec's "Records
and rows (queries)" in
docs/superpowers/specs/2026-11-15-tables-and-queries-design.md.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from pkm.contracts.ops import BlockUid, OrderIdx, PageId
from pkm.contracts.responses import KeyStat, QueryRecordModel, RecordCell
from pkm.refs import CanonicalTitle, attribute_title_span, strip_code

RecordKind = Literal["page", "line"]


@dataclass(frozen=True)
class ResultBlock:
    """One query match. `attribute` is the page its leading `Key::` names,
    or None when it has none."""
    uid: BlockUid
    page_id: PageId
    page_title: CanonicalTitle
    parent_uid: BlockUid | None
    text: str
    attribute: CanonicalTitle | None


@dataclass(frozen=True)
class AttrBlock:
    """A `::` line under a record. `holder` is the record's `record_key`,
    and `key` the attribute page its key resolves to."""
    uid: BlockUid
    holder: str
    key: CanonicalTitle
    text: str
    order_idx: OrderIdx
    child_count: int


@dataclass(frozen=True)
class HolderInfo:
    """What the shell knows of a record apart from its `::` lines.
    `row_title` is the page title for a page and the line's text for a line.
    `insert_before_order_idx` is the sibling after the record's last `::`
    line, or its first child when it has none; None when there is no such
    block."""
    key: str
    kind: RecordKind
    page_id: PageId
    page_title: CanonicalTitle
    uid: BlockUid | None
    row_title: str
    insert_before_order_idx: OrderIdx | None


@dataclass(frozen=True)
class RecordsResult:
    records: list[QueryRecordModel]
    keys: list[KeyStat]


def record_key(r: ResultBlock) -> tuple[str, RecordKind, BlockUid | None]:
    """The record `r` belongs to: its key, kind and line uid."""
    if r.attribute is not None:
        if r.parent_uid is None:
            return f"page:{r.page_id}", "page", None
        return f"block:{r.parent_uid}", "line", r.parent_uid
    return f"block:{r.uid}", "line", r.uid


def _cell(first: AttrBlock, extra_uids: list[BlockUid]) -> RecordCell | None:
    span = attribute_title_span(strip_code(first.text), first.text)
    if span is None:
        return None
    return RecordCell(
        uid=first.uid, key_raw=span.raw_title, text=first.text,
        value=first.text[span.end:].lstrip(), value_start=span.end,
        extra_uids=extra_uids, child_count=first.child_count)


def _cells(attrs: list[AttrBlock]) -> dict[CanonicalTitle, RecordCell]:
    """A record's cells in line order. The first line for a key is the
    cell; later ones become its `extra_uids`. A line whose text holds no
    `Key::` (the shell sends only lines with an attribute ref, which are
    read by the same parse) gives no cell."""
    by_key: dict[CanonicalTitle, list[AttrBlock]] = {}
    for a in sorted(attrs, key=lambda a: a.order_idx):
        by_key.setdefault(a.key, []).append(a)
    cells: dict[CanonicalTitle, RecordCell] = {}
    for key, lines in by_key.items():
        cell = _cell(lines[0], [a.uid for a in lines[1:]])
        if cell is not None:
            cells[key] = cell
    return cells


def _ranked_keys(records: list[QueryRecordModel]) -> list[KeyStat]:
    """Keys by how many records hold them, most first; ties in the order
    they first appear, records in order and each record's cells in line
    order. A key's label is its spelling where it first appears."""
    counts: dict[CanonicalTitle, int] = {}
    labels: dict[CanonicalTitle, str] = {}
    for record in records:
        for key, cell in record.cells.items():
            counts[key] = counts.get(key, 0) + 1
            labels.setdefault(key, cell.key_raw)
    # sorted is stable, and counts holds the keys in first-appearance order.
    ranked = sorted(counts, key=lambda k: -counts[k])
    return [KeyStat(key=k, label=labels[k], count=counts[k]) for k in ranked]


def build_records(results: Sequence[ResultBlock],
                  holders: Mapping[str, HolderInfo],
                  attrs: Sequence[AttrBlock]) -> RecordsResult:
    """One record per distinct `record_key` among `results`, in the order
    of each record's first result. `holders` must hold every such key;
    `attrs` are the `::` lines of those records, in any order."""
    result_uids: dict[str, list[BlockUid]] = {}
    for r in results:
        result_uids.setdefault(record_key(r)[0], []).append(r.uid)
    attrs_by_holder: dict[str, list[AttrBlock]] = {}
    for a in attrs:
        attrs_by_holder.setdefault(a.holder, []).append(a)

    records: list[QueryRecordModel] = []
    for key, uids in result_uids.items():
        holder = holders[key]
        own = attrs_by_holder.get(key, [])
        records.append(QueryRecordModel(
            key=key, kind=holder.kind, page_id=holder.page_id,
            page_title=holder.page_title, uid=holder.uid,
            row_title=holder.row_title, result_uids=uids, cells=_cells(own),
            insert_parent_uid=holder.uid if holder.kind == "line" else None,
            insert_before_order_idx=holder.insert_before_order_idx,
            last_attr_order_idx=max((a.order_idx for a in own),
                                    default=None)))
    return RecordsResult(records=records, keys=_ranked_keys(records))
