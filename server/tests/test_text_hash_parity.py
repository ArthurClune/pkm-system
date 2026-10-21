"""The server's text hashes agree with the browser's on odd text.

shared/fixtures/text_hash_parity.json is written by the web test
web/src/replica/textHashParity.test.ts: texts holding lone high and low
surrogates, astral emoji and ZWJ sequences, NFC and NFD spellings, NUL and
CRLF, each with the browser's sha256Hex and well-formed form, plus
subtreeHash over sets of them. A guarded update_text or delete compares the
browser's hash with the server's, so a disagreement here is a spurious
conflict copy on the daily page.

The file stores a lone surrogate as a JSON escape; the tallies check that
json.loads hands it back as the lone code point, not something already
repaired.
"""
import json
import unicodedata
from pathlib import Path

import pytest

from pkm.contracts.ops import OpBatch, subtree_hash, text_hash
from pkm.contracts.text import well_formed

FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "shared" / "fixtures"
                      / "text_hash_parity.json").read_text(encoding="utf-8"))
CASES = FIXTURE["cases"]
SUBTREE_CASES = FIXTURE["subtree_cases"]


def _shapes(text: str) -> set[str]:
    found = set()
    for i, c in enumerate(text):
        if 0xD800 <= ord(c) <= 0xDBFF:
            found.add("lone high")
        elif 0xDC00 <= ord(c) <= 0xDFFF:
            found.add("lone low")
        elif ord(c) > 0xFFFF:
            found.add("astral")
    if "‍" in text:
        found.add("zwj")
    fixed = well_formed(text)
    if unicodedata.normalize("NFC", fixed) != fixed:
        found.add("nfd")
    if "\x00" in text:
        found.add("nul")
    if "\r\n" in text:
        found.add("crlf")
    return found


def test_the_loaded_fixture_holds_every_shape():
    counts: dict[str, int] = {}
    for case in CASES:
        for shape in _shapes(case["text"]):
            counts[shape] = counts.get(shape, 0) + 1
    for shape in ("lone high", "lone low", "astral", "zwj", "nfd", "nul",
                  "crlf"):
        assert counts.get(shape, 0) >= 8, (shape, counts)


@pytest.mark.parametrize("case", CASES, ids=lambda c: ascii(c["text"])[:40])
def test_text_hash_matches_the_browser(case):
    assert text_hash(case["text"]) == case["hash"]
    assert well_formed(case["text"]) == case["well_formed"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: ascii(c["text"])[:40])
def test_the_ops_contract_stores_the_browser_form(case):
    # Decoded the way the route's body is: json.loads of the escaped text.
    wire = json.dumps({
        "client_id": "c1", "batch_id": "parity_batch",
        "ops": [{"op": "update_text", "uid": "uid_b4", "text": case["text"]}]})
    batch = OpBatch.model_validate(json.loads(wire))
    [op] = batch.ops
    assert getattr(op, "text") == case["well_formed"]


@pytest.mark.parametrize("case", SUBTREE_CASES,
                         ids=lambda c: ascii(c["pairs"][0][1])[:40])
def test_subtree_hash_matches_the_browser(case):
    assert subtree_hash(tuple(p) for p in case["pairs"]) == case["hash"]
