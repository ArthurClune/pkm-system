"""The committed shared/fixtures/refs_parity.json must match what refs.py
produces today; the TS port (web/src/replica/refs.ts) replays the same file.
Regenerate with `uv run python -m pkm.refs_parity_dump`, writing stdout to
shared/fixtures/refs_parity.json.

The file holds the hand CASES followed by a seeded generated corpus of
bracket-heavy texts; the shape tally below keeps that corpus from going
vacuous."""
import json
from pathlib import Path

from pkm.refs_parity_dump import (
    CASES,
    GENERATED_COUNT,
    SHAPES,
    fixture,
    generated_cases,
    shape_tally,
)

FIXTURE = (Path(__file__).resolve().parents[2]
           / "shared" / "fixtures" / "refs_parity.json")
MIN_REACH = 15


def test_committed_refs_parity_fixture_is_current():
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


def test_generated_cases_follow_the_hand_cases_in_the_fixture():
    texts = [c["text"] for c in json.loads(FIXTURE.read_text())["cases"]]
    assert texts == [*CASES, *generated_cases()]
