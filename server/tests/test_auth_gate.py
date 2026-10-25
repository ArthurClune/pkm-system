import asyncio
import json
import logging
import socket
import threading
import time
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field

import pytest
import uvicorn
from conftest import TEST_PASSWORD
from fastapi.testclient import TestClient
from test_auth import _walk_app

from pkm.server import run as run_module
from pkm.server.app import create_app
from pkm.server.auth_core import sign_session
from pkm.server.auth_gate import AuthGateMiddleware
from pkm.server.auth_gate_core import (PUBLIC_BODY_MAX_BYTES,
                                       declared_over_cap, is_public)

MiB64 = 64 << 20
TWO_YEARS_MS = 2 * 365 * 24 * 3600 * 1000


@dataclass
class Sent:
    status: int | None = None
    consumed: int = 0  # bytes `receive` handed out before response start
    body: bytes = b""
    headers: list[tuple[bytes, bytes]] = field(default_factory=list)


async def _stream(app, method: str, path: str, content_type: str, total: int,
                  *, chunk: int = 1 << 20, prefix: bytes = b"",
                  suffix: bytes = b"",
                  headers: Sequence[tuple[bytes, bytes]] = (),
                  cookie: str | None = None,
                  parts: Sequence[bytes] | None = None) -> Sent:
    """Drives the ASGI app with a body of `prefix`, `total` bytes of filler
    and `suffix`, handed out lazily so a large body is never held whole.
    `parts`, when given, is the body message by message instead."""
    sent = Sent()
    handed = 0
    pieces = iter(parts if parts is not None
                  else [prefix, *[b"a" * chunk] * (total // chunk), suffix])

    async def receive():
        nonlocal handed
        piece = next(pieces, None)
        if piece is None:
            return {"type": "http.request", "body": b"", "more_body": False}
        handed += len(piece)
        return {"type": "http.request", "body": piece, "more_body": True}

    async def send(message):
        if message["type"] == "http.response.start" and sent.status is None:
            sent.status = message["status"]
            sent.consumed = handed
            sent.headers = list(message.get("headers", []))
        elif message["type"] == "http.response.body":
            sent.body += message.get("body", b"")

    scope_headers = [(b"host", b"x"), (b"content-type", content_type.encode()),
                     *headers]
    if cookie is not None:
        scope_headers.append(
            (b"cookie", f"pkm_session={cookie}".encode("utf-8")))
    scope = {"type": "http", "asgi": {"version": "3.0"},
             "http_version": "1.1", "method": method, "scheme": "http",
             "path": path, "raw_path": path.encode(), "query_string": b"",
             "root_path": "", "headers": scope_headers,
             "client": ("100.64.0.5", 1), "server": ("x", 80), "state": {}}
    await app(scope, receive, send)
    return sent


def run(coro) -> Sent:
    return asyncio.run(asyncio.wait_for(coro, 10))


@pytest.fixture()
def client_cookie(seeded_config) -> str:
    return sign_session(bytes.fromhex(seeded_config.session_secret),
                        int(time.time() * 1000))


def test_an_anonymous_json_body_is_refused_unread(seeded_config):
    app = create_app(seeded_config)
    s = run(_stream(app, "POST", "/api/ops", "application/json", MiB64,
                    prefix=b'{"x":"', suffix=b'"}'))
    assert (s.status, s.consumed) == (401, 0)
    assert json.loads(s.body) == {"detail": "not authenticated"}


def test_an_anonymous_upload_is_refused_unread(seeded_config):
    app = create_app(seeded_config)
    prefix = (b"--BND\r\ncontent-disposition: form-data; name=\"file\"; "
              b"filename=\"a.png\"\r\ncontent-type: image/png\r\n\r\n")
    s = run(_stream(app, "POST", "/api/assets",
                    "multipart/form-data; boundary=BND", MiB64,
                    prefix=prefix, suffix=b"\r\n--BND--\r\n"))
    assert (s.status, s.consumed) == (401, 0)
    assert list(seeded_config.assets_dir.glob(".upload-*")) == []


def test_an_anonymous_form_body_is_refused_unread(seeded_config):
    app = create_app(seeded_config)
    s = run(_stream(app, "POST", "/api/assets/export.zip",
                    "application/x-www-form-urlencoded", 8 << 20,
                    prefix=b"x="))
    assert (s.status, s.consumed) == (401, 0)


def test_a_garbage_cookie_is_anonymous_and_refused_unread(seeded_config):
    app = create_app(seeded_config)
    s = run(_stream(app, "POST", "/api/ops", "application/json", 1 << 20,
                    prefix=b'{"x":"', suffix=b'"}', cookie="v1.123.é"))
    assert (s.status, s.consumed) == (401, 0)


def test_a_foreign_origin_is_refused_403_before_the_gate(seeded_config):
    app = create_app(seeded_config)
    s = run(_stream(app, "POST", "/api/ops", "application/json", 1 << 20,
                    prefix=b'{"x":"', suffix=b'"}',
                    headers=[(b"origin", b"https://evil.example")]))
    assert (s.status, s.consumed) == (403, 0)


def test_an_authenticated_body_reaches_the_route(seeded_config,
                                                client_cookie):
    app = create_app(seeded_config)
    body = json.dumps({"kind": "replica-corruption", "error": "x" * 32768,
                       "report": {}, "client": {}}).encode()
    s = run(_stream(app, "POST", "/api/client/diagnostics",
                    "application/json", 0, prefix=body, cookie=client_cookie))
    assert s.status == 200


def test_the_gate_401_is_logged_and_carries_the_security_header(
        anon_client, caplog):
    with caplog.at_level(logging.INFO, logger="pkm.access"):
        r = anon_client.post("/api/ops", json={})
    assert r.status_code == 401
    assert r.headers["x-dns-prefetch-control"] == "off"
    lines = [rec.message for rec in caplog.records if rec.name == "pkm.access"]
    assert len(lines) == 1
    assert '"POST /api/ops" 401 ' in lines[0]


@pytest.mark.parametrize("scope_type,method,path,public", [
    ("http", "GET", "/", True), ("http", "HEAD", "/", True),
    ("http", "GET", "/login", True), ("http", "GET", "/healthz", True),
    ("http", "HEAD", "/healthz", True),
    ("http", "GET", "/app-assets/index-abc.js", True),
    ("http", "GET", "/sw.js", True), ("http", "GET", "/page/Foo", True),
    ("http", "POST", "/api/login", True),
    ("http", "GET", "/api/login", False), ("http", "POST", "/login", False),
    ("http", "POST", "/api/login/", False),
    ("http", "GET", "/api", False), ("http", "GET", "/api/", False),
    ("http", "GET", "/api/sidebar", False),
    ("http", "GET", "/assets", False), ("http", "GET", "/assets/x/y", False),
    ("http", "OPTIONS", "/", False), ("http", "PUT", "/page/Foo", False),
    ("http", "POST", "/", False),
    ("http", "GET", "", False),
    ("websocket", None, "/api/ws", False), ("websocket", None, "/x", False),
])
def test_is_public(scope_type, method, path, public):
    assert is_public(scope_type, method, path) is public


def test_the_gate_admits_head_healthz_as_a_session_would(
        anon_client, client_cookie):
    # The gate admits it; what it answers is the route's business. The
    # route is GET-only, so the router answers 405 with or without a
    # session.
    anonymous = anon_client.head("/healthz").status_code
    anon_client.cookies.set("pkm_session", client_cookie)
    assert anonymous == anon_client.head("/healthz").status_code
    assert anonymous != 401


def test_an_expired_cookie_still_reaches_the_login_page_and_shell(
        seeded_config, tmp_path):
    app = _walk_app(seeded_config, tmp_path)
    expired = sign_session(bytes.fromhex(seeded_config.session_secret),
                           int(time.time() * 1000) - TWO_YEARS_MS)
    client = TestClient(app, cookies={"pkm_session": expired})
    assert client.get("/login").status_code == 200
    assert client.get("/").status_code == 200
    assert client.get("/api/sidebar").status_code == 401


LOGIN_PREFIX = b'{"password":"'
LOGIN_SUFFIX = b'"}'


def _login_body(size: int) -> bytes:
    """A wrong-password login body of exactly `size` bytes."""
    fill = size - len(LOGIN_PREFIX) - len(LOGIN_SUFFIX)
    return LOGIN_PREFIX + b"x" * fill + LOGIN_SUFFIX


def test_a_login_declaring_a_body_past_the_cap_is_refused_unread(
        seeded_config):
    app = create_app(seeded_config)
    s = run(_stream(app, "POST", "/api/login", "application/json", MiB64,
                    prefix=LOGIN_PREFIX, suffix=LOGIN_SUFFIX,
                    headers=[(b"content-length", b"67108864")]))
    assert (s.status, s.consumed) == (413, 0)
    assert json.loads(s.body) == {"detail": "request body too large"}


def test_a_streamed_login_body_past_the_cap_stops_at_the_cap(seeded_config):
    app = create_app(seeded_config)
    s = run(_stream(app, "POST", "/api/login", "application/json", MiB64,
                    chunk=1024, prefix=LOGIN_PREFIX, suffix=LOGIN_SUFFIX))
    assert s.status == 413
    assert s.consumed <= PUBLIC_BODY_MAX_BYTES + 1024
    assert json.loads(s.body) == {"detail": "request body too large"}


def test_a_login_body_at_the_cap_reaches_the_route(seeded_config):
    at_cap = _login_body(PUBLIC_BODY_MAX_BYTES)
    s = run(_stream(create_app(seeded_config), "POST", "/api/login",
                    "application/json", 0, prefix=at_cap))
    assert s.status == 401  # wrong password, not 413
    assert json.loads(s.body) == {"detail": "wrong password"}
    s = run(_stream(create_app(seeded_config), "POST", "/api/login",
                    "application/json", 0,
                    prefix=_login_body(PUBLIC_BODY_MAX_BYTES + 1)))
    assert s.status == 413


def test_a_login_split_across_messages_logs_in(seeded_config):
    body = json.dumps({"password": TEST_PASSWORD}).encode()
    s = run(_stream(create_app(seeded_config), "POST", "/api/login",
                    "application/json", 0,
                    parts=[body[:5], body[5:11], body[11:]]))
    assert s.status == 200
    assert any(k == b"set-cookie" and v.startswith(b"pkm_session=")
               for k, v in s.headers)


def test_a_logged_in_client_can_log_in_again(client):
    r = client.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200


def test_a_disconnect_during_the_login_read_calls_nothing():
    called: list[bool] = []
    sent: list[dict] = []

    async def inner(scope, receive, send) -> None:
        called.append(True)

    messages = iter([
        {"type": "http.request", "body": b"a" * 1024, "more_body": True},
        {"type": "http.disconnect"},
    ])

    async def receive():
        return next(messages)

    async def send(message) -> None:
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/api/login",
             "root_path": "", "headers": [], "query_string": b""}
    asyncio.run(AuthGateMiddleware(inner)(scope, receive, send))
    assert called == []
    assert sent == []


def test_after_the_replay_the_route_reads_the_clients_own_messages():
    seen: list[dict] = []

    async def inner(scope, receive, send) -> None:
        seen.append(await receive())
        seen.append(await receive())

    messages = iter([
        {"type": "http.request", "body": b"ab", "more_body": True},
        {"type": "http.request", "body": b"cd", "more_body": False},
        {"type": "http.disconnect"},
    ])

    async def receive():
        return next(messages)

    async def send(message) -> None:
        raise AssertionError(message)

    scope = {"type": "http", "method": "POST", "path": "/api/login",
             "root_path": "", "headers": [], "query_string": b""}
    asyncio.run(AuthGateMiddleware(inner)(scope, receive, send))
    assert seen == [
        {"type": "http.request", "body": b"abcd", "more_body": False},
        {"type": "http.disconnect"},
    ]


@pytest.mark.parametrize("headers,over", [
    ([], False), ([(b"content-length", b"8192")], False),
    ([(b"content-length", b"8193")], True),
    ([(b"content-length", b"abc")], False),
    ([(b"content-length", b"1"), (b"content-length", b"99999")], True),
    ([(b"content-length", b"9" * 5000)], False),
])
def test_declared_over_cap(headers, over):
    assert declared_over_cap(headers, 8192) is over


# A real uvicorn socket, loaded as `run.uvicorn_config` loads production's.
# The client declares a large body and sends only the start of it, or none.
# An answer can come back only if the server answered without the rest:
# a server that read the whole body would still be waiting for it.

# cfg.load() imports uvicorn's websockets protocol, which warns on import.
_uvicorn_warning = pytest.mark.filterwarnings(
    "ignore:websockets.*is deprecated:DeprecationWarning")


class _Pulled:
    """ASGI wrapper counting the body bytes the app takes from `receive`."""

    def __init__(self, app) -> None:
        self.app = app
        self.bytes = 0

    async def __call__(self, scope, receive, send) -> None:
        async def counting():
            message = await receive()
            self.bytes += len(message.get("body", b""))
            return message

        await self.app(scope, counting, send)


@contextmanager
def _serving(app) -> Generator[int, None, None]:
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


def _status_before_the_body_ends(port: int, head: bytes, sent: bytes) -> bytes:
    """The status line the server sends while the body is unfinished."""
    with socket.create_connection(("127.0.0.1", port), timeout=5) as conn:
        conn.sendall(head + sent)
        return conn.recv(65536).split(b"\r\n", 1)[0]


@_uvicorn_warning
def test_over_a_real_socket_an_anonymous_body_is_refused_unread(
        seeded_config):
    app = _Pulled(create_app(seeded_config))
    head = (b"POST /api/ops HTTP/1.1\r\nHost: x\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: 67108864\r\n\r\n")
    with _serving(app) as port:
        status = _status_before_the_body_ends(port, head, b"a" * (1 << 20))
    assert status == b"HTTP/1.1 401 Unauthorized"
    assert app.bytes == 0


@_uvicorn_warning
def test_over_a_real_socket_a_login_past_the_cap_is_refused(seeded_config):
    app = _Pulled(create_app(seeded_config))
    declared = (b"POST /api/login HTTP/1.1\r\nHost: x\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: 67108864\r\n\r\n")
    chunked = (b"POST /api/login HTTP/1.1\r\nHost: x\r\n"
               b"Content-Type: application/json\r\n"
               b"Transfer-Encoding: chunked\r\n\r\n")
    chunks = b"".join(b"400\r\n" + b"a" * 1024 + b"\r\n" for _ in range(16))
    with _serving(app) as port:
        assert _status_before_the_body_ends(port, declared, b"") == (
            b"HTTP/1.1 413 Request Entity Too Large")
        assert app.bytes == 0
        assert _status_before_the_body_ends(port, chunked, chunks) == (
            b"HTTP/1.1 413 Request Entity Too Large")
    assert app.bytes <= 16 * 1024
