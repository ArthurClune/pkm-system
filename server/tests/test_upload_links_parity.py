"""strip_asset_tokens removes the tokens the web's upload path writes.

shared/fixtures/upload_links_parity.json is written by the web test
web/src/sync/assetsParity.test.ts: each case is a block text mixing tokens
for one asset (written with the encoded URLs the server returns, or the raw
names old uploads used) and tokens for another, plus the text that must be
left once the first asset's tokens are gone.
"""

import json
from pathlib import Path

import pytest

from pkm.assets_core import strip_asset_tokens

FIXTURE = Path(__file__).resolve().parents[2] / "shared" / "fixtures" / "upload_links_parity.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


def test_fixture_is_not_empty():
    assert len(CASES) >= 100
    assert any(c["legacy"] for c in CASES)
    assert any(not c["legacy"] for c in CASES)


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["text"][:40])
def test_server_strips_what_the_web_wrote(case):
    assert strip_asset_tokens(case["text"], case["sha"]) == case["remainder"]
