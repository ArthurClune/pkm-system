# pattern: Functional Core
"""Windowing for the sync changes feed. The cursor advances over RAW
journal rows -- next_since is the last row scanned, not the last distinct
entity -- so a client can never skip an entity whose older journal row
fell inside a window that also contained a newer row for something else
(spec section 1, the A@1/B@2/A@100 case).

Also the chunking/reordering helpers hydration uses to replace a
per-entity query with bounded `WHERE x IN (...)` set queries (pkm-ldqx):
chunk_ids splits an id list to stay under SQLite's bound-parameter limit,
hydrate_in_order puts a dict of fetched rows (keyed by id, in whatever
order the batched query returned them) back into the caller's original
order, dropping ids nothing was found for."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TypeVar

K = TypeVar("K")
V = TypeVar("V")

# Comfortably under both SQLite's historic default (999 bound parameters)
# and modern builds' raised limit (32766, SQLITE_MAX_VARIABLE_NUMBER) --
# a window can legally carry MAX_LIMIT (5,000) distinct entities and a
# snapshot's block count is unbounded, so hydration chunks every id list
# rather than assuming it fits in one `IN (...)` clause.
CHUNK_SIZE = 500


def chunk_ids(ids: Sequence[K], size: int = CHUNK_SIZE) -> list[list[K]]:
    return [list(ids[i:i + size]) for i in range(0, len(ids), size)]


def hydrate_in_order(order: Sequence[K], present: Mapping[K, V]) -> list[V]:
    return [present[k] for k in order if k in present]


@dataclass(frozen=True)
class Window:
    next_since: int
    entities: tuple[tuple[str, str], ...]  # unique (kind, entity_id)


def dedupe_window(rows: Sequence[tuple[int, str, str]]) -> Window:
    seen: dict[tuple[str, str], None] = {}  # insertion-ordered set
    last_seq = 0
    for seq, kind, entity_id in rows:
        last_seq = seq
        seen.setdefault((kind, entity_id), None)
    return Window(next_since=last_seq, entities=tuple(seen))
