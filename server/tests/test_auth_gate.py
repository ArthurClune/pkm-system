import asyncio
import json
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient
from test_auth import _walk_app

from pkm.server.app import create_app
from pkm.server.auth_core import sign_session
from pkm.server.auth_gate_core import is_public

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
                  cookie: str | None = None) -> Sent:
    """Drives the ASGI app with a body of `prefix`, `total` bytes of filler
    and `suffix`, handed out lazily so a large body is never held whole."""
    sent = Sent()
    handed = 0
    pieces = iter([prefix, *[b"a" * chunk] * (total // chunk), suffix])

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


def test_head_healthz_answers_anonymously(anon_client, client_cookie):
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
