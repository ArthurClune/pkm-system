"""The committed shared/fixtures/refs_parity.json must match what refs.py
produces today; the TS port (web/src/replica/refs.ts) replays the same file.
Regenerate with:
`uv run python -m pkm.refs_parity_dump > ../shared/fixtures/refs_parity.json`."""
import json
from pathlib import Path

from pkm.refs_parity_dump import fixture

FIXTURE = (Path(__file__).resolve().parents[2]
           / "shared" / "fixtures" / "refs_parity.json")


def test_committed_refs_parity_fixture_is_current():
    assert FIXTURE.exists(), f"missing fixture: {FIXTURE}"
    assert json.loads(FIXTURE.read_text()) == fixture()
