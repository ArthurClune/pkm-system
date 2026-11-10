# pattern: Functional Core
"""Where a conversation's harness is in its turn, and what moves it on."""

from __future__ import annotations

from typing import Literal

# idle: no turn open; the next query may go.
# querying: the prompt is being written; it may already have reached the
#   harness, so a turn may be running.
# streaming: a query went and its ResultMessage has not been read.
# interrupting: an interrupt is in flight. The pump sent it and handles
#   no message until it is answered (its read may already hold one), so no
#   result is handled in this phase.
# draining: an interrupt was acknowledged and the aborted turn's
#   ResultMessage, which the CLI writes after the ack, has not been read.
# dead: the harness cannot be trusted with another turn.
TurnPhase = Literal["idle", "querying", "streaming", "interrupting",
                    "draining", "dead"]

# lost: a query or interrupt failed or was abandoned, an interrupt went
# unacknowledged, the drain timed out, the stream raised or ended before a
# ResultMessage, or the conversation closed.
PhaseEvent = Literal["query", "query_sent", "interrupt", "interrupt_acked",
                     "result", "lost"]

_MOVES: dict[tuple[TurnPhase, PhaseEvent], TurnPhase] = {
    ("idle", "query"): "querying",
    ("querying", "query_sent"): "streaming",
    ("streaming", "result"): "idle",
    ("streaming", "interrupt"): "interrupting",
    ("interrupting", "interrupt_acked"): "draining",
    ("draining", "result"): "idle",
}


def next_phase(phase: TurnPhase, event: PhaseEvent) -> TurnPhase:
    """Any move the table lacks means this side is out of step with the
    harness, which is as untrustworthy as a dead one."""
    return _MOVES.get((phase, event), "dead")
