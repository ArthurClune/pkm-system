"""The committed shared/fixtures/title_parity.json must match what refs.py
decides today; the web replica replays the same file
(web/src/replica/titleParity.test.ts). Regenerate with
`uv run python -m pkm.title_parity_dump`, writing stdout to
shared/fixtures/title_parity.json.

The file is a seeded generated corpus of whitespace- and syntax-heavy
titles; the shape tally below keeps it from going vacuous."""
import json
from pathlib import Path

from pkm.title_parity_dump import (
    GENERATED_COUNT,
    SHAPES,
    fixture,
    generated_cases,
    main,
    render,
    shape_tally,
)

FIXTURE = (Path(__file__).resolve().parents[2]
           / "shared" / "fixtures" / "title_parity.json")
MIN_REACH = 20


def test_committed_title_parity_fixture_is_current():
    assert FIXTURE.exists(), f"missing fixture: {FIXTURE}"
    assert json.loads(FIXTURE.read_text()) == fixture()


def test_rendered_fixture_is_the_fixture(capsys):
    assert main() == 0
    assert json.loads(capsys.readouterr().out) == json.loads(render())
    assert json.loads(render()) == fixture()


def test_generated_corpus_reaches_every_shape():
    """The tally is judged on the titles, so a generator edit that stops
    drawing a shape fails here instead of leaving the replay vacuous."""
    generated = generated_cases()
    assert len(generated) == GENERATED_COUNT
    assert len(set(generated)) == len(generated)
    tally = shape_tally(generated)
    assert set(tally) == set(SHAPES)
    starved = {name: n for name, n in tally.items() if n < MIN_REACH}
    assert not starved, tally
