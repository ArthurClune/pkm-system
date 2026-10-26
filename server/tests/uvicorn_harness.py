"""A real uvicorn socket, loaded as `run.uvicorn_config` loads production's.

For tests whose subject is what the server does on the wire: what it
reads, when it answers, when it closes."""
import select
import socket
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass

import pytest
import uvicorn

from pkm.server import run as run_module

# cfg.load() imports uvicorn's websockets protocol, which warns on import.
uvicorn_warning = pytest.mark.filterwarnings(
    "ignore:websockets.*is deprecated:DeprecationWarning")


@contextmanager
def serve(app) -> Generator[int, None, None]:
    """Serves `app` on a free loopback port until the block exits."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(run_module.uvicorn_config(app, port=port,
                                                      log_config=None))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]},
                              daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        assert thread.is_alive() and time.monotonic() < deadline
        time.sleep(0.01)
    try:
        yield port
    finally:
        server.should_exit = True
        thread.join(10)
        sock.close()


@dataclass
class Response:
    status_line: bytes
    headers: dict[bytes, bytes]
    body: bytes


def read_response(conn: socket.socket) -> Response:
    """One whole response off `conn`, framed by its Content-Length."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(65536)
        assert chunk, f"closed before a response head: {data!r}"
        data += chunk
    head, _, body = data.partition(b"\r\n\r\n")
    status_line, *lines = head.split(b"\r\n")
    headers = {name.strip().lower(): value.strip() for name, _, value in
               (line.partition(b":") for line in lines)}
    length = int(headers.get(b"content-length", b"0"))
    while len(body) < length:
        chunk = conn.recv(65536)
        assert chunk, "closed inside a response body"
        body += chunk
    return Response(status_line, headers, body[:length])


def closed_within(conn: socket.socket, seconds: float,
                  drip: bytes = b"") -> bool:
    """Whether the server closes `conn` within `seconds`, the client
    sending `drip` one byte every tenth of a second meanwhile."""
    deadline = time.monotonic() + seconds
    sent = 0
    while time.monotonic() < deadline:
        if sent < len(drip):
            try:
                conn.sendall(drip[sent:sent + 1])
            except OSError:  # reset by a server that already closed
                return True
            sent += 1
        readable, _, _ = select.select([conn], [], [], 0.1)
        if readable:
            try:
                if conn.recv(65536) == b"":
                    return True
            except OSError:
                return True
    return False
