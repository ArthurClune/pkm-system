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
tombstones. A block that no longer exists does. A page or sidebar id is
an INTEGER PRIMARY KEY without AUTOINCREMENT, so SQLite gives the next
insert max(id)+1 and deleting the highest id frees it for reuse:
presence in current state does not prove the row
is the entity the window's older rows were about, while a delete row in
the window does. So those two kinds also tombstone on a delete row, and
the live row ships beside the tombstone. Block uids are never reused by
the database (a block recreated under its old uid is the same block), so
blocks keep the presence rule."""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass
from typing import TypeVar

from pkm.contracts.responses import EntityKind

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
    next_since: int
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


def dedupe_window(rows: Sequence[tuple[int, EntityKind, str, int]]) -> Window:
    """Rows are (seq, kind, entity_id, deleted) in seq order."""
    seen: dict[tuple[EntityKind, str], None] = {}  # insertion-ordered set
    deleted_keys: set[tuple[EntityKind, str]] = set()
    last_seq = 0
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
    """The window's entities that ship as tombstones, in window order: an
    entity absent from current state (`present[kind]`, a missing kind
    counting as empty), or a reusable-id entity with a delete row in the
    window even though a live row now holds its id."""
    return [(k, e) for k, e in win.entities
            if e not in present.get(k, frozenset())
            or (k in REUSABLE_ID_KINDS and (k, e) in win.tombstoned)]


def tombstoned_ids(win: Window, kind: EntityKind) -> list[str]:
    """Ids of `kind` with a delete row in the window, in window order."""
    return [e for k, e in win.entities
            if k == kind and (k, e) in win.tombstoned]
