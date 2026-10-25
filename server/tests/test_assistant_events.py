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
    tool_error_reason,
)
from pkm.assistant.write_preview import (CreatedInBatch, FoundBlock,
                                         MissingBlock, PreviewOp,
                                         WritePreview)
from pkm.test_data.ids import canonical_title_of, confirm_id_of

_PREVIEW = WritePreview(
    ops=[PreviewOp(action="update block", targets=[("uid", "U1")],
                   content=[("text", "hi", 2)], warnings=["careful"],
                   current=FoundBlock(canonical_title_of("Inbox"), "old", 3))],
    summary='update_block: uid="U1"', writes_in_flight=False)


def test_event_names():
    assert event_name(TextDelta(text="hi")) == "text_delta"
    assert event_name(ToolStarted(tool_use_id="t1", name="search", summary='searching "x"')) == "tool_started"
    assert event_name(ToolFinished(tool_use_id="t1", name="search")) == "tool_finished"
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
                                 "text_length": 3, "descendants": None,
                                 "state": "found"}}],
            "summary": 'update_block: uid="U1"',
            "writes_in_flight": False,
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
    assert _sse_current(FoundBlock(canonical_title_of("Inbox"), "old", 3,
                                   2)) == {
        "page_title": "Inbox", "excerpt": "old", "text_length": 3,
        "descendants": 2, "state": "found"}
    # a create touches no existing block
    assert _sse_current(None) is None


def test_tool_error_reason_reads_text_items_and_drops_fastmcp_prefix():
    content = [{"type": "text", "text": "Error executing tool update_block: "
                "block ((AbC)) changed after the approval card showed it, "
                "so nothing was written"},
               {"type": "image", "data": "x"}]
    assert tool_error_reason(content) == (
        "block ((AbC)) changed after the approval card showed it, "
        "so nothing was written")
    assert tool_error_reason("plain reason") == "plain reason"
    assert tool_error_reason("a: Error executing tool x: b") == (
        "a: Error executing tool x: b")  # prefix only at the start
    assert tool_error_reason([{"type": "text", "text": "a"},
                              {"type": "text", "text": "b"}]) == "a\nb"


_REFUSAL = ("block ((AbC)) changed after the approval card showed it, "
            "so nothing was written")


def test_tool_error_reason_of_a_refused_allow_from_the_real_harness():
    # The content a live run delivered (haiku, bundled CLI, SDK 0.2.168):
    # the MCP isError text as is, unwrapped. "412: " is pkm's ApiError.
    content = ("Error executing tool update_block: 412: block "
               "((lr1792953900)) changed after the approval card showed it, "
               "so nothing was written")
    assert tool_error_reason(content) == (
        "412: block ((lr1792953900)) changed after the approval card "
        "showed it, so nothing was written")


def test_tool_error_reason_drops_the_cli_wrapper_then_the_fastmcp_prefix():
    # unwrapped, as FastMCP's isError text
    assert tool_error_reason(
        f"Error executing tool update_block: {_REFUSAL}") == _REFUSAL
    # wrapped, no prefix: the shape of the CLI's own deny results
    assert tool_error_reason(
        f"<tool_use_error>{_REFUSAL}</tool_use_error>") == _REFUSAL
    # wrapped with the FastMCP prefix, and with the CLI's own prefixes
    assert tool_error_reason(
        "<tool_use_error>Error executing tool update_block: "
        f"{_REFUSAL}</tool_use_error>") == _REFUSAL
    assert tool_error_reason(
        "<tool_use_error>Error: Error executing tool update_block: "
        f"{_REFUSAL}</tool_use_error>") == _REFUSAL
    assert tool_error_reason(
        "<tool_use_error>Error calling tool (mcp__pkm__update_block): "
        f"Error executing tool update_block: {_REFUSAL}</tool_use_error>"
    ) == _REFUSAL
    assert tool_error_reason([{"type": "text", "text": (
        f"  <tool_use_error>{_REFUSAL}</tool_use_error>\n")}]) == _REFUSAL


def test_tool_error_reason_keeps_a_wrapper_that_is_not_the_whole_text():
    text = f"see <tool_use_error>{_REFUSAL}</tool_use_error>"
    assert tool_error_reason(text) == text
    assert tool_error_reason("<tool_use_error>a") == "<tool_use_error>a"
    assert tool_error_reason("<tool_use_error></tool_use_error>") == (
        "no reason given")


def test_tool_error_reason_empty_and_clipped():
    assert tool_error_reason(None) == "no reason given"
    assert tool_error_reason("  ") == "no reason given"
    assert tool_error_reason("x" * 300) == "x" * 300
    assert tool_error_reason("x" * 1301) == "x" * 300 + "… (1,301 characters)"


def test_tool_finished_encodes_its_error_and_decline():
    frame = encode_sse(ToolFinished(tool_use_id="t1", name="update_block",
                                    error="nope"))
    assert '"tool_use_id": "t1"' in frame and '"error": "nope"' in frame
    assert '"declined": false' in frame
    bare = encode_sse(ToolFinished(tool_use_id="t1", name="search"))
    assert '"error": null' in bare
    declined = encode_sse(ToolFinished(tool_use_id="t1", name="update_block",
                                       declined=True))
    assert '"declined": true' in declined and '"error": null' in declined
