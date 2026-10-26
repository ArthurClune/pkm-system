import asyncio
import socket
import time

import pytest
import uvicorn
from uvicorn.server import ServerState
from uvicorn_harness import closed_within, read_response, serve

from pkm.server import http_protocol
from pkm.server.app import create_app
from pkm.server.auth_core import sign_session

pytestmark = [
    pytest.mark.filterwarnings(
        "ignore:websockets.*is deprecated:DeprecationWarning"),
    # uvicorn's legacy websockets handler, met only by the upgrade test
    pytest.mark.filterwarnings(
        "ignore:remove second argument of ws_handler:DeprecationWarning"),
]

HEALTHZ = b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n"


@pytest.fixture()
def port(seeded_config, monkeypatch):
    monkeypatch.setattr(http_protocol, "HEADER_READ_TIMEOUT_S", 0.5)
    with serve(create_app(seeded_config)) as port:
        yield port


def _connect(port: int) -> socket.socket:
    return socket.create_connection(("127.0.0.1", port), timeout=5)


def test_a_connection_that_sends_nothing_is_closed(port):
    with _connect(port) as conn:
        assert closed_within(conn, 3)


def test_a_request_head_dripped_a_byte_at_a_time_is_closed(port):
    head = b"GET /healthz HTTP/1.1\r\nHost: x\r\nX-Pad: " + b"a" * 100
    with _connect(port) as conn:
        assert closed_within(conn, 3, drip=head)


def test_a_keep_alive_client_can_send_a_second_request(port):
    with _connect(port) as conn:
        conn.sendall(HEALTHZ)
        assert read_response(conn).status_line == b"HTTP/1.1 200 OK"
        time.sleep(0.2)
        conn.sendall(HEALTHZ)
        assert read_response(conn).status_line == b"HTTP/1.1 200 OK"


def test_a_late_second_request_head_is_closed(port):
    with _connect(port) as conn:
        conn.sendall(HEALTHZ)
        assert read_response(conn).status_line == b"HTTP/1.1 200 OK"
        assert closed_within(conn, 3, drip=HEALTHZ[:-4] + b"X-Pad: " * 20)


def test_a_body_dripped_after_its_answer_is_closed(port):
    # A public read answers without reading the body it declared; the
    # rest of that body is not a new request head, so it gets no longer.
    head = (b"GET /healthz HTTP/1.1\r\nHost: x\r\n"
            b"Content-Length: 1000\r\n\r\n")
    with _connect(port) as conn:
        conn.sendall(head + b"a")
        assert read_response(conn).status_line == b"HTTP/1.1 200 OK"
        assert closed_within(conn, 3, drip=b"a" * 100)


def test_a_websocket_outlives_the_head_deadline(port, seeded_config):
    # The upgrade hands the transport to the WebSocket protocol without
    # starting a request cycle; the deadline must not close it later.
    cookie = sign_session(bytes.fromhex(seeded_config.session_secret),
                          int(time.time() * 1000))
    handshake = (b"GET /api/ws HTTP/1.1\r\nHost: x\r\n"
                 b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                 b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                 b"Sec-WebSocket-Version: 13\r\n"
                 b"Cookie: pkm_session=" + cookie.encode() + b"\r\n\r\n")
    with _connect(port) as conn:
        conn.sendall(handshake)
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = conn.recv(4096)
            assert chunk, head
            head += chunk
        assert head.startswith(b"HTTP/1.1 101")
        assert not closed_within(conn, 1.5)


# The head deadline holds only between requests. A request whose head is in
# and whose answer is unfinished is never cut, however long it runs, even
# when its deadline was armed by the response before it on a pipelined
# connection. A raw ASGI app keeps the timing in the test's hands.
SLOW_S = 1.0


async def _wire_app(scope, receive, send) -> None:
    if scope["type"] == "lifespan":
        while (message := await receive())["type"] != "lifespan.shutdown":
            await send({"type": "lifespan.startup.complete"})
        await send({"type": "lifespan.shutdown.complete"})
        return
    if scope["type"] == "websocket":
        await receive()
        await send({"type": "websocket.accept"})
        while (await receive())["type"] != "websocket.disconnect":
            pass
        return
    body = b""
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return
        body += message.get("body", b"")
        if not message.get("more_body", False):
            break
    if scope["path"] == "/slow":
        await asyncio.sleep(SLOW_S)
    if scope["path"] in ("/stream", "/one"):
        await _send_large(scope["path"], send)
        return
    answer = str(len(body)).encode()
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-length", str(len(answer)).encode())]})
    await send({"type": "http.response.body", "body": answer})


# /stream sends many small messages, as a file response does; /one sends
# its body in a single message, as a large JSON response does.
STREAM_BYTES = 32 << 20
ONE_BYTES = 4 << 20


async def _send_large(path: str, send) -> None:
    size = STREAM_BYTES if path == "/stream" else ONE_BYTES
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-length", str(size).encode())]})
    if path == "/one":
        await send({"type": "http.response.body", "body": b"a" * size})
        return
    chunk = b"a" * (64 << 10)
    for _ in range(size // len(chunk) - 1):
        await send({"type": "http.response.body", "body": chunk,
                    "more_body": True})
    await send({"type": "http.response.body", "body": chunk})


@pytest.fixture()
def wire_port(monkeypatch):
    monkeypatch.setattr(http_protocol, "HEADER_READ_TIMEOUT_S", 0.3)
    monkeypatch.setattr(http_protocol, "WRITE_STALL_TIMEOUT_S", 0.3)
    with serve(_wire_app) as port:
        yield port


def _get(path: str) -> bytes:
    return f"GET {path} HTTP/1.1\r\nHost: x\r\n\r\n".encode()


def test_a_request_running_past_the_head_deadline_is_answered(wire_port):
    with _connect(wire_port) as conn:
        conn.sendall(_get("/slow"))
        assert read_response(conn).status_line == b"HTTP/1.1 200 OK"


def test_a_body_arriving_past_the_head_deadline_is_answered(wire_port):
    # A slow upload: the head is in, the body takes longer than the
    # deadline to arrive.
    body = b"a" * 15
    head = (b"POST /echo HTTP/1.1\r\nHost: x\r\n"
            b"Content-Length: 15\r\n\r\n")
    with _connect(wire_port) as conn:
        conn.sendall(head)
        for byte in body:
            time.sleep(0.1)
            conn.sendall(bytes([byte]))
        r = read_response(conn)
    assert (r.status_line, r.body) == (b"HTTP/1.1 200 OK", b"15")


def test_a_pipelined_request_running_past_the_deadline_is_answered(
        wire_port):
    # The first response re-arms the deadline after the second request
    # has already started.
    with _connect(wire_port) as conn:
        conn.sendall(_get("/fast") + _get("/slow"))
        assert read_response(conn).status_line == b"HTTP/1.1 200 OK"
        assert read_response(conn).status_line == b"HTTP/1.1 200 OK"


def test_a_pipelined_websocket_outlives_the_head_deadline(wire_port):
    # The first response re-arms the deadline after the upgrade behind it
    # has handed the transport to the WebSocket protocol.
    upgrade = (b"GET /ws HTTP/1.1\r\nHost: x\r\n"
               b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
               b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
               b"Sec-WebSocket-Version: 13\r\n\r\n")
    with _connect(wire_port) as conn:
        conn.sendall(_get("/fast") + upgrade)
        data = b""
        while b"HTTP/1.1 101" not in data or not data.endswith(b"\r\n\r\n"):
            chunk = conn.recv(4096)
            assert chunk, data
            data += chunk
        assert data.startswith(b"HTTP/1.1 200 OK")
        assert not closed_within(conn, 1.5)


# A response the client stops taking. While writing is paused (the
# client's buffers are full) or the response is finished with bytes still
# unsent, some of it must leave within the stall deadline (0.3 s here).

def _small_window(port: int) -> socket.socket:
    conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    conn.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 16 << 10)
    conn.settimeout(5)
    conn.connect(("127.0.0.1", port))
    return conn


def _body_bytes_until_closed(conn: socket.socket) -> int:
    data = b""
    while True:
        try:
            chunk = conn.recv(1 << 20)
        except OSError:  # reset by an aborted server
            break
        if not chunk:
            break
        data += chunk
    return len(data.partition(b"\r\n\r\n")[2])


def test_a_client_that_stops_reading_a_response_is_cut(wire_port):
    with _small_window(wire_port) as conn:
        conn.sendall(_get("/stream"))
        time.sleep(2)
        assert _body_bytes_until_closed(conn) < STREAM_BYTES


def test_a_slow_reader_of_one_large_message_is_not_cut(wire_port,
                                                      monkeypatch):
    # Writing stays paused for seconds while the one message drains, but
    # the client takes some of it in every stall window. The kernel moves
    # bytes out of the transport in steps of a few hundred KiB, so the
    # window is a second here and the client reads about 1.5 MiB/s.
    monkeypatch.setattr(http_protocol, "WRITE_STALL_TIMEOUT_S", 1.0)
    with _small_window(wire_port) as conn:
        conn.sendall(_get("/one"))
        data = b""
        while b"\r\n\r\n" not in data or (
                len(data.partition(b"\r\n\r\n")[2]) < ONE_BYTES):
            chunk = conn.recv(16 << 10)
            assert chunk, len(data)
            data += chunk
            time.sleep(0.01)
    assert data.startswith(b"HTTP/1.1 200 OK")


class _Transport:
    """Just enough of an asyncio transport to hold `unsent` bytes."""

    def __init__(self, unsent: int) -> None:
        self.unsent = unsent
        self.closing = False
        self.aborted = False
        self.protocol = None

    def get_write_buffer_size(self) -> int:
        return self.unsent

    def get_protocol(self):
        return self.protocol

    def get_extra_info(self, name, default=None):
        return default

    def is_closing(self) -> bool:
        return self.closing

    def close(self) -> None:
        self.closing = True

    def abort(self) -> None:
        self.aborted = self.closing = True

    def pause_reading(self) -> None:
        pass

    def resume_reading(self) -> None:
        pass


def _after_a_finished_response(unsent: int, drain_by: int,
                               upgraded: bool = False) -> bool:
    """Whether the connection is aborted when a response finished with
    `unsent` bytes left in the transport and the client then takes
    `drain_by` bytes every tenth of a second, the stall deadline being a
    quarter of a second. `upgraded`: the transport has been handed on, as
    a WebSocket upgrade pipelined behind the response hands it."""
    async def scenario() -> bool:
        loop = asyncio.get_running_loop()
        protocol = http_protocol.DeadlineH11Protocol(
            config=uvicorn.Config(_wire_app), server_state=ServerState(),
            app_state={}, _loop=loop)
        transport = _Transport(unsent)
        protocol.connection_made(transport)  # type: ignore[arg-type]
        transport.protocol = object() if upgraded else protocol
        protocol.on_response_complete()
        for _ in range(10):
            await asyncio.sleep(0.1)
            transport.unsent = max(0, transport.unsent - drain_by)
        protocol.connection_lost(None)
        return transport.aborted

    return asyncio.run(scenario())


def test_a_finished_response_the_client_stops_taking_is_cut(monkeypatch):
    monkeypatch.setattr(http_protocol, "WRITE_STALL_TIMEOUT_S", 0.25)
    assert _after_a_finished_response(unsent=10_000, drain_by=0)


def test_a_finished_response_the_client_keeps_taking_is_not_cut(
        monkeypatch):
    monkeypatch.setattr(http_protocol, "WRITE_STALL_TIMEOUT_S", 0.25)
    assert not _after_a_finished_response(unsent=10_000, drain_by=500)


def test_a_transport_handed_to_a_websocket_is_not_watched(monkeypatch):
    monkeypatch.setattr(http_protocol, "WRITE_STALL_TIMEOUT_S", 0.25)
    assert not _after_a_finished_response(unsent=10_000, drain_by=0,
                                          upgraded=True)
