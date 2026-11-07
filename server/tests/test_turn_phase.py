import pytest

from pkm.assistant.turn_phase import next_phase


@pytest.mark.parametrize(("phase", "event", "after"), [
    ("idle", "query", "streaming"),
    ("streaming", "result", "idle"),
    ("streaming", "interrupt_acked", "draining"),
    ("draining", "result", "idle"),
    ("idle", "interrupt_acked", "idle"),
    ("streaming", "lost", "dead"),
    ("draining", "lost", "dead"),
    ("dead", "query", "dead"),
    ("dead", "result", "dead"),
    # out of step with the harness: never trusted again
    ("streaming", "query", "dead"),
    ("draining", "query", "dead"),
    ("idle", "result", "dead"),
    ("draining", "interrupt_acked", "dead"),
])
def test_next_phase(phase, event, after):
    assert next_phase(phase, event) == after
