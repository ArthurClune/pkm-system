"""The two sync routes gzip their own bodies, in the route's worker thread."""
import inspect
import json

import pytest

from pkm.server import routes_sync
from pkm.server.http_encoding import GZIP_MIN_BYTES


def _get(client, url, accept):
    headers = {} if accept is None else {"Accept-Encoding": accept}
    r = client.get(url, headers=headers)
    assert r.status_code == 200
    return r


def test_the_snapshot_is_gzip_encoded_when_the_client_accepts_gzip(client):
    r = client.get("/api/sync/snapshot")
    assert r.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in r.headers["vary"].lower()
    assert r.json()["seq"] > 0


def test_a_changes_window_over_the_floor_is_gzip_encoded_and_a_small_one_is_not(
        client):
    big = client.get("/api/sync/changes?since=0&limit=1000")
    assert len(big.content) >= GZIP_MIN_BYTES
    assert big.headers["content-encoding"] == "gzip"
    latest = big.json()["latest_seq"]
    small = client.get(f"/api/sync/changes?since={latest}")
    assert "content-encoding" not in small.headers
    assert "accept-encoding" in small.headers["vary"].lower()
    assert small.json()["reset"] is False


@pytest.mark.parametrize("url", ["/api/sync/snapshot",
                                 "/api/sync/changes?since=0"])
def test_both_encodings_carry_the_same_json(client, url):
    plain = _get(client, url, "identity")
    packed = _get(client, url, "gzip")
    assert "content-encoding" not in plain.headers
    assert packed.headers["content-encoding"] == "gzip"
    assert json.loads(plain.content) == json.loads(packed.content)
    assert plain.headers["content-type"].startswith("application/json")
    assert packed.headers["content-type"].startswith("application/json")


# TestClient adds its own Accept-Encoding when none is given, so the
# absent-header case lives in test_http_encoding.
@pytest.mark.parametrize("accept", ["", "identity", "gzip;q=0", "*;q=0"])
@pytest.mark.parametrize("url", ["/api/sync/snapshot",
                                 "/api/sync/changes?since=0"])
def test_a_client_that_refuses_gzip_gets_a_plain_body(client, url, accept):
    r = _get(client, url, accept)
    assert "content-encoding" not in r.headers
    assert "accept-encoding" in r.headers["vary"].lower()
    json.loads(r.content)


def test_the_sync_routes_encode_in_a_worker_thread():
    # An async def would run the render and the gzip on the event loop.
    assert not inspect.iscoroutinefunction(routes_sync.sync_snapshot)
    assert not inspect.iscoroutinefunction(routes_sync.sync_changes)
