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


def test_the_fixture_pins_the_link_depth_rule_and_padded_formats():
    data = json.loads(FIXTURE.read_text())
    assert any(c["head"] == "[[A | B]]" for c in data["cases"])
    assert any(c["formatted"] == "" and c["options"]["filter"] == "   "
               for c in data["format_cases"])
