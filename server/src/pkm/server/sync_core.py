# pattern: Functional Core
"""Windowing for the sync changes feed. The cursor advances over RAW
journal rows -- next_since is the last row scanned, not the last distinct
entity -- so a client can never skip an entity whose older journal row
fell inside a window that also contained a newer row for something else
(spec section 1, the A@1/B@2/A@100 case).

Also the chunking/reordering helpers hydration uses to replace a
per-entity query with bounded `WHERE x IN (...)` set queries:
chunk_ids splits an id list to stay under SQLite's bound-parameter limit,
hydrate_in_order puts a dict of fetched rows (keyed by id, in whatever
order the batched query returned them) back into the caller's original
order, dropping ids nothing was found for.

missing_parent_uids supports the parent-block closure walk: a
window can ship a block whose parent_uid points at a block only a later
window would otherwise deliver, so the caller walks the parent_uid chain
to a fixpoint, ancestor by ancestor, adding every uid it fetches (found or
not) to `known` before asking again -- that's what makes a cycle or a
dangling parent_uid terminate the walk instead of looping.

tombstone_entities decides which of a window's entities ship as
tombstones. A page or sidebar entry that no longer exists does. A page or
sidebar id is an INTEGER PRIMARY KEY without AUTOINCREMENT, so SQLite
gives the next insert max(id)+1 and deleting the highest id frees it for
reuse: presence in current state does not prove the row
is the entity the window's older rows were about, while a delete row in
the window does. So those two kinds also tombstone on a delete row, and
the live row ships beside the tombstone.

Block uids are never reused by the database (a block recreated under its
old uid is the same block), so a block present now ships live. A block
absent now ships as a tombstone only from the window that holds its
delete row; one whose delete row lies past the window ships nothing yet.
A replica applies block tombstones, cascading each through its local
subtree, only in the window that reaches the journal head, after that
window's upserts; earlier windows' tombstones wait for it. By then every
block the server kept is placed by its own shipped row or sits under an
unchanged chain of blocks the server also kept, so no cascade reaches
it. A per-window cascade would not: an ancestor that moved out of a
deleted subtree and was deleted in a later window ships nothing for its
move (it is absent now), and its descendants' rows never re-ship.
Shipped from an older
live row, a tombstone could run before that move arrives. Every block
delete journals a delete row: the delete trigger fires for cascaded rows
too, and ops_core.JournalBlock marks a uid with no block row deleted."""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass
from typing import NamedTuple, TypeVar

from pkm.contracts.responses import EntityKind, SyncSeq

K = TypeVar("K")
V = TypeVar("V")

# Comfortably under both SQLite's historic default (999 bound parameters)
# and modern builds' raised limit (32766, SQLITE_MAX_VARIABLE_NUMBER) --
# a window can legally carry MAX_LIMIT (5,000) distinct entities and a
# snapshot's block count is unbounded, so hydration chunks every id list
# rather than assuming it fits in one `IN (...)` clause.
CHUNK_SIZE = 500

# Entity kinds keyed by a database-assigned integer id that a later insert
# can take over once the row holding it is deleted.
REUSABLE_ID_KINDS: frozenset[EntityKind] = frozenset({"page", "sidebar"})


def chunk_ids(ids: Sequence[K], size: int = CHUNK_SIZE) -> list[list[K]]:
    return [list(ids[i:i + size]) for i in range(0, len(ids), size)]


def hydrate_in_order(order: Sequence[K], present: Mapping[K, V]) -> list[V]:
    return [present[k] for k in order if k in present]


@dataclass(frozen=True)
class Window:
    next_since: SyncSeq
    entities: tuple[tuple[EntityKind, str], ...]  # unique (kind, entity_id)
    # every (kind, entity_id) with at least one delete row in the window
    tombstoned: frozenset[tuple[EntityKind, str]]


def missing_parent_uids(parent_uids: Iterable[str | None],
                        known: set[str]) -> set[str]:
    """Parent uids referenced but not yet in `known`. `known` is every uid
    already fetched-or-queried this walk (not just found ones) -- callers
    must add the returned set to `known` before computing the next
    frontier, or a cycle/dangling parent_uid re-queries forever."""
    return {p for p in parent_uids if p is not None and p not in known}


class ChangeRow(NamedTuple):
    """One `changes` table row. Named rather than a bare 4-tuple -- two
    adjacent `int` fields either side of the `str` made a positional
    mis-order (e.g. `deleted` and `seq` swapped) silently well-typed."""
    seq: SyncSeq
    kind: EntityKind
    entity_id: str
    deleted: int


def dedupe_window(rows: Sequence[ChangeRow]) -> Window:
    """Rows are seq order."""
    seen: dict[tuple[EntityKind, str], None] = {}  # insertion-ordered set
    deleted_keys: set[tuple[EntityKind, str]] = set()
    last_seq = SyncSeq(0)
    for seq, kind, entity_id, deleted in rows:
        last_seq = seq
        seen.setdefault((kind, entity_id), None)
        if deleted:
            deleted_keys.add((kind, entity_id))
    return Window(next_since=last_seq, entities=tuple(seen),
                  tombstoned=frozenset(deleted_keys))


def tombstone_entities(win: Window,
                       present: Mapping[EntityKind, AbstractSet[str]]
                       ) -> list[tuple[EntityKind, str]]:
    """The window's entities that ship as tombstones, in window order: a
    block absent from current state (`present[kind]`, a missing kind
    counting as empty) with a delete row in the window; a page or sidebar
    entry absent from current state; or a reusable-id entity with a delete
    row in the window even though a live row now holds its id."""
    def ships(k: EntityKind, e: str) -> bool:
        if k in REUSABLE_ID_KINDS:
            return (e not in present.get(k, frozenset())
                    or (k, e) in win.tombstoned)
        return (e not in present.get(k, frozenset())
                and (k, e) in win.tombstoned)
    return [(k, e) for k, e in win.entities if ships(k, e)]


def tombstoned_ids(win: Window, kind: EntityKind) -> list[str]:
    """Ids of `kind` with a delete row in the window, in window order."""
    return [e for k, e in win.entities
            if k == kind and (k, e) in win.tombstoned]
