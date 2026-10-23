import asyncio
import json

import httpx
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


def test_a_cold_load_of_a_title_with_a_newline_serves_the_spa(tmp_path):
    client = TestClient(create_app(_config(tmp_path, web_dist=_dist(tmp_path))))
    root = client.get("/")
    for path in ("/page/Fo%0Ao", "/page/Foo%0A"):
        r = client.get(path)
        assert r.status_code == 200 and r.text == root.text, path


def _dist_with_outside_files(tmp_path):
    """A dist beside a secret file, a prefix-sibling directory and links:
    one pointing out of the dist, and a loop."""
    dist = _dist(tmp_path)
    (tmp_path / "secret.txt").write_text("SECRET-OUTSIDE", encoding="utf-8")
    (tmp_path / "distsecret").mkdir()
    (tmp_path / "distsecret" / "s.txt").write_text("PREFIX-SIBLING",
                                                   encoding="utf-8")
    (dist / "link-out").symlink_to(tmp_path / "secret.txt")
    (dist / "loop2").symlink_to(dist / "loop1")
    (dist / "loop1").symlink_to(dist / "loop2")
    return dist


def _get_raw(app, paths):
    """Each path sent exactly as written, decoded once as uvicorn does
    (TestClient would decode its escapes a second time). Unhandled errors
    become 500 responses so a body can still be inspected."""
    async def run():
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport) as c:
            return [await c.get("http://testserver" + p) for p in paths]
    return asyncio.run(run())


def test_the_catch_all_never_serves_a_file_outside_the_dist(tmp_path):
    """Encoded traversal, an absolute path, a sibling whose name starts
    with the dist's, and a link pointing out must each answer with the
    shell or a 404, never with the bytes of a file outside the dist."""
    dist = _dist_with_outside_files(tmp_path)
    secret = str(tmp_path / "secret.txt")
    paths = [
        "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt",
        "//" + secret.lstrip("/"), "/" + secret.lstrip("/"),
        "/..%5csecret.txt", "/app-assets/..%2f..%2fsecret.txt",
        "/app-assets/%2e%2e/%2e%2e/secret.txt", "/..%2fdistsecret/s.txt",
        "/%2e%2e%2fdistsecret%2fs.txt", "/link-out", "/loop1", "/sw.js%0a",
        "/%0a", "/%ff%fe", "/./link-out", "/link-out/", "/dist/../secret.txt",
    ]
    app = create_app(_config(tmp_path, web_dist=dist))
    for path, r in zip(paths, _get_raw(app, paths)):
        assert "SECRET-OUTSIDE" not in r.text, path
        assert "PREFIX-SIBLING" not in r.text, path
    served = _get_raw(app, ["/"])[0]
    assert served.status_code == 200
