# pattern: Functional Core
"""Windowing for the sync changes feed. The cursor advances over RAW
journal rows -- next_since is the last row scanned, not the last distinct
entity -- so a client can never skip an entity whose older journal row
fell inside a window that also contained a newer row for something else
(spec section 1, the A@1/B@2/A@100 case)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


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
