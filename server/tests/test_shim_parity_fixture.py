"""The committed shared/fixtures/shim_parity.json must match what the live
routes return today; the TS offline shim replays the same file. Regenerate:
`uv run python -m pkm.server.shim_parity_dump > ../shared/fixtures/shim_parity.json`."""
import json
from pathlib import Path

from pkm.server.shim_parity_dump import fixture

FIXTURE = (Path(__file__).resolve().parents[2]
           / "shared" / "fixtures" / "shim_parity.json")


def test_committed_shim_parity_fixture_is_current():
    assert FIXTURE.exists(), f"missing fixture: {FIXTURE}"
    assert json.loads(FIXTURE.read_text()) == fixture()
