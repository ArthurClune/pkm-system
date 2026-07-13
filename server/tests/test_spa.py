import json

from fastapi.testclient import TestClient

from pkm.server.app import create_app
from pkm.server.config import Config, load_config
from pkm.server.setup import main as setup_main


def _dist(tmp_path):
    dist = tmp_path / "dist"
    (dist / "app-assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        "<!doctype html><div id=\"root\"></div>", encoding="utf-8")
    (dist / "app-assets" / "main.js").write_text(
        "console.log('pkm')", encoding="utf-8")
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


def test_spa_served_when_web_dist_set(tmp_path):
    client = TestClient(create_app(_config(tmp_path, web_dist=_dist(tmp_path))))
    r = client.get("/")
    assert r.status_code == 200
    assert "<!doctype html" in r.text
    deep = client.get("/page/Machine%20Learning")  # client-side route
    assert deep.status_code == 200 and deep.text == r.text
    js = client.get("/app-assets/main.js")
    assert js.status_code == 200
    assert "javascript" in js.headers["content-type"]


def test_index_html_is_not_cached(tmp_path):
    client = TestClient(create_app(_config(tmp_path, web_dist=_dist(tmp_path))))
    r = client.get("/")
    assert r.headers["cache-control"] == "no-cache"
    deep = client.get("/page/Machine%20Learning")  # client-side route
    assert deep.headers["cache-control"] == "no-cache"
    # hashed assets should remain cacheable, not forced to revalidate
    js = client.get("/app-assets/main.js")
    assert js.headers.get("cache-control") != "no-cache"


def test_api_and_asset_routes_not_shadowed(tmp_path):
    client = TestClient(create_app(_config(tmp_path, web_dist=_dist(tmp_path))))
    assert client.get("/healthz").json() == {"ok": True}
    assert client.get("/api/search", params={"q": "x"}).status_code == 401
    assert client.get("/login").status_code == 200  # login page, not index.html
    # unknown api/assets paths 404 rather than returning HTML
    assert client.get("/api/nonexistent").status_code == 404
    assert client.get("/assets/not-a-sha").status_code == 404
    # bare prefixes (no trailing slash) also 404, never HTML
    assert client.get("/api").status_code == 404
    assert client.get("/assets").status_code == 404
    assert client.get("/app-assets").status_code == 404
    assert client.get("/app-assets/does-not-exist.js").status_code == 404


def test_root_level_dist_files_served_not_shadowed(tmp_path):
    # the PWA needs real files at the root scope: sw.js served as HTML would
    # break service-worker registration outright
    dist = _dist(tmp_path)
    (dist / "sw.js").write_text("self.addEventListener('fetch', () => {})",
                                encoding="utf-8")
    (dist / "manifest.webmanifest").write_text("{}", encoding="utf-8")
    client = TestClient(create_app(_config(tmp_path, web_dist=dist)))
    sw = client.get("/sw.js")
    assert sw.status_code == 200
    assert "javascript" in sw.headers["content-type"]
    # the SW byte-compares itself on update checks: never cache it
    assert sw.headers["cache-control"] == "no-cache"
    assert client.get("/manifest.webmanifest").status_code == 200
    # directories and traversal never leak; client routes still fall back
    assert client.get("/app-assets/../index.html").status_code in (200, 404)
    assert "<!doctype html" in client.get("/page/Whatever").text


def test_without_web_dist_root_is_404(tmp_path):
    client = TestClient(create_app(_config(tmp_path)))
    assert client.get("/").status_code == 404


def test_load_config_resolves_web_dist_relative(tmp_path):
    cfg = {"db_file": "pkm.sqlite3", "assets_dir": "assets",
           "password_salt": "00" * 16, "password_hash": "ab" * 32,
           "session_secret": "cd" * 32, "web_dist": "../web/dist"}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    loaded = load_config(path)
    assert loaded.web_dist == tmp_path / "../web/dist"
    cfg.pop("web_dist")
    path.write_text(json.dumps(cfg), encoding="utf-8")
    assert load_config(path).web_dist is None


def test_setup_writes_web_dist_only_when_given(tmp_path):
    assert setup_main(["--data-dir", str(tmp_path / "a"), "--password", "pw",
                       "--insecure-cookie", "--web-dist", "../web/dist"]) == 0
    cfg = load_config(tmp_path / "a" / "config.json")
    assert cfg.web_dist == tmp_path / "a" / "../web/dist"
    assert cfg.cookie_secure is False
    assert setup_main(["--data-dir", str(tmp_path / "b"),
                       "--password", "pw"]) == 0
    assert load_config(tmp_path / "b" / "config.json").web_dist is None
