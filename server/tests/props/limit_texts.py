# pattern: Functional Core
"""The block texts at and past the write-time limits that the ops property
draws (backend.md § Planning (text limits)): a text may hold at most
1,000,000 code points, and its `[[` runs may nest at most 32 deep outside
code. Every other text the strategies draw is a few short tokens, so these
are the only texts a limit can reach. The model decides a batch's fate by
membership here rather than asking the server's judge, so a boundary bug in
the judge disagrees with it. The limits are written out, not imported, for
the same reason."""
from __future__ import annotations

TEXT_CAP = 1_000_000
NESTING_CAP = 32

# Two UTF-16 units, one code point: a judge counting units refuses a text
# of it at the cap.
EMOJI = "\U0001f600"


def nest(depth: int) -> str:
    """`[[` runs nested `depth` deep. `a//` has an unreachable segment, so
    no run is a ref and title syntax never refuses one."""
    return "[[a//" * depth + "x" + "]]" * depth


# What a create or an edit may not store.
PAST_LIMIT_TEXTS = (nest(NESTING_CAP + 1), "x" * (TEXT_CAP + 1),
                    EMOJI * (TEXT_CAP + 1))
# What it must store: the deepest nest, a deeper one a closed fence hides
# from the measure, and the longest text in code points.
AT_NESTING_LIMIT = nest(NESTING_CAP)
NEST_IN_CODE = f"```\n{nest(40)}\n```"
EMOJI_AT_CAP = EMOJI * TEXT_CAP
LIMIT_TEXTS = (*PAST_LIMIT_TEXTS, AT_NESTING_LIMIT, NEST_IN_CODE,
               EMOJI_AT_CAP)
