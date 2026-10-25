# pattern: Imperative Shell
"""uvicorn's h11 protocol with a deadline on the request head.

uvicorn has no header read timeout. Its keep-alive timer is armed only
after a response and is cancelled by any byte that arrives, so a client
that connects and sends nothing, or drips a request head a byte at a time,
holds the connection for as long as it likes. `DeadlineH11Protocol` gives
each request `HEADER_READ_TIMEOUT_S` to arrive whole, counted from the
connection's open or from its last response, and closes the connection
when it is late.

The deadline holds only while no request is in progress, that is before
the first head and after each response. So the remains of a body the app
answered without reading (a refused one, or a public `GET` that declared
one) count against the next head's deadline too. A request whose head is
in and whose response has not finished is never cut: an authenticated
upload may stream for minutes. A WebSocket upgrade hands the transport to
the WebSocket protocol, which uvicorn does without starting a request.

The timer is armed at the connection's open and after each response and
is not disarmed when a head arrives. What keeps it off a request and off
a WebSocket are the checks at fire time: no request in progress, and the
transport still ours. On a pipelined connection the deadline is re-armed
after the next request has started, or after an upgrade behind it has
taken the transport, so those checks are the guard, not any disarm.

It leans on uvicorn internals (`self.conn`, `self.cycle`,
`on_response_complete`); the real-socket tests in `test_http_protocol.py`
are what catch an upgrade that moves them. Only `run.uvicorn_config`
installs it."""
from __future__ import annotations

import asyncio

import h11
from uvicorn.protocols.http.h11_impl import H11Protocol

# Ten seconds for a request head of a few hundred bytes: far beyond any
# honest client, short enough that a pool of held connections drains.
HEADER_READ_TIMEOUT_S = 10.0


class DeadlineH11Protocol(H11Protocol):
    _head_deadline: asyncio.TimerHandle | None = None

    def connection_made(self, transport: asyncio.Transport) -> None:  # type: ignore[override]
        super().connection_made(transport)
        self._arm_head_deadline()

    def handle_websocket_upgrade(self, event: h11.Request) -> None:
        # Tidiness only: a pipelined upgrade is re-armed after this by the
        # response before it, and the owner check at fire time spares it.
        self._disarm_head_deadline()
        super().handle_websocket_upgrade(event)

    def on_response_complete(self) -> None:
        super().on_response_complete()
        if not self.transport.is_closing():
            self._arm_head_deadline()

    def connection_lost(self, exc: Exception | None) -> None:
        self._disarm_head_deadline()
        super().connection_lost(exc)

    def _request_in_progress(self) -> bool:
        return self.cycle is not None and not self.cycle.response_complete

    def _arm_head_deadline(self) -> None:
        self._disarm_head_deadline()
        self._head_deadline = self.loop.call_later(
            HEADER_READ_TIMEOUT_S, self._head_deadline_passed)

    def _disarm_head_deadline(self) -> None:
        if self._head_deadline is not None:
            self._head_deadline.cancel()
            self._head_deadline = None

    def _head_deadline_passed(self) -> None:
        self._head_deadline = None
        if (self.transport.get_protocol() is self
                and not self._request_in_progress()
                and not self.transport.is_closing()):
            self.transport.close()
