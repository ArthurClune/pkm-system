import json
import time
from pathlib import Path

import pytest

from pkm.refs import Ref, extract

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
