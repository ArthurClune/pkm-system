"""The committed shared/fixtures/text_limits_parity.json must match what
text_limits.py and refs.link_nesting_depth produce today; the web's judge
(web/src/grammar/textLimits.ts) replays the same file. Regenerate with
`uv run python -m pkm.text_limits_parity_dump`, writing stdout to
shared/fixtures/text_limits_parity.json.

The file holds the hand CASES, each spelled as parts so a text a million
code points long costs a few bytes, followed by a seeded generated corpus
of bracket soup; the shape tally below keeps that corpus from going
vacuous."""
import json
from pathlib import Path

from pkm.contracts.ops import MAX_BLOCK_TEXT_CHARS, MAX_LINK_NESTING
from pkm.text_limits_parity_dump import (
    CASES,
    GENERATED_COUNT,
    SHAPES,
    fixture,
    generated_cases,
    shape_tally,
)

FIXTURE = (Path(__file__).resolve().parents[2]
           / "shared" / "fixtures" / "text_limits_parity.json")
MIN_REACH = 15


def test_committed_text_limits_fixture_is_current():
    assert FIXTURE.exists(), f"missing fixture: {FIXTURE}"
    assert json.loads(FIXTURE.read_text()) == fixture()


def test_generated_corpus_reaches_every_shape():
    """The tally is judged on the texts, so a generator edit that stops
    drawing a shape fails here instead of leaving the replay vacuous."""
    generated = generated_cases()
    assert len(generated) == GENERATED_COUNT
    assert len(set(generated)) == len(generated)
    tally = shape_tally(generated)
    assert set(tally) == set(SHAPES)
    starved = {name: n for name, n in tally.items() if n < MIN_REACH}
    assert not starved, tally


def test_fixture_constants_match_the_contract():
    committed = json.loads(FIXTURE.read_text())
    assert committed["max_block_text_chars"] == MAX_BLOCK_TEXT_CHARS
    assert committed["max_link_nesting"] == MAX_LINK_NESTING


def test_hand_cases_are_named_once_and_reach_both_verdicts():
    names = [case["name"] for case in CASES]
    assert len(set(names)) == len(names)
    kinds = {c["violation"] and c["violation"]["kind"]
             for c in json.loads(FIXTURE.read_text())["cases"]}
    assert kinds == {None, "length", "nesting"}
