import os

import pytest
from fastapi.testclient import TestClient

from pkm.server.app import create_app
from pkm.server.config import Config


def _dist(tmp_path):
    dist = tmp_path / "dist"
    (dist / "app-assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        "<!doctype html><div id=\"root\"></div>", encoding="utf-8")
    return dist


def _config(tmp_path, web_dist=None) -> Config:
    return Config(
        db_path=tmp_path / "pkm.sqlite3",
        assets_dir=tmp_path / "assets",
        password_salt="00" * 16,
        password_hash="ab" * 32,
        session_secret="cd" * 32,
        cookie_secure=False,
        web_dist=web_dist,
    )


def test_header_on_spa_healthz_and_unauthenticated_api(tmp_path):
    dist = _dist(tmp_path)
    (dist / "build-id.json").write_text('{"build": "abc-123"}')
    client = TestClient(create_app(_config(tmp_path, web_dist=dist)))
    assert client.get("/").headers["x-pkm-build"] == "abc-123"
    assert client.get("/healthz").headers["x-pkm-build"] == "abc-123"
    r = client.get("/api/sidebar")
    assert r.status_code == 401
    assert r.headers["x-pkm-build"] == "abc-123"


@pytest.mark.parametrize("content", [
    None, "not json", '{"nope": 1}', '{"build": 7}', '{"build": ""}',
    '["abc"]', '{"build": "a\\r\\nb"}', '{"build": "' + "x" * 65 + '"}'])
def test_no_header_without_a_valid_stamp(tmp_path, content):
    dist = _dist(tmp_path)
    if content is not None:
        (dist / "build-id.json").write_text(content)
    client = TestClient(create_app(_config(tmp_path, web_dist=dist)))
    r = client.get("/")
    assert r.status_code == 200
    assert "x-pkm-build" not in r.headers


def test_no_header_without_web_dist(tmp_path):
    client = TestClient(create_app(_config(tmp_path)))
    assert "x-pkm-build" not in client.get("/healthz").headers


def _write_stamp(dist, build, mtime_ns):
    path = dist / "build-id.json"
    path.write_text('{"build": "%s"}' % build)
    os.utime(path, ns=(mtime_ns, mtime_ns))


def test_header_follows_a_rebuild_without_a_restart(tmp_path):
    dist = _dist(tmp_path)
    _write_stamp(dist, "first", 1_000_000_000_000_000_000)
    client = TestClient(create_app(_config(tmp_path, web_dist=dist)))
    assert client.get("/healthz").headers["x-pkm-build"] == "first"
    _write_stamp(dist, "second", 2_000_000_000_000_000_000)
    assert client.get("/healthz").headers["x-pkm-build"] == "second"


def test_header_appears_and_goes_with_the_stamp_file(tmp_path):
    dist = _dist(tmp_path)
    client = TestClient(create_app(_config(tmp_path, web_dist=dist)))
    assert "x-pkm-build" not in client.get("/healthz").headers
    _write_stamp(dist, "late", 1_000_000_000_000_000_000)
    assert client.get("/healthz").headers["x-pkm-build"] == "late"
    (dist / "build-id.json").unlink()
    assert "x-pkm-build" not in client.get("/healthz").headers
