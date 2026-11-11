"""Branded path parameters: the status each route answers for a malformed
segment, and the dependencies that parse them."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from pkm.server.app import create_app
from test_routes_models import _api_routes

_MALFORMED = [
    ("GET", "/api/block/no", 422, "malformed uid: 'no'"),
    ("GET", "/api/block/zzzzzz", 404, None),
    ("GET", "/api/block/x!/backlinks", 422, "malformed uid: 'x!'"),
    ("GET", "/api/block/uid_nope99/backlinks", 404, None),
    ("DELETE", "/api/assets/not-a-sha", 404, "asset not found"),
    ("GET", "/assets/not-a-sha/x.png", 404, "asset not found"),
    ("GET", "/api/goodlinks/not-hex", 404, "not found"),
]


@pytest.mark.parametrize(("method", "path", "status", "detail"), _MALFORMED)
def test_path_param_statuses(client, method, path, status, detail):
    r = client.request(method, path)
    assert r.status_code == status
    if detail is not None:
        assert r.json()["detail"] == detail


def test_malformed_link_id_is_not_found_with_a_gateway(goodlinks_client):
    r = goodlinks_client.get("/api/goodlinks/not-hex")
    assert (r.status_code, r.json()["detail"]) == (404, "not found")


@pytest.mark.parametrize(("method", "path", "status", "detail"), _MALFORMED)
def test_path_param_statuses_ask_for_login_first(anon_client, method, path,
                                                 status, detail):
    assert anon_client.request(method, path).status_code == 401



_BRANDED = {"uid": "path_uid", "sha256": "path_sha256",
            "link_id": "path_link_id"}


def test_branded_path_params_come_from_a_dependency(seeded_config):
    app = create_app(seeded_config)
    seen = 0
    for route in _api_routes(app.routes):
        for name, parser in _BRANDED.items():
            if "{" + name + "}" not in route.path:
                continue
            seen += 1
            own = [p.name for p in route.dependant.path_params]
            calls = [(getattr(d.call, "__module__", None),
                      getattr(d.call, "__name__", None))
                     for d in route.dependant.dependencies]
            assert name not in own, route.path
            assert ("pkm.server.path_params", parser) in calls, route.path
    assert seen == 5


def test_path_uid_parses_or_refuses_with_422():
    from pkm.server.path_params import path_uid
    assert path_uid("uid_b3") == "uid_b3"
    with pytest.raises(HTTPException) as e:
        path_uid("x!")
    assert (e.value.status_code, e.value.detail) == (422, "malformed uid: 'x!'")


def test_path_sha256_parses_or_is_not_found():
    from pkm.server.path_params import path_sha256
    assert path_sha256("a" * 64) == "a" * 64
    with pytest.raises(HTTPException) as e:
        path_sha256("A" * 64)
    assert (e.value.status_code, e.value.detail) == (404, "asset not found")


def test_path_link_id_parses_or_is_not_found():
    from pkm.server.path_params import path_link_id
    assert path_link_id("0" * 32) == "0" * 32
    with pytest.raises(HTTPException) as e:
        path_link_id("not-hex")
    assert (e.value.status_code, e.value.detail) == (404, "not found")
