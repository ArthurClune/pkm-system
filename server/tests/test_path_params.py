"""Branded path parameters: the status each route answers for a malformed
segment, and the dependencies that parse them."""
from __future__ import annotations

import pytest

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

