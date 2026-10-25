import pytest

from pkm.contracts.ops import BlockUid, ExpectedBlock, Sha256Hex, subtree_hash, text_hash
from pkm.server.ops_expect import unmet_expectation
from pkm.test_data.ids import uid_of

A = uid_of("aaaaaa")
B = uid_of("bbbbbb")
TH = text_hash("shown")
SH = subtree_hash([(A, "shown")])


def _text(uid: BlockUid = A, h: Sha256Hex = TH):
    return ExpectedBlock(uid=uid, kind="text", shown_hash=h)


def _sub(uid: BlockUid = A, h: Sha256Hex = SH):
    return ExpectedBlock(uid=uid, kind="subtree", shown_hash=h)


def _absent(uid: BlockUid = A):
    return ExpectedBlock(uid=uid, kind="absent")


def test_met_expectations_give_none():
    assert unmet_expectation([_text()], {A: TH}) is None
    assert unmet_expectation([_sub()], {A: SH}) is None
    assert unmet_expectation([_absent()], {A: None}) is None
    assert unmet_expectation([_absent()], {}) is None


def test_a_changed_text():
    assert unmet_expectation([_text()], {A: text_hash("other")}) == (
        f"block (({A})) changed after the approval card showed it,"
        " so nothing was written")


def test_a_changed_subtree():
    assert unmet_expectation([_sub()], {A: subtree_hash([(A, "x")])}) == (
        f"block (({A})) or a block under it changed after the approval card"
        " showed it, so nothing was written")


@pytest.mark.parametrize("make", [_text, _sub])
def test_a_found_block_now_gone(make):
    assert unmet_expectation([make()], {A: None}) == (
        f"block (({A})) was deleted after the approval card showed it,"
        " so nothing was written")


def test_absent_now_present():
    assert unmet_expectation([_absent()], {A: TH}) == (
        f"block (({A})) did not exist when the approval card was shown but"
        " does now, so nothing was written")


def test_the_first_unmet_in_list_order_is_reported():
    got = unmet_expectation([_text(B), _text(A)],
                            {A: text_hash("x"), B: text_hash("y")})
    assert got is not None and f"(({B}))" in got
