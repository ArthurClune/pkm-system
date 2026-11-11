"""The committed shared/fixtures/mime_parity.json must match what
assets_core.mime_category gives every MIME_POLICY type and a few outside it;
the web's mimeCategory (web/src/views/filesCore.ts) replays the same file.
Regenerate with `uv run python -m pkm.regen` (or
`uv run python -m pkm.mime_parity_dump`, writing stdout to the fixture)."""
import json
from pathlib import Path

from pkm.assets_core import MIME_POLICY
from pkm.mime_parity_dump import fixture

FIXTURE = (Path(__file__).resolve().parents[2]
           / "shared" / "fixtures" / "mime_parity.json")


def test_committed_mime_fixture_is_current():
    assert FIXTURE.exists(), f"missing fixture: {FIXTURE}"
    assert json.loads(FIXTURE.read_text()) == fixture(), (
        "stale fixture: run `uv run python -m pkm.regen`")


def test_the_fixture_covers_every_policy_type():
    rows = {r["mime"] for r in json.loads(FIXTURE.read_text())["rows"]}
    assert set(MIME_POLICY) <= rows
