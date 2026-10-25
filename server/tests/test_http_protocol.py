import socket
import time

import pytest
from uvicorn_harness import closed_within, read_response, serve

from pkm.server import http_protocol
from pkm.server.app import create_app

pytestmark = pytest.mark.filterwarnings(
    "ignore:websockets.*is deprecated:DeprecationWarning")

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
