# pattern: Functional Core
"""The write-time limits on one block's text: how long it may be and how
deep its `[[` runs may nest. Every server write path asks
`text_limit_violation` of the text it would store; reads, moves and deletes
of a row already over a limit are never judged. A rewrite the server makes
itself asks `rewrite_text_limit_violation`, which lets a row already over a
limit through when the rewrite leaves it no worse.

The web's copy (grammar/textLimits.ts) is pinned equal by
shared/fixtures/text_limits_parity.json."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pkm.contracts.ops import MAX_BLOCK_TEXT_CHARS, MAX_LINK_NESTING
from pkm.refs import link_nesting_depth

TextLimitKind = Literal["length", "nesting"]


@dataclass(frozen=True)
class TextLimitViolation:
    """Which limit a text is over, what it measured and the limit itself."""

    kind: TextLimitKind
    measured: int
    limit: int


def text_limit_violation(text: str) -> TextLimitViolation | None:
    """The limit `text` is over, or None when a write may store it.

    Length is judged first, so the nesting measure never reads more than
    `MAX_BLOCK_TEXT_CHARS` code points.
    """
    if len(text) > MAX_BLOCK_TEXT_CHARS:
        return TextLimitViolation("length", len(text), MAX_BLOCK_TEXT_CHARS)
    # Every run the measure counts opens with its own `[[`, and no two
    # runs share one, so a chain of n nested runs needs n non-overlapping
    # `[[`. `str.count` takes them greedily, which is the most there can
    # be, so a text with at most the limit's worth cannot nest past it.
    if text.count("[[") <= MAX_LINK_NESTING:
        return None
    depth = link_nesting_depth(text)
    if depth > MAX_LINK_NESTING:
        return TextLimitViolation("nesting", depth, MAX_LINK_NESTING)
    return None


def describe_text_limit(violation: TextLimitViolation) -> str:
    """The refusal's wording, without the block or page it names."""
    if violation.kind == "length":
        return (f"text of {violation.measured} characters is over the "
                f"limit of {violation.limit}")
    return (f"[[ nested {violation.measured} levels deep is over the "
            f"limit of {violation.limit}")


def rewrite_text_limit_violation(
        before: str, after: str) -> TextLimitViolation | None:
    """The limit a rewrite the server makes of a stored block breaks, or
    None when it may store `after`.

    A rename's longer title, a page delete's inlined copies and an asset
    delete's stripped tokens change text nobody sent. Each limit is judged
    on its own: `after` is refused when it is over the length cap and
    longer than `before`, or nested past the cap and deeper than `before`.
    When `before` is within both limits that is `text_limit_violation`
    exactly. A row stored before the limits may only stay level or improve
    on each limit, so the page it links stays renamable and deletable, and
    no run of rewrites can trade its length for depth. The nesting of a
    text over the length cap is measured here too: only a stored row can
    be that long.
    """
    if len(after) > MAX_BLOCK_TEXT_CHARS and len(after) > len(before):
        return TextLimitViolation("length", len(after), MAX_BLOCK_TEXT_CHARS)
    # The fast path `text_limit_violation` takes, whatever the length.
    if after.count("[[") <= MAX_LINK_NESTING:
        return None
    depth = link_nesting_depth(after)
    if depth > MAX_LINK_NESTING and depth > link_nesting_depth(before):
        return TextLimitViolation("nesting", depth, MAX_LINK_NESTING)
    return None
