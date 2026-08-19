# pattern: Functional Core
"""Assistant event union and SSE encoding.

Routes and the web UI speak only these events; nothing engine-specific
leaks upward (see the pkm-wn2s design spec).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ToolStarted:
    name: str
    summary: str


@dataclass(frozen=True)
class ToolFinished:
    name: str


@dataclass(frozen=True)
class ConfirmRequest:
    tool_use_id: str
    ops_preview: str


@dataclass(frozen=True)
class Phase:
    """What the model is doing during an otherwise silent stretch (pkm-e9ok).

    The label is display text built server-side (precedent: ToolStarted's
    summary): "reasoning", "preparing <tool>", "replying".
    """

    label: str


@dataclass(frozen=True)
class TurnDone:
    usage: dict | None = None


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


def event_name(event: AssistantEvent) -> str:
    return _EVENT_NAMES[type(event)]


def encode_sse(event: AssistantEvent) -> str:
    data = json.dumps(asdict(event), ensure_ascii=False)
    return f"event: {event_name(event)}\ndata: {data}\n\n"


# An SSE comment frame: no event name, so a conforming client (and this
# project's own parser, web/src/assistant/sse.ts) discards it. Written
# periodically into an otherwise silent turn -- see routes.KEEPALIVE_INTERVAL_S.
SSE_COMMENT = ": keepalive\n\n"
