"""shared/fixtures/title_length.json pins the page title cap, how a title
is measured, and which linked titles the ops judge refuses; the web's
grammar/titleLength.ts and replica/titles.ts replay the same file. It is
hand-edited: each case spells its text as parts, so a title a thousand
characters long costs a few bytes."""
import json
from pathlib import Path

import pytest

from pkm.contracts.ops import CreateOp
from pkm.contracts.titles import MAX_PAGE_TITLE_CHARS
from pkm.refs import describe_title_length, title_length_over
from pkm.server.ops_core import (describe_op_title_violation,
                                 find_op_title_violation)
from pkm.test_data.ids import order_idx_of, raw_title_of, uid_of

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2]
     / "shared" / "fixtures" / "title_length.json").read_text())


def _text(case: dict) -> str:
    return "".join(part * repeat for part, repeat in case["parts"])


def test_the_cap_equals_the_fixture():
    assert FIXTURE["max_page_title_chars"] == MAX_PAGE_TITLE_CHARS


@pytest.mark.parametrize("case", FIXTURE["titles"],
                         ids=[c["name"] for c in FIXTURE["titles"]])
def test_title_length_over_matches_the_fixture(case):
    measured = title_length_over(_text(case))
    assert measured == case["violation"]
    if measured is not None:
        assert describe_title_length(measured) == case["describe"]


@pytest.mark.parametrize("case", FIXTURE["texts"],
                         ids=[c["name"] for c in FIXTURE["texts"]])
def test_the_ops_judge_refuses_linked_titles_as_the_fixture_says(case):
    op = CreateOp(op="create", uid=uid_of("fixture_001"),
                  page_title=raw_title_of("Fixture"), parent_uid=None,
                  order_idx=order_idx_of(0), text=_text(case))
    violation = find_op_title_violation([op])
    if case["violation"] is None:
        assert violation is None
        return
    assert violation is not None
    assert violation.reason == "too_long"
    assert describe_op_title_violation(violation) == case["op_describe"]
