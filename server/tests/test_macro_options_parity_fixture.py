"""The committed shared/fixtures/macro_options_parity.json must match what
pkm.macro_options gives each body; the web's macroOptions replays the same
file. Regenerate with `uv run python -m pkm.regen`."""
import json
from pathlib import Path

from pkm.macro_options_parity_dump import fixture

FIXTURE = (Path(__file__).resolve().parents[2]
           / "shared" / "fixtures" / "macro_options_parity.json")


def test_committed_macro_options_fixture_is_current():
    assert FIXTURE.exists(), f"missing fixture: {FIXTURE}"
    assert json.loads(FIXTURE.read_text()) == fixture(), (
        "stale fixture: run `uv run python -m pkm.regen`")
