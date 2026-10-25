from conftest import asgi_request
from fastapi.testclient import TestClient

from pkm.server.app import create_app
from test_spa import _config, _dist, minted_session

HEADER = "x-dns-prefetch-control"


def test_every_response_turns_dns_prefetch_off(tmp_path):
    cfg = _config(tmp_path, web_dist=_dist(tmp_path))
    app = create_app(cfg)
    client = TestClient(app)
    answers = {
        "anonymous 401": client.get("/api/sidebar"),
        "login page": client.get("/login"),
        "SPA index": client.get("/"),
        "static asset": client.get("/app-assets/main.js"),
        "asset 404": client.get("/app-assets/missing.js"),
        "API 404": TestClient(app, cookies={
            "pkm_session": minted_session()}).get("/api/nonexistent"),
    }
    assert answers["anonymous 401"].status_code == 401
    assert answers["static asset"].status_code == 200
    assert answers["API 404"].status_code == 404
    for name, r in answers.items():
        assert r.headers.get(HEADER) == "off", name


def test_an_authenticated_json_response_turns_dns_prefetch_off(client):
    r = client.get("/api/sidebar")
    assert r.status_code == 200
    assert r.headers.get(HEADER) == "off"


def test_the_header_is_sent_exactly_once(tmp_path):
    app = create_app(_config(tmp_path, web_dist=_dist(tmp_path)))
    r = asgi_request(app, "GET", "/")
    assert r.headers.get_list(HEADER) == ["off"]
