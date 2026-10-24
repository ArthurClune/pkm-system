"""The Origin guard on `/api/ws` and unsafe methods. Every tailnet host is
same-site with the app, so the `Lax` session cookie rides along on a
sibling host's WebSocket handshake and simple POSTs; these tests are the
security review's probes, turned round to expect a refusal."""
import dataclasses
from collections.abc import Callable, Iterator

import httpx2
import pytest
from conftest import TEST_PASSWORD
from fake_engine import FakeEngine
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from test_hostile_requests import _digest
from test_routes_models import _api_routes, fill_path

from pkm.server.app import create_app
from pkm.server.origin_core import (
    SAFE_METHODS, allowed_origins, canonical_origin, checks_origin,
    origin_allowed)

OWN = "https://pkm.tailnet-a.ts.net"
SIBLING = "https://other-host.tailnet-a.ts.net"
OTHER_TAILNET = "https://evil.tailnet-b.ts.net"

# The probe's upload: a PNG signature and 64 bytes of padding.
_PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64

_LOOPBACK_8975 = {"http://127.0.0.1:8975", "http://localhost:8975",
                  "http://[::1]:8975"}


@pytest.mark.parametrize("value,canonical", [
    ("HTTPS://PKM.Tailnet-A.ts.net/", "https://pkm.tailnet-a.ts.net"),
    ("https://h.example:443", "https://h.example"),
    ("http://h.example:80", "http://h.example"),
    ("https://h.example:8443", "https://h.example:8443"),
])
def test_canonical_origin_normalises(value, canonical):
    assert canonical_origin(value) == canonical


@pytest.mark.parametrize("value", [
    "pkm.tailnet-a.ts.net", "ftp://h.example", "https://h.example/app",
    "https://u@h.example", "https://h.example?q=1", "https://h.example#f",
    "https://", "https://h.example:99999", "null", ""])
def test_canonical_origin_refuses(value):
    with pytest.raises(ValueError):
        canonical_origin(value)


def test_allowed_origins_composes():
    assert allowed_origins(("https://biber.bobtail-dorian.ts.net",),
                           ("127.0.0.1", "100.122.144.66"), 8974) == {
        "https://biber.bobtail-dorian.ts.net", "http://127.0.0.1:8974",
        "http://100.122.144.66:8974", "http://localhost:8974",
        "http://[::1]:8974"}


def test_allowed_origins_without_serve_origins():
    assert allowed_origins((), ("127.0.0.1",), 8975) == _LOOPBACK_8975


def test_allowed_origins_brackets_an_ipv6_bind_host():
    assert "http://[fd7a::1]:8975" in allowed_origins((), ("fd7a::1",), 8975)


@pytest.mark.parametrize("scope_type,method,checked", [
    ("websocket", None, True),
    ("http", "POST", True), ("http", "PUT", True), ("http", "PATCH", True),
    ("http", "DELETE", True),
    ("http", "GET", False), ("http", "HEAD", False),
    ("http", "OPTIONS", False),
    ("lifespan", None, False),
])
def test_checks_origin(scope_type, method, checked):
    assert checks_origin(scope_type, method) is checked


@pytest.mark.parametrize("origins,allowed", [
    ([], True), ([OWN], True), (["http://127.0.0.1:8974"], True),
    ([SIBLING], False), (["null"], False), ([""], False),
    ([OWN, OWN], False), ([OWN + ":443"], False), ([OWN.upper()], False),
    ([OWN + "/"], False), (["http://127.0.0.1:8000"], False),
])
def test_origin_allowed(origins, allowed):
    allowed_set = allowed_origins((OWN,), ("127.0.0.1",), 8974)
    assert origin_allowed(origins, allowed_set) is allowed


@pytest.fixture()
def guarded_config(seeded_config):
    return dataclasses.replace(
        seeded_config, serve_origins=(OWN,),
        bind_hosts=("127.0.0.1", "100.64.0.7"))


@pytest.fixture()
def guarded_app(guarded_config):
    return create_app(guarded_config, api_port=8974,
                      assistant_engine=FakeEngine())


@pytest.fixture()
def guarded_anon(guarded_app) -> Iterator[TestClient]:
    with TestClient(guarded_app) as c:
        yield c


@pytest.fixture()
def guarded_client(guarded_anon) -> TestClient:
    r = guarded_anon.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    return guarded_anon


def _origin(origin: str | None) -> dict[str, str]:
    return {"Origin": origin} if origin is not None else {}


def _create_secret_op(client: TestClient, origin: str | None,
                      tag: str) -> httpx2.Response:
    return client.post("/api/ops", headers=_origin(origin), json={
        "client_id": "victim", "batch_id": f"batch-{tag}",
        "ops": [{"op": "create", "uid": f"secret{tag}", "page_title": "AI",
                 "parent_uid": None, "order_idx": 9,
                 "text": "SECRET-NOTE-TEXT"}]})


@pytest.mark.parametrize("origin", [SIBLING, OTHER_TAILNET, "null"])
def test_ws_refuses_a_foreign_origin(guarded_client, guarded_app, origin):
    with pytest.raises(WebSocketDisconnect) as exc:
        with guarded_client.websocket_connect(
                "/api/ws", headers={"Origin": origin}):
            pass
    assert exc.value.code == 4403
    assert guarded_app.state.hub._conns == set()


def test_ws_refuses_a_foreign_origin_before_the_cookie_check(guarded_anon):
    with pytest.raises(WebSocketDisconnect) as exc:
        with guarded_anon.websocket_connect(
                "/api/ws", headers={"Origin": SIBLING}):
            pass
    assert exc.value.code == 4403


@pytest.mark.parametrize("origin", [
    OWN, "http://100.64.0.7:8974", "http://127.0.0.1:8974",
    "http://localhost:8974", "http://[::1]:8974", None])
def test_ws_accepts_its_own_origins(guarded_client, origin):
    with guarded_client.websocket_connect("/api/ws",
                                          headers=_origin(origin)) as ws:
        r = _create_secret_op(guarded_client, origin, "own")
        assert r.status_code == 200, r.text
        frame = ws.receive_json()
    assert [op["text"] for op in frame["ops"]] == ["SECRET-NOTE-TEXT"]


def test_ws_anonymous_with_its_own_origin_is_still_4401(guarded_anon):
    with pytest.raises(WebSocketDisconnect) as exc:
        with guarded_anon.websocket_connect("/api/ws",
                                            headers={"Origin": OWN}):
            pass
    assert exc.value.code == 4401


Headers = dict[str, str]


def _journal_cleanup(c: TestClient, h: Headers, _cid: str) -> httpx2.Response:
    return c.post("/api/journal/cleanup",
                  headers={**h, "content-type": "text/plain"})


def _assets_scan(c: TestClient, h: Headers, _cid: str) -> httpx2.Response:
    return c.post("/api/assets/scan?force=true",
                  headers={**h, "content-type": "text/plain"})


def _close_beacon(c: TestClient, h: Headers, cid: str) -> httpx2.Response:
    return c.post(f"/api/assistant/conversations/{cid}",
                  headers={**h, "content-type": "text/plain"})


def _upload(c: TestClient, h: Headers, _cid: str) -> httpx2.Response:
    return c.post("/api/assets", headers=h,
                  files={"file": ("x.png", _PNG, "image/png")})


def _export_zip(c: TestClient, h: Headers, _cid: str) -> httpx2.Response:
    return c.post("/api/assets/export.zip", headers=h,
                  data={"sha256": ["0" * 64]})


# The probe's simple requests: no preflight, so a sibling page can send
# each with the cookie. Each takes an open conversation's id.
_SIMPLE: dict[str, Callable[[TestClient, Headers, str], httpx2.Response]] = {
    "journal-cleanup": _journal_cleanup,
    "assets-scan": _assets_scan,
    "close-beacon": _close_beacon,
    "upload": _upload,
    "export-zip": _export_zip,
}


def _conversation(c: TestClient) -> str:
    """A conversation for the close beacon, opened with no Origin."""
    return c.post("/api/assistant/conversations", json={}).json()["id"]


def _asset_files(config) -> list[str]:
    return sorted(str(p.relative_to(config.assets_dir))
                  for p in config.assets_dir.rglob("*"))


@pytest.mark.parametrize("name", _SIMPLE)
def test_simple_requests_refuse_a_foreign_origin(
        guarded_client, guarded_config, name):
    cid = _conversation(guarded_client)
    before, files = _digest(guarded_config), _asset_files(guarded_config)
    r = _SIMPLE[name](guarded_client, {"Origin": SIBLING}, cid)
    assert r.status_code == 403
    assert r.json() == {"detail": "origin not allowed"}
    assert _digest(guarded_config) == before
    assert _asset_files(guarded_config) == files


@pytest.mark.parametrize("name", _SIMPLE)
def test_simple_requests_pass_their_own_origin(guarded_client, name):
    r = _SIMPLE[name](guarded_client, {"Origin": OWN},
                      _conversation(guarded_client))
    assert r.status_code != 403, r.text


@pytest.mark.parametrize("name", _SIMPLE)
def test_simple_requests_pass_with_no_origin(guarded_client, name):
    r = _SIMPLE[name](guarded_client, {}, _conversation(guarded_client))
    assert r.status_code != 403, r.text


def test_every_unsafe_route_refuses_a_foreign_origin(
        guarded_client, guarded_app, guarded_config):
    before = _digest(guarded_config)
    answers = {}
    for route in _api_routes(guarded_app.routes):
        for method in sorted((route.methods or set()) - SAFE_METHODS):
            r = guarded_client.request(
                method, fill_path(route.path), content=b"{}",
                headers={"content-type": "text/plain;charset=UTF-8",
                         "Origin": SIBLING})
            answers[f"{method} {route.path}"] = r.status_code
    assert len(answers) > 20  # the walk found the routes
    assert {k: v for k, v in answers.items() if v != 403} == {}
    assert _digest(guarded_config) == before


def test_safe_methods_ignore_origin(guarded_client):
    r = guarded_client.get("/api/sidebar", headers={"Origin": SIBLING})
    assert r.status_code == 200


def test_a_refusal_carries_the_security_headers(guarded_client):
    r = _journal_cleanup(guarded_client, {"Origin": SIBLING}, "")
    assert r.status_code == 403
    assert r.headers["X-DNS-Prefetch-Control"] == "off"
