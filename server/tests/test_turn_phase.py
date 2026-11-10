import pytest

from pkm.assistant.turn_phase import next_phase


@pytest.mark.parametrize(("phase", "event", "after"), [
    ("idle", "query", "querying"),
    ("querying", "query_sent", "streaming"),
    ("streaming", "result", "idle"),
    ("streaming", "interrupt", "interrupting"),
    ("interrupting", "interrupt_acked", "draining"),
    ("draining", "result", "idle"),
    ("idle", "lost", "dead"),
    ("querying", "lost", "dead"),
    ("streaming", "lost", "dead"),
    ("interrupting", "lost", "dead"),
    ("draining", "lost", "dead"),
    ("dead", "query", "dead"),
    ("dead", "result", "dead"),
    # out of step with the harness: never trusted again
    ("idle", "result", "dead"),
    ("idle", "interrupt_acked", "dead"),
    ("querying", "result", "dead"),
    ("querying", "interrupt", "dead"),
    ("streaming", "query", "dead"),
    ("streaming", "interrupt_acked", "dead"),
    ("interrupting", "interrupt", "dead"),
    ("interrupting", "result", "dead"),
    ("draining", "query", "dead"),
    ("draining", "interrupt", "dead"),
    ("draining", "interrupt_acked", "dead"),
])
def test_next_phase(phase, event, after):
    assert next_phase(phase, event) == after
