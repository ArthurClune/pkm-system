# pattern: Functional Core
"""Where a conversation's harness is in its turn, and what moves it on."""

from __future__ import annotations

from typing import Literal

# idle: no turn open; the next query may go.
# streaming: a query went and its ResultMessage has not been read.
# draining: an interrupt was acknowledged and the aborted turn's
#   ResultMessage, which the CLI writes after the ack, has not been read.
# dead: the harness cannot be trusted with another turn.
TurnPhase = Literal["idle", "streaming", "draining", "dead"]

# lost: an interrupt went unacknowledged, the drain timed out, or the
# stream raised or ended before a ResultMessage.
PhaseEvent = Literal["query", "result", "interrupt_acked", "lost"]

_MOVES: dict[tuple[TurnPhase, PhaseEvent], TurnPhase] = {
    ("idle", "query"): "streaming",
    ("streaming", "result"): "idle",
    ("draining", "result"): "idle",
    ("streaming", "interrupt_acked"): "draining",
    # the turn's result was read while the interrupt was in flight, and
    # the CLI acknowledges an interrupt with no turn open with nothing more
    ("idle", "interrupt_acked"): "idle",
}


def next_phase(phase: TurnPhase, event: PhaseEvent) -> TurnPhase:
    """Any move the table lacks means this side is out of step with the
    harness, which is as untrustworthy as a dead one."""
    return _MOVES.get((phase, event), "dead")
