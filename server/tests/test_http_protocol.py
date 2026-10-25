import asyncio
import socket
import time

import pytest
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
    answer = str(len(body)).encode()
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-length", str(len(answer)).encode())]})
    await send({"type": "http.response.body", "body": answer})


@pytest.fixture()
def wire_port(monkeypatch):
    monkeypatch.setattr(http_protocol, "HEADER_READ_TIMEOUT_S", 0.3)
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
