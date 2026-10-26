# pattern: Functional Core
"""The approval card's guard: which expected block, if any, no longer stands
as the card showed it. The reads live in ops_apply.expected_now."""
from __future__ import annotations

from collections.abc import Mapping, Sequence

from pkm.contracts.ops import BlockUid, ExpectedBlock, Sha256Hex

_TAIL = "after the approval card showed it, so nothing was written"


def unmet_expectation(expect: Sequence[ExpectedBlock],
                      now: Mapping[BlockUid, Sha256Hex | None]) -> str | None:
    """The first unmet expectation's reason, in list order, or None. `now`
    holds the hash of each expectation's own kind as stored now, None when
    no block has the uid; for `absent`, any hash means the block exists."""
    for e in expect:
        current = now.get(e.uid)
        if e.kind == "absent":
            if current is not None:
                return (f"block (({e.uid})) did not exist when the approval"
                        " card was shown but does now, so nothing was"
                        " written")
        elif current is None:
            return f"block (({e.uid})) was deleted {_TAIL}"
        elif current != e.shown_hash:
            if e.kind == "subtree":
                return f"block (({e.uid})) or a block under it changed {_TAIL}"
            return f"block (({e.uid})) changed {_TAIL}"
    return None
