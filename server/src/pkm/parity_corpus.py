# pattern: Functional Core
"""Seeded corpora for the parity dumps, and the tally that keeps a corpus
from going vacuous. A corpus is stable across runs and Python versions
because random.Random's sequence is specified; a change to the order of
RNG calls changes every committed fixture built from it."""
from __future__ import annotations

import random
from collections.abc import Callable, Iterable, Mapping, Sequence


def parity_corpus(draw: Callable[[random.Random], str], *, seed: int,
                  count: int, exclude: Iterable[str] = ()) -> list[str]:
    """`count` distinct draws not in `exclude`, in draw order."""
    rng = random.Random(seed)
    out: list[str] = []
    seen = set(exclude)
    while len(out) < count:
        text = draw(rng)
        if text not in seen:
            seen.add(text)
            out.append(text)
    return out


def piece_soup(pieces: Sequence[str], least: int,
               most: int) -> Callable[[random.Random], str]:
    """A draw that glues `least` to `most` of `pieces` together."""
    def draw(rng: random.Random) -> str:
        return "".join(rng.choice(pieces)
                       for _ in range(rng.randint(least, most)))
    return draw


def shape_tally(texts: Iterable[str],
                shapes: Mapping[str, Callable[[str], bool]]) -> dict[str, int]:
    """How many of `texts` show each shape."""
    texts = list(texts)
    return {name: sum(1 for t in texts if pred(t))
            for name, pred in shapes.items()}
