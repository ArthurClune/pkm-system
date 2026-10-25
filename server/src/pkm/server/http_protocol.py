# pattern: Imperative Shell
"""uvicorn's h11 protocol with deadlines on the request head and on a
response the client stops taking.

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

uvicorn also waits without limit for a client to read: its `send` awaits
the transport's drain while writing is paused, and a close waits for
unsent bytes to leave. So a client that requests a large response and
reads nothing holds the connection for good. While nothing more can be
written until the client takes some (writing is paused, or the response
is finished with bytes unsent), some of those bytes must leave within
`WRITE_STALL_TIMEOUT_S`, or the connection is aborted. The rule is about
progress, not how long writing stays paused: one large message (a big
JSON response) keeps writing paused until nearly all of it has gone, and
a slow reader of it must not be cut. Progress is measured by the
transport's buffer shrinking, which is sound only in those two states,
because then nothing else adds to it.

It leans on uvicorn internals (`self.cycle`, `self.flow`,
`on_response_complete`, `pause_writing`); the real-socket tests in
`test_http_protocol.py` are what catch an upgrade that moves them. Only
`run.uvicorn_config` installs it."""
from __future__ import annotations

import asyncio
from typing import Final

import h11
from uvicorn.protocols.http.h11_impl import H11Protocol

# Ten seconds for a request head of a few hundred bytes: far beyond any
# honest client, short enough that a pool of held connections drains.
HEADER_READ_TIMEOUT_S: Final = 10.0
# As nginx's send_timeout: a client must take some of a waiting response
# every minute. One reading at any speed a person would use takes bytes
# every few milliseconds; a minute leaves room for a phone moving between
# networks, while a pool of clients that read nothing still drains.
WRITE_STALL_TIMEOUT_S: Final = 60.0


class DeadlineH11Protocol(H11Protocol):
    _head_deadline: asyncio.TimerHandle | None = None
    _write_stall: asyncio.TimerHandle | None = None

    def connection_made(self, transport: asyncio.Transport) -> None:  # type: ignore[override]
        super().connection_made(transport)
        self._arm_head_deadline()

    def handle_websocket_upgrade(self, event: h11.Request) -> None:
        # Tidiness only: a pipelined upgrade is re-armed after this by the
        # response before it, and the owner checks at fire time spare it.
        self._disarm_head_deadline()
        self._disarm_write_stall()
        super().handle_websocket_upgrade(event)

    def on_response_complete(self) -> None:
        super().on_response_complete()
        if not self.transport.is_closing():
            self._arm_head_deadline()
        self._watch_unsent()

    def pause_writing(self) -> None:
        super().pause_writing()
        self._watch_unsent()

    def resume_writing(self) -> None:
        super().resume_writing()
        self._watch_unsent()

    def connection_lost(self, exc: Exception | None) -> None:
        self._disarm_head_deadline()
        self._disarm_write_stall()
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

    def _unsent_awaiting_client(self) -> int:
        """Bytes the client has yet to take while nothing more can be
        written until it takes some: writing is paused, or no request is
        in progress. Zero in any other state, where the app may still be
        adding to the buffer and its size says nothing about the client."""
        if self.transport.get_protocol() is not self or not (
                self.flow.write_paused or not self._request_in_progress()):
            return 0
        return self.transport.get_write_buffer_size()

    def _watch_unsent(self) -> None:
        self._disarm_write_stall()
        unsent = self._unsent_awaiting_client()
        if unsent:
            self._write_stall = self.loop.call_later(
                WRITE_STALL_TIMEOUT_S, self._write_stall_passed, unsent)

    def _disarm_write_stall(self) -> None:
        if self._write_stall is not None:
            self._write_stall.cancel()
            self._write_stall = None

    def _write_stall_passed(self, unsent_then: int) -> None:
        self._write_stall = None
        unsent = self._unsent_awaiting_client()
        if not unsent:
            return
        if unsent < unsent_then:
            self._write_stall = self.loop.call_later(
                WRITE_STALL_TIMEOUT_S, self._write_stall_passed, unsent)
            return
        # Not close(): a close waits for these very bytes to leave.
        self.transport.abort()

    def _head_deadline_passed(self) -> None:
        self._head_deadline = None
        if (self.transport.get_protocol() is self
                and not self._request_in_progress()
                and not self.transport.is_closing()):
            self.transport.close()
