"""The web's `Local copy::` link reader and the server's href extractor agree.

shared/fixtures/local_links_parity.json is written by the web test
web/src/outline/localLinksParity.test.ts: each case is a block text built by
the web's localCopyAttribute from a hostile file name, with the /api/local/
hrefs the web reads from it. The server must extract exactly those.
"""

import json
from pathlib import Path

import pytest

from pkm.local_docs import extract_local_hrefs

FIXTURE = Path(__file__).resolve().parents[2] / "shared" / "fixtures" / "local_links_parity.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


def test_fixture_is_not_empty():
    assert len(CASES) >= 50


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["text"][:40])
def test_server_extracts_the_hrefs_the_web_reads(case):
    assert extract_local_hrefs(case["text"]) == case["hrefs"]
