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
from typing import Final, Literal

from pkm.contracts.ops import MAX_BLOCK_TEXT_CHARS, MAX_LINK_NESTING
from pkm.refs import link_nesting_depth

TextLimitKind = Literal["length", "nesting"]

# Most unlink work a server rewrite may ask for, measured as the text's
# `[[` depth times its length: `unlink.unlink_title_refs` peels a nested
# link one layer per pass, each reading the whole text. Judged where a page
# delete or a delete's replay splices copies in, since copies that each
# nest within the cap can wrap thousands of links 32 deep. At twice the
# length cap, any text within the length cap nested twice passes, and no
# unlink judged here costs much more than the passes over one such text.
# Prod's largest, measured with every block's copies spliced in, was
# 34,863 characters one level deep: far below it.
MAX_UNLINK_WORK: Final = 2 * MAX_BLOCK_TEXT_CHARS


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
    return rewrite_nesting_violation(before, after)


def rewrite_nesting_violation(
        before: str, after: str) -> TextLimitViolation | None:
    """The nesting half of `rewrite_text_limit_violation`: `after` nested
    past the cap and deeper than `before`. Linear in both texts.

    Copies that each nest within the cap can join into one deep link (one
    opens runs, another closes them), so a page delete and a delete's
    replay ask it of the text with copies spliced in, before unlinking,
    through `unlink_refused`.
    """
    # The fast path `text_limit_violation` takes, whatever the length.
    if after.count("[[") <= MAX_LINK_NESTING:
        return None
    depth = link_nesting_depth(after)
    if depth > MAX_LINK_NESTING and depth > link_nesting_depth(before):
        return TextLimitViolation("nesting", depth, MAX_LINK_NESTING)
    return None


def unlink_refused(before: str, after: str) -> bool:
    """Must a server rewrite refuse to unlink `after`, the text `before`
    became with copies spliced in? Yes when it nests past the cap deeper
    than `before` (`rewrite_nesting_violation`), or when its depth times
    its length passes `MAX_UNLINK_WORK` and `before`'s: the unlink peels
    a nested link one layer per pass over the whole text, so a text
    within the nesting cap still costs its depth in passes. Level is
    allowed on each, as `rewrite_text_limit_violation` allows it, so a row
    stored before the limits whose delete splices nothing in stays
    deletable; its unlink costs only what it cost when it was stored.
    Linear in both texts; the depth is measured only when the count of
    `[[`, which bounds it, does not settle the answer."""
    count = after.count("[[")
    if count <= MAX_LINK_NESTING and count * len(after) <= MAX_UNLINK_WORK:
        return False
    depth = link_nesting_depth(after)
    work = depth * len(after)
    if depth <= MAX_LINK_NESTING and work <= MAX_UNLINK_WORK:
        return False
    was = link_nesting_depth(before)
    return (depth > MAX_LINK_NESTING and depth > was) or \
        (work > MAX_UNLINK_WORK and work > was * len(before))
