import json
import time
from pathlib import Path

import pytest

from pkm.refs import Ref, extract, normalize_title

FIXTURE = Path(__file__).parents[2] / "shared" / "fixtures" / "ref_grammar.json"
CASES = json.loads(FIXTURE.read_text())["cases"]


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
# blanked by _strip_code() into one long run of whitespace (fences keep
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
