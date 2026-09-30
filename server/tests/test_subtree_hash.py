"""subtree_hash pins the canonical (uid, text) hash a guarded delete
checks against (spec section 1). shared/fixtures/subtree_hash.json is the
cross-language pin: the web unit test asserts the same hashes."""
import json
from pathlib import Path

import pytest

from pkm.contracts.ops import subtree_hash

FIXTURE = json.loads((Path(__file__).parents[2] / "shared" / "fixtures"
                      / "subtree_hash.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_subtree_hash_matches_fixture(case):
    assert subtree_hash(tuple(p) for p in case["pairs"]) == case["hash"]


def test_subtree_hash_ignores_input_order():
    pairs = [("b", "two"), ("a", "one")]
    assert subtree_hash(pairs) == subtree_hash(list(reversed(pairs)))
