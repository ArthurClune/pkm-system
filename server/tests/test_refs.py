import json
import time
from pathlib import Path

import pytest

from pkm.refs import (
    AttributeSpan,
    Ref,
    attribute_title_span,
    canonicalize_title,
    extract,
    normalize_title,
    strip_code,
    title_syntax_reason,
)

FIXTURE = Path(__file__).parents[2] / "shared" / "fixtures" / "ref_grammar.json"
CASES = json.loads(FIXTURE.read_text())["cases"]
TITLE_SYNTAX_FIXTURE = (
    Path(__file__).parents[2] / "shared" / "fixtures" / "title_syntax.json"
)
TITLE_SYNTAX_CASES = json.loads(TITLE_SYNTAX_FIXTURE.read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_grammar_fixture(case):
    parsed = extract(case["text"])
    assert [{"title": r.title, "kind": r.kind} for r in parsed.refs] == case["refs"]
    assert list(parsed.block_refs) == case["block_refs"]
    assert parsed.embeds == case["embeds"]


def test_ref_ordering_and_types():
    parsed = extract("Tags:: [[B]] #c")
    assert parsed.refs == (
        Ref("Tags", "attribute"),
        Ref("B", "link"),
        Ref("c", "tag"),
    )


# pkm-7myl: a block whose entire text is one large fenced code block gets
# blanked by strip_code() into one long run of whitespace (fences keep
# their length so asset/ref offsets elsewhere stay stable). The attribute
# regex used to be `^\s*([^\[\]{}:\n]+?)::` -- since `\s` is a near-subset
# of the negated class, a long whitespace run with no "::" anywhere forces
# the engine to retry the lazy inner group at every one of the `\s*`
# prefix's O(n) possible split points, an O(n^2) blowup. On the real prod
# graph this turned a single ~258KB pasted-code block into a ~224s regex
# match, which is why GET /api/export.zip (whole-db export, one extract()
# call per block via collect_block_ref_uids) looked "broken": the browser
# waited minutes for a response that never seemed to arrive.
def test_extract_is_linear_on_a_large_all_whitespace_run():
    huge_code_block = "```\n" + ("x" * 200_000) + "\n```"
    t0 = time.monotonic()
    parsed = extract(huge_code_block)
    elapsed = time.monotonic() - t0
    assert elapsed < 2.0, f"extract() took {elapsed:.2f}s -- expected sub-second, linear time"
    assert parsed.refs == ()
    assert parsed.block_refs == ()


def test_strip_code_blanks_code_without_moving_what_follows():
    # Length preservation is what lets a caller locate spans on the stripped
    # copy and slice the original at those offsets.
    text = "`[[A]]` and ```\n[[B]]\n``` and [[C]]"
    stripped = strip_code(text)
    assert len(stripped) == len(text)
    assert stripped.index("[[C]]") == text.index("[[C]]")
    assert "[[A]]" not in stripped
    assert "[[B]]" not in stripped


def test_attribute_title_span_starts_at_the_title_not_at_the_indent():
    assert attribute_title_span("  Tags:: [[B]]") == AttributeSpan(
        start=2, end=8, raw_title="Tags", title="Tags"
    )


def test_attribute_title_span_pairs_the_written_title_with_the_normalized_one():
    span = attribute_title_span("Bad\tTitle:: v")
    assert span is not None
    assert (span.raw_title, span.title) == ("Bad\tTitle", "Bad Title")
    # The name group ends at the colons, so padding inside it is trimmed but
    # still inside the span -- a rewrite replaces "Bad\tTitle ::" entire.
    padded = attribute_title_span("Name :: v")
    assert padded is not None
    assert (padded.raw_title, padded.start, padded.end) == ("Name", 0, 7)


@pytest.mark.parametrize(
    "text",
    ["", "   ", "no attribute here", "[[A]]:: v", "  ::", "x\nName:: v"],
)
def test_attribute_title_span_absent(text):
    assert attribute_title_span(text) is None


@pytest.mark.parametrize(
    "text", ["\xa0Name:: v", "  \tName:: v", "\x0bName:: v", "A:: v"]
)
def test_attribute_title_span_never_reports_a_blank_title(text):
    # Callers rely on this: the scan starts past every leading whitespace
    # char, so the name it captures cannot normalize away to nothing.
    span = attribute_title_span(text)
    assert span is not None
    assert span.title


def test_attribute_title_span_pins_a_zero_width_space_title():
    # U+200B is not whitespace to str.lstrip(), unlike the whitespace cases
    # above -- so the leading-whitespace scan does not skip past it, and the
    # captured (and normalized) title is the zero-width space itself, not
    # blank.
    span = attribute_title_span("​:: v")
    assert span is not None
    assert span.title == "​"


def test_extract_attribute_still_recognised_after_leading_whitespace():
    # The fix strips leading whitespace itself before matching the
    # attribute body, rather than folding it into the backtracking regex --
    # must still recognise an indented attribute line.
    parsed = extract("   Tags:: [[B]]")
    assert parsed.refs[0] == Ref("Tags", "attribute")


# pkm-hjhy: a [[link]] spanning a newline used to mint a page whose title
# held that newline, and such a page is unreachable through the API --
# Starlette's {title:path} converter compiles to `.*` with no re.DOTALL, so
# GET/DELETE/rename/export all 404 on it. Titles are normalized where they
# are born instead.
def test_normalize_title_collapses_control_whitespace():
    assert normalize_title("Levels of AGI:\nthe Path") == "Levels of AGI: the Path"
    assert normalize_title("a\tb") == "a b"
    assert normalize_title("a\r\nb") == "a b"
    assert normalize_title("and   \n\t  Opportunities") == "and Opportunities"
    assert normalize_title("\n Spaced \n") == "Spaced"


def test_normalize_title_leaves_control_free_titles_byte_for_byte():
    # Deliberately narrow: only a title that actually contains a control
    # whitespace char is collapsed. Runs of plain spaces are untouched, so
    # an existing "foo  bar" page can never become collateral damage.
    for title in ("Two  Spaces", " Padded ", "Machine Learning", "A/B", ""):
        assert normalize_title(title) == title


def test_normalize_title_is_idempotent():
    once = normalize_title("Challenges and\nOpportunities")
    assert normalize_title(once) == once


def test_canonicalize_title_preserves_plain_space_when_inactive_and_strips_only_plain_space_when_active():
    assert canonicalize_title("A\t B", plain_space=False) == "A B"
    assert canonicalize_title(" A ", plain_space=False) == " A "
    assert canonicalize_title(" A ", plain_space=True) == "A"
    assert canonicalize_title("\u00a0A\u00a0", plain_space=True) == "\u00a0A\u00a0"
    assert canonicalize_title("  ", plain_space=True) == ""


@pytest.mark.parametrize(
    "case", TITLE_SYNTAX_CASES, ids=[c["name"] for c in TITLE_SYNTAX_CASES]
)
def test_title_syntax_fixture(case):
    assert title_syntax_reason(case["title"]) == case["reason"]
