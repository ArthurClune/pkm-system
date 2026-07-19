import pytest

from pkm.todo import is_todo, marker_state, with_state


@pytest.mark.parametrize("text,state", [
    ("{{TODO}} buy milk", "TODO"),
    ("{{[[TODO]]}} buy milk", "TODO"),
    ("{{DONE}} bought milk", "DONE"),
    ("{{[[DONE]]}} bought milk", "DONE"),
    ("> {{TODO}} quoted task", "TODO"),
    ("{{[[TODO}} lenient brackets", "TODO"),   # each side independent
    ("{{TODO]]}} lenient brackets", "TODO"),
    ("buy milk", None),
    (" {{TODO}} not at block start", None),
    ("see {{TODO}} mid-text", None),
    ("", None),
])
def test_marker_state(text, state):
    assert marker_state(text) == state


def test_is_todo_only_matches_todo_state():
    assert is_todo("{{TODO}} x")
    assert not is_todo("{{DONE}} x")
    assert not is_todo("x")


def test_with_state_toggles_preserving_bracket_variant_and_quote():
    assert with_state("{{TODO}} x", "DONE") == "{{DONE}} x"
    assert with_state("{{[[TODO]]}} x", "DONE") == "{{[[DONE]]}} x"
    assert with_state("> {{TODO}} x", "DONE") == "> {{DONE}} x"
    assert with_state("{{DONE}} x", "TODO") == "{{TODO}} x"


def test_with_state_adds_marker_to_plain_text():
    assert with_state("buy milk", "TODO") == "{{TODO}} buy milk"
    assert with_state("> quoted", "TODO") == "> {{TODO}} quoted"


def test_with_state_none_strips_marker_and_one_space():
    assert with_state("{{DONE}} x", None) == "x"
    assert with_state("> {{TODO}} x", None) == "> x"
    assert with_state("plain", None) == "plain"
