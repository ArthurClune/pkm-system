"""Each server gate suite's property, run against a mutant of the code it
checks, must fail, and fail in the invariant that mutant breaks: a
property that cannot fail checks nothing, however long it runs.

A mutant is patched onto the module global its callers look up, since a
patch on a name a caller imported directly changes nothing. A teeth run
saves nothing to the example database, or the mutant's failure would
replay into the clean suite's key, and it reports one bug and skips the
shrink, which only costs time here."""
from __future__ import annotations

from collections.abc import Callable

import pytest
from hypothesis import Phase, given, settings, strategies as st
from hypothesis.stateful import run_state_machine_as_test

from pkm import planning, unlink
from pkm.assistant.claude_engine import ClaudeConversation
from pkm.server import ops_core
from props.test_assistant_turn_props import TurnMachine
from props.test_ops_state import OpsMachine
from props.test_planner_props import cli_batch_positions
from props.test_unlink_props import delete_rewrite_properties, scenario

pytestmark = pytest.mark.proptest

TEETH = settings(settings.get_profile("merge"), database=None,
                 report_multiple_bugs=False,
                 phases=(Phase.explicit, Phase.generate))


def expect_caught(run: Callable[[], None], *invariants: str) -> None:
    """`run` fails an assertion in a function named by one of `invariants`:
    the innermost frame is the one that raised. Any other exception is a
    crash, not the property seeing the bug, and propagates. A function name
    outlives an assertion message's wording. Name every invariant the
    mutant's bug breaks: which fires first depends on the seed."""
    try:
        run()
    except AssertionError as error:
        innermost = pytest.ExceptionInfo.from_exception(
            error).traceback[-1].name
        assert innermost in invariants, (
            f"caught outside {invariants}: {error!r} in {innermost}")
        return
    pytest.fail("mutant survived")


def test_ops_refuses_text_past_a_limit(monkeypatch: pytest.MonkeyPatch
                                       ) -> None:
    """The server stores a text past a limit, so the status the machine
    expects from the model no longer matches. About one example in fifty
    catches it, hence the count."""
    monkeypatch.setattr(ops_core, "find_op_text_limit_violation",
                        lambda ops: None)
    expect_caught(lambda: run_state_machine_as_test(OpsMachine, settings=(
        settings(TEETH, max_examples=600, stateful_step_count=30))),
        "status_matches_model")


def test_planner_places_each_index(monkeypatch: pytest.MonkeyPatch) -> None:
    """A CLI index lands one sibling later than `positions_after` says."""
    real = planning.order_idx_at_position
    monkeypatch.setattr(planning, "order_idx_at_position",
                        lambda siblings, position: real(siblings, position + 1))
    expect_caught(settings(TEETH, max_examples=200)(
        given(st.data())(cli_batch_positions)),
        "children_match_positions_after")


def test_unlink_keeps_other_refs(monkeypatch: pytest.MonkeyPatch) -> None:
    """A delete unlinks every title, not only the deleted page's. Unlinking
    `[[embed]]` changes no ref the property counts, but the replay, which
    unlinks only the page, no longer reproduces the rewrite."""
    real = unlink.unlink_title_refs
    monkeypatch.setattr(unlink, "unlink_title_refs",
                        lambda text, is_target: real(text, lambda raw: True))
    expect_caught(settings(TEETH, max_examples=200)(
        given(scenario())(delete_rewrite_properties)),
        "other_refs_survive", "replay_reproduces")


def test_assistant_sends_one_interrupt(monkeypatch: pytest.MonkeyPatch
                                       ) -> None:
    """Every interrupt the engine sends goes to the CLI twice."""
    real = ClaudeConversation._interrupt

    async def twice(self: ClaudeConversation, why: str) -> bool:
        await real(self, why)
        return await real(self, why)

    monkeypatch.setattr(ClaudeConversation, "_interrupt", twice)
    expect_caught(lambda: run_state_machine_as_test(TurnMachine, settings=(
        settings(TEETH, max_examples=200, stateful_step_count=30))),
        "one_interrupt_per_turn", "at_most_one_interrupt")
