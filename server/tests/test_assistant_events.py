import json

from pkm.assistant.events import (
    ConfirmRequest,
    ErrorEvent,
    Phase,
    TextDelta,
    ToolFinished,
    ToolStarted,
    TurnDone,
    encode_sse,
    event_name,
)


def test_event_names():
    assert event_name(TextDelta(text="hi")) == "text_delta"
    assert event_name(ToolStarted(name="search", summary='searching "x"')) == "tool_started"
    assert event_name(ToolFinished(name="search")) == "tool_finished"
    assert event_name(ConfirmRequest(tool_use_id="c1", ops_preview="Create note")) == "confirm_request"
    assert event_name(TurnDone(usage=None)) == "turn_done"
    assert event_name(ErrorEvent(message="boom")) == "error"
    assert event_name(Phase(label="reasoning")) == "phase"


def test_encode_sse_phase():
    out = encode_sse(Phase(label="preparing save_note"))
    assert out == 'event: phase\ndata: {"label": "preparing save_note"}\n\n'


def test_encode_sse_shape():
    out = encode_sse(TextDelta(text="hello"))
    assert out == 'event: text_delta\ndata: {"text": "hello"}\n\n'


def test_encode_sse_escapes_newlines():
    # SSE data must stay on one line; json escapes \n
    out = encode_sse(TextDelta(text="a\nb"))
    lines = out.split("\n")
    assert lines[0] == "event: text_delta"
    assert json.loads(lines[1][len("data: "):]) == {"text": "a\nb"}
    assert out.endswith("\n\n")


def test_turn_done_usage_serialized():
    out = encode_sse(TurnDone(usage={"input_tokens": 3}))
    assert json.loads(out.split("\n")[1][len("data: "):]) == {"usage": {"input_tokens": 3}}
