# pattern: Functional Core
"""Assistant event union and SSE encoding.

Routes and the web UI speak only these events; nothing engine-specific
leaks upward.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from typing import Any

from pkm.assistant.write_preview import WritePreview
from pkm.contracts.responses import ConfirmId


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ToolStarted:
    tool_use_id: str
    name: str
    summary: str


@dataclass(frozen=True)
class ToolFinished:
    """A tool call's result.

    `error` is a write tool's failure reason (set only when the harness
    marked the result an error and the user did not decline the card).
    `declined` is True when the user answered the card with a decline, so
    the panel can show that as neither a success nor a failure.
    """

    tool_use_id: str
    name: str
    error: str | None = None
    declined: bool = False


@dataclass(frozen=True)
class ConfirmRequest:
    confirm_id: ConfirmId
    # preview.summary: one line for logs and transcripts.
    ops_preview: str
    # What the approval card renders.
    preview: WritePreview


@dataclass(frozen=True)
class Phase:
    """What the model is doing during an otherwise silent stretch.

    The label is display text built server-side (precedent: ToolStarted's
    summary): "reasoning", "preparing <tool>", "replying".
    """

    label: str


@dataclass(frozen=True)
class TurnDone:
    usage: dict[str, object] | None = None


@dataclass(frozen=True)
class ErrorEvent:
    message: str


AssistantEvent = (
    TextDelta | ToolStarted | ToolFinished | Phase | ConfirmRequest | TurnDone | ErrorEvent
)

_EVENT_NAMES: dict[type, str] = {
    TextDelta: "text_delta",
    ToolStarted: "tool_started",
    ToolFinished: "tool_finished",
    Phase: "phase",
    ConfirmRequest: "confirm_request",
    TurnDone: "turn_done",
    ErrorEvent: "error",
}


# A failed write's reason can echo model-chosen input, so it is clipped
# before it reaches the stream (the Refusal clip's format).
TOOL_ERROR_LIMIT_CHARS = 300

# The bundled CLI wraps the error results it builds itself (input that
# fails the schema, a permission-rule deny) in this tag, around the whole
# text; an MCP tool's isError text arrives unwrapped. A tag inside the
# text is the tool's own.
_CLI_WRAPPER = re.compile(r"<tool_use_error>(.*)</tool_use_error>", re.DOTALL)
# What the CLI puts before a thrown error's message: "Error: ", or
# "Error calling tool (<name>): ".
_CLI_PREFIX = re.compile(r"^Error(?: calling tool \([^)]*\))?: ")
# FastMCP wraps a raising tool's message in this, at the start only.
_FASTMCP_PREFIX = re.compile(r"^Error executing tool \w+: ")


def tool_error_reason(content: str | list[dict[str, Any]] | None) -> str:
    """The text a failed tool result carries, short enough for a panel line."""
    if isinstance(content, str):
        text = content
    elif content:
        text = "\n".join(str(item.get("text", "")) for item in content
                         if item.get("type") == "text")
    else:
        text = ""
    text = text.strip()
    if wrapped := _CLI_WRAPPER.fullmatch(text):
        text = wrapped.group(1).strip()
    text = _CLI_PREFIX.sub("", text, count=1)
    text = _FASTMCP_PREFIX.sub("", text, count=1).strip()
    if not text:
        return "no reason given"
    if len(text) > TOOL_ERROR_LIMIT_CHARS:
        return text[:TOOL_ERROR_LIMIT_CHARS] + f"… ({len(text):,} characters)"
    return text


def event_name(event: AssistantEvent) -> str:
    return _EVENT_NAMES[type(event)]


def encode_sse(event: AssistantEvent) -> str:
    data = json.dumps(asdict(event), ensure_ascii=False)
    return f"event: {event_name(event)}\ndata: {data}\n\n"


# An SSE comment frame: no event name, so a conforming client (and this
# project's own parser, web/src/assistant/sse.ts) discards it. Written
# periodically into an otherwise silent turn -- see routes.KEEPALIVE_INTERVAL_S.
SSE_COMMENT = ": keepalive\n\n"
