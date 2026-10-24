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
from pkm.assistant.write_preview import (CreatedInBatch, FoundBlock,
                                         MissingBlock, PreviewOp,
                                         WritePreview)
from pkm.test_data.ids import canonical_title_of, confirm_id_of

_PREVIEW = WritePreview(
    ops=[PreviewOp(action="update block", targets=[("uid", "U1")],
                   content=[("text", "hi", 2)], warnings=["careful"],
                   current=FoundBlock(canonical_title_of("Inbox"), "old", 3))],
    summary='update_block: uid="U1"')


def test_event_names():
    assert event_name(TextDelta(text="hi")) == "text_delta"
    assert event_name(ToolStarted(name="search", summary='searching "x"')) == "tool_started"
    assert event_name(ToolFinished(name="search")) == "tool_finished"
    card = ConfirmRequest(confirm_id=confirm_id_of("c1"),
                          ops_preview=_PREVIEW.summary, preview=_PREVIEW)
    assert event_name(card) == "confirm_request"
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


def test_confirm_request_sse_shape():
    # The web card parses exactly this shape: tuples arrive as arrays.
    out = encode_sse(ConfirmRequest(confirm_id=confirm_id_of("c1"),
                                    ops_preview=_PREVIEW.summary,
                                    preview=_PREVIEW))
    head, data, *_ = out.split("\n")
    assert head == "event: confirm_request"
    assert json.loads(data[len("data: "):]) == {
        "confirm_id": "c1",
        "ops_preview": 'update_block: uid="U1"',
        "preview": {
            "ops": [{"action": "update block",
                     "targets": [["uid", "U1"]],
                     "content": [["text", "hi", 2]],
                     "warnings": ["careful"],
                     "current": {"page_title": "Inbox", "excerpt": "old",
                                 "text_length": 3, "state": "found"}}],
            "summary": 'update_block: uid="U1"',
        },
    }


def _sse_current(current):
    op = PreviewOp(action="a", targets=[], content=[], warnings=[],
                   current=current)
    out = encode_sse(ConfirmRequest(
        confirm_id=confirm_id_of("c1"), ops_preview="s",
        preview=WritePreview(ops=[op], summary="s")))
    data = json.loads(out.split("\n")[1][len("data: "):])
    return data["preview"]["ops"][0]["current"]


def test_current_block_sse_shapes():
    assert _sse_current(MissingBlock()) == {"state": "missing"}
    assert _sse_current(CreatedInBatch(write=2, alias="m")) == {
        "write": 2, "alias": "m", "state": "created"}
    # a create touches no existing block
    assert _sse_current(None) is None
