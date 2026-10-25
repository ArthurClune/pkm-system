"""The write-time text limits: the judge every write path asks
(`text_limits.text_limit_violation`) and the nesting measure it uses
(`refs.link_nesting_depth`).

The measure is the height of the run tree `bracket_spans` builds, so the
property below checks it against that tree directly; the judge's fast path
(a count of `[[`) must agree with the full measure."""
from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from hostile import event
from pkm.contracts.ops import MAX_BLOCK_TEXT_CHARS, MAX_LINK_NESTING
from pkm.refs import BracketSpan, bracket_spans, link_nesting_depth, strip_code
from pkm.text_limits import (
    TextLimitViolation,
    describe_text_limit,
    text_limit_violation,
)


def nest(depth: int) -> str:
    return "[[a//" * depth + "x" + "]]" * depth


def test_the_limits_are_the_spec_values():
    assert MAX_BLOCK_TEXT_CHARS == 1_000_000
    assert MAX_LINK_NESTING == 32


def test_length_boundary():
    assert text_limit_violation("x" * 1_000_000) is None
    assert text_limit_violation("x" * 1_000_001) == TextLimitViolation(
        "length", 1_000_001, 1_000_000)


def test_astral_counts_code_points():
    assert text_limit_violation("\U0001F600" * 1_000_000) is None
    assert text_limit_violation("\U0001F600" * 1_000_001) == (
        TextLimitViolation("length", 1_000_001, 1_000_000))


def test_nesting_boundary():
    assert text_limit_violation(nest(32)) is None
    assert text_limit_violation(nest(33)) == TextLimitViolation(
        "nesting", 33, 32)
    assert link_nesting_depth("[[" * 33 + "x" + "]]" * 33) == 33
    assert link_nesting_depth("#[[a//" * 33 + "x" + "]]" * 33) == 33


def test_length_is_judged_before_nesting():
    violation = text_limit_violation(nest(40) + "x" * 1_000_000)
    assert violation is not None
    assert violation.kind == "length"


def test_what_does_not_count():
    assert link_nesting_depth("[[" * 100) == 0
    assert link_nesting_depth(
        "`" + "[[" * 40 + "x" + "]]" * 40 + "`") == 0
    assert link_nesting_depth("```\n" + nest(40) + "\n```") == 0
    assert link_nesting_depth("[[a`" * 40 + "x" + "]]" * 40) == 0
    assert link_nesting_depth("]]" * 100 + "[[a]]") == 1
    assert link_nesting_depth("[[x]] " * 500) == 1
    # An unclosed fence hides nothing.
    assert link_nesting_depth("```\n" + nest(40)) == 40


def test_deep_nest_is_linear_not_recursive():
    text = "[[" * 200_000 + "x" + "]]" * 200_000
    assert link_nesting_depth(text) == 200_000


def test_describe_strings():
    assert describe_text_limit(TextLimitViolation(
        "length", 1_000_001, 1_000_000)) == (
        "text of 1000001 characters is over the limit of 1000000")
    assert describe_text_limit(TextLimitViolation("nesting", 33, 32)) == (
        "[[ nested 33 levels deep is over the limit of 32")


# --- properties -----------------------------------------------------------

_TOKENS = ["[[", "]]", "[", "]", "`", "```", "\n", "#", "a", "a//", " ",
           "```\U0001d400", "```\ua7cb", "```\u00e9", "\U0001f600", "\ud800"]


@st.composite
def _texts(draw) -> str:
    """Token soup, with `[[` weighted so many draws hold more than 32 of
    them, and sometimes wrapped in a chain of runs so some nest past 32."""
    soup = draw(st.lists(
        st.one_of(st.just("[["), st.sampled_from(_TOKENS)), max_size=120))
    wrap = draw(st.integers(0, 40))
    opener = draw(st.sampled_from(["[[", "#[[", "[[a//"]))
    return opener * wrap + "".join(soup) + "]]" * wrap


def _tree_height(spans: tuple[BracketSpan, ...]) -> int:
    height = 0
    stack = [(span, 1) for span in spans]
    while stack:
        span, level = stack.pop()
        height = max(height, level)
        stack.extend((child, level + 1) for child in span.children)
    return height


@settings(max_examples=500, deadline=None)
@given(_texts())
def test_depth_matches_the_bracket_span_tree(text):
    """The stack walk against the height of the span tree. Both read the
    pairs `refs._bracket_pairs` makes, so this checks the walk, not the
    pairing: the pairing (and code stripping) is checked against an
    independent implementation only when the web replays
    shared/fixtures/text_limits_parity.json."""
    depth = link_nesting_depth(text)
    event("deep" if depth > MAX_LINK_NESTING else "shallow")
    assert depth == _tree_height(bracket_spans(strip_code(text), text))


@settings(max_examples=500, deadline=None)
@given(_texts())
def test_fast_path_agrees(text):
    event("over 32 openers" if text.count("[[") > MAX_LINK_NESTING
          else "at most 32 openers")
    depth = link_nesting_depth(text)
    violation = text_limit_violation(text)
    if depth > MAX_LINK_NESTING:
        event("nesting violation")
        assert violation == TextLimitViolation(
            "nesting", depth, MAX_LINK_NESTING)
    else:
        assert violation is None
