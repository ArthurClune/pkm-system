# pattern: Functional Core
"""The vocabulary of a database row: one key per name a query may return,
typed with its brand, and `row_problems` to check a row against it.

A key keeps one meaning and one nullability everywhere. A column that
differs from the key of the same name reads under an alias (COLUMN_KEYS in
brand_registry.py), and a computed value gets an alias of its own in the
query, so `SELECT COUNT(*) AS n` and `SELECT ... AS page_title` land on
keys here."""
from __future__ import annotations

import re
import types
from collections.abc import Mapping
from typing import (Literal, NamedTuple, NewType, TypedDict, Union, get_args,
                    get_origin, get_type_hints)

from pkm.brand_registry import SHAPES
from pkm.contracts.ops import (BatchId, BlockUid, HeadingLevel, OrderIdx,
                               PageId, RewriteKind, Sha256Hex, SidebarEntryId,
                               SidebarOrderIdx, SyncSeq, ViewType)
from pkm.contracts.responses import EntityKind
from pkm.refs import CanonicalTitle, RefKind

# What blocks.heading holds: a level, NULL, or the 0 Roam's export writes
# for "no heading", which older imports stored as-is. Nothing on the write
# path produces a 0, so it reads as None wherever a row becomes a value.
StoredHeadingLevel = Literal[0, 1, 2, 3]


def heading_level(stored: StoredHeadingLevel | None) -> HeadingLevel | None:
    return None if stored == 0 else stored


class Row(TypedDict, total=False):
    # pages
    page_id: PageId
    title: CanonicalTitle
    created_at: int | None
    updated_at: int | None
    # blocks
    uid: BlockUid
    parent_uid: BlockUid | None
    order_idx: OrderIdx
    text: str
    heading: StoredHeadingLevel | None
    collapsed: int
    view_type: ViewType | None
    # refs, block_refs
    src_block_uid: BlockUid
    target_page_id: PageId
    ref_kind: RefKind
    target_block_uid: BlockUid
    # assets
    sha256: Sha256Hex
    filename: str
    mime: str
    size: int
    description: str | None
    described_at: int | None
    describe_error: str | None
    # sidebar_entries
    sidebar_entry_id: SidebarEntryId
    sidebar_order_idx: SidebarOrderIdx
    # changes
    seq: SyncSeq
    entity_id: str
    deleted: int
    change_page_id: PageId | None
    change_kind: EntityKind
    # applied_batches
    batch_id: BatchId
    request_hash: str
    response: str
    applied_at: int
    # block_rewrites
    base_hash: Sha256Hex
    after_hash: Sha256Hex
    rewrite_kind: RewriteKind
    old_title: str
    new_title: str
    rewrite_created_at: int
    # conflict_headers
    target_uid: BlockUid
    day: str
    header_uid: BlockUid
    # page_deletions
    deleted_at: int
    # sync_meta
    sync_meta_key: str
    sync_meta_value: str
    # Computed by queries, under the alias the query gives them
    n: int
    snippet: str
    page_title: CanonicalTitle
    src_page_id: PageId
    src_page_title: CanonicalTitle
    next_order_idx: OrderIdx
    next_sidebar_order_idx: SidebarOrderIdx
    latest_seq: SyncSeq


class KeySpec(NamedTuple):
    base: type  # str or int
    brand: str | None
    nullable: bool
    # The allowed values of a Literal key, else None.
    literals: tuple[object, ...] | None = None


def _unwrap(hint: object) -> KeySpec:
    nullable = False
    origin = get_origin(hint)
    if origin is Union or origin is types.UnionType:
        members = [a for a in get_args(hint) if a is not type(None)]
        nullable = len(members) != len(get_args(hint))
        (hint,) = members
    brand: str | None = None
    while isinstance(hint, NewType):
        brand = brand or hint.__name__
        hint = hint.__supertype__
    literals: tuple[object, ...] | None = None
    if get_origin(hint) is Literal:
        literals = get_args(hint)
        (hint,) = {type(v) for v in literals}
    assert hint is str or hint is int, hint
    return KeySpec(hint, brand, nullable, literals)


KEYS: dict[str, KeySpec] = {
    key: _unwrap(hint) for key, hint in get_type_hints(Row).items()}

_SHAPE_RES: dict[str, re.Pattern[str]] = {
    brand: re.compile(pattern) for brand, (_, pattern) in SHAPES.items()
    if pattern is not None}


def _value_problem(key: str, spec: KeySpec, value: object) -> str | None:
    if value is None:
        return None if spec.nullable else f"{key}: NULL for a non-null key"
    if isinstance(value, bool):
        return f"{key}: bool {value!r} is not {spec.base.__name__}"
    if not isinstance(value, spec.base):
        return (f"{key}: expected {spec.base.__name__}, "
                f"got {type(value).__name__}")
    if spec.literals is not None and value not in spec.literals:
        allowed = ", ".join(repr(v) for v in spec.literals)
        return (f"{key}: {value!r} is not one of {allowed}; normalise it in "
                f"the query or fix the data")
    shape = _SHAPE_RES.get(spec.brand or "")
    if shape is not None and not shape.fullmatch(str(value)):
        return f"{key}: {value!r} is not a valid {spec.brand}"
    return None


def row_problems(row: Mapping[str, object]) -> list[str]:
    """One message per column that is not a `Row` key or whose value does
    not fit its key; empty when the row is well formed."""
    problems: list[str] = []
    for key, value in row.items():
        spec = KEYS.get(key)
        if spec is None:
            problems.append(f"{key}: not a registered row key")
            continue
        problem = _value_problem(key, spec, value)
        if problem is not None:
            problems.append(problem)
    return problems
