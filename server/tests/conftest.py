import asyncio
import os
from collections.abc import Iterator, Sequence
from pathlib import Path

import httpx
import pytest
from fake_engine import FakeEngine
from fastapi.testclient import TestClient

from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db, open_db
from pkm.contracts.responses import BlockNode
from pkm.test_data.ids import goodlinks_id_of, order_idx_of, uid_of

# every Db a test opens checks its rows against pkm.rows.Row
os.environ["PKM_ROW_CHECK"] = "1"

TEST_PASSWORD = "test-pw"
TEST_SALT = bytes.fromhex("00" * 16)

SEED_PAGES = [
    (1, "Machine Learning", 1000, 2000),
    (2, "AI", None, None),
    (3, "July 7th, 2026", None, None),
    (4, "Paper", None, None),
    (5, "Attention Is All You Need", None, None),
]
SEED_BLOCKS = [
    ("uid_b1", 1, None, 0, "Tags:: #AI", None, 0, None, None),
    ("uid_b2", 1, None, 1, "Papers", 2, 0, None, None),
    ("uid_b3", 1, "uid_b2", 0, "[[Attention Is All You Need]] is a [[Paper]]",
     None, 0, None, None),
    ("uid_b4", 3, None, 0, "Studying [[Machine Learning]] today", None, 0, None, None),
    ("uid_b5", 3, None, 1, "See ((uid_b3)) for details", None, 0, None, None),
    ("uid_b6", 2, None, 0, "AI overview mentions Machine Learning in plain text",
     None, 0, None, None),
]
SEED_REFS = [
    ("uid_b1", 2, "tag"),
    ("uid_b3", 5, "link"),
    ("uid_b3", 4, "link"),
    ("uid_b4", 1, "link"),
]
SEED_BLOCK_REFS = [
    ("uid_b5", "uid_b3"),  # "See ((uid_b3)) for details"
]


def make_config(root: Path) -> Config:
    (root / "assets").mkdir(exist_ok=True)
    return Config(
        db_path=root / "pkm.sqlite3",
        assets_dir=root / "assets",
        password_salt=TEST_SALT.hex(),
        password_hash=hash_password(TEST_PASSWORD, TEST_SALT),
        session_secret="cd" * 32,
        cookie_secure=False,
        openai_api_key_file=root / "openai_key",
        zai_api_key_file=root / "zai_key",
        goodlinks_api_key_file=root / "goodlinks_key",
    )


def seed_db(db_path: Path) -> None:
    init_db(db_path)  # WAL mode + base schema, once, before any open_db() call
    con = open_db(db_path)
    con.executemany("INSERT INTO pages VALUES (?,?,?,?)", SEED_PAGES)
    con.executemany(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
        " heading, collapsed, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)", SEED_BLOCKS)
    con.executemany("INSERT INTO refs VALUES (?,?,?)", SEED_REFS)
    con.executemany("INSERT INTO block_refs VALUES (?,?)", SEED_BLOCK_REFS)
    con.commit()
    con.close()


@pytest.fixture()
def seeded_config(tmp_path) -> Config:
    config = make_config(tmp_path)
    seed_db(config.db_path)
    return config


@pytest.fixture()
def anon_client(seeded_config) -> TestClient:
    return TestClient(create_app(seeded_config))


@pytest.fixture()
def client(anon_client) -> TestClient:
    r = anon_client.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    return anon_client


@pytest.fixture()
def pkm_client(anon_client):
    """A PkmClient driving the in-process app: real login, explicit
    Cookie header (the jar is cleared so the header is what authenticates)."""
    from pkm.client.api import PkmClient
    from pkm.client.core import CliConfig

    r = anon_client.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    token = anon_client.cookies["pkm_session"]
    anon_client.cookies.clear()
    cfg = CliConfig(url="http://testserver", token=token)
    return PkmClient(cfg, http=anon_client)


@pytest.fixture()
def seed_backlinks(seeded_config):
    """Factory: insert `count` extra pages, each with one block
    referencing "Machine Learning" (page_id 1) via [[...]]. Lets
    backlink-pagination tests exceed the route's single-request group cap
    (100, routes_pages.py) without hand-rolling the DB inserts in every
    test file."""
    def _seed(count: int, start_id: int = 100) -> None:
        con = open_db(seeded_config.db_path)
        pages = [(start_id + i, f"BL Source {i:03d}", None, None)
                 for i in range(count)]
        blocks = [(f"uid_bl_{i:03d}", start_id + i, None, 0,
                   "[[Machine Learning]] mention", None, 0, None, None)
                  for i in range(count)]
        refs = [(f"uid_bl_{i:03d}", 1, "link") for i in range(count)]
        con.executemany("INSERT INTO pages VALUES (?,?,?,?)", pages)
        con.executemany(
            "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
            " heading, collapsed, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)", blocks)
        con.executemany("INSERT INTO refs VALUES (?,?,?)", refs)
        con.commit()
        con.close()
    return _seed


@pytest.fixture()
def fake_engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture()
def assistant_client(seeded_config, fake_engine) -> Iterator[TestClient]:
    with TestClient(create_app(seeded_config, assistant_engine=fake_engine)) as c:
        r = c.post("/api/login", json={"password": TEST_PASSWORD})
        assert r.status_code == 200
        yield c


@pytest.fixture(autouse=True)
def _no_ambient_openai_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ZAI_API_KEY", raising=False)
    monkeypatch.delenv("GOODLINKS_API_KEY", raising=False)


@pytest.fixture()
def describe_client(seeded_config) -> Iterator[TestClient]:
    """TestClient (lifespan running, so the describe worker is live) whose
    DescribeService wraps a FakeDescriber."""
    from fake_describer import FakeDescriber
    from pkm.describe.service import DescribeService

    service = DescribeService(seeded_config, FakeDescriber(), None)
    app = create_app(seeded_config, describe_service=service)
    with TestClient(app) as c:
        r = c.post("/api/login", json={"password": TEST_PASSWORD})
        assert r.status_code == 200
        yield c


@pytest.fixture()
def describe_disabled_client(seeded_config) -> Iterator[TestClient]:
    from pkm.describe.service import DescribeService

    service = DescribeService(
        seeded_config, None,
        "no openai_key file and OPENAI_API_KEY is not set")
    with TestClient(create_app(seeded_config, describe_service=service)) as c:
        r = c.post("/api/login", json={"password": TEST_PASSWORD})
        assert r.status_code == 200
        yield c


async def _asgi_get_all(app, cookies, urls, headers) -> list[httpx.Response]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver",
                                 cookies=cookies, headers=headers) as c:
        return [await c.get(u) for u in urls]


def asgi_get_all(app, cookie: str, urls: list[str],
                 headers: dict[str, str] | None = None) -> list[httpx.Response]:
    """GET each url through the ASGI app, logged in with `cookie`. Not
    `TestClient`: starlette's decodes the percent-escapes in a path a
    second time before routing, so a file called `%41` would be served as
    `A`; uvicorn decodes once, as `httpx.ASGITransport` does. Use this for
    any test whose path carries a literal percent sign."""
    return asyncio.run(_asgi_get_all(app, {"pkm_session": cookie}, urls, headers))


def single_decode_get(client: TestClient, url: str,
                      headers: dict[str, str] | None = None) -> httpx.Response:
    """`asgi_get_all` for one url, reusing a logged-in TestClient's app."""
    return asgi_get_all(client.app, client.cookies["pkm_session"], [url], headers)[0]


def asgi_request(app, method: str, path: str, cookie: str | None = None,
                 raise_app_exceptions: bool = True) -> httpx.Response:
    """One `method` request for `path` through the ASGI app, decoded once as
    `asgi_get_all` explains. Anonymous unless `cookie` is given. With
    `raise_app_exceptions` off an unhandled error becomes a 500 response, so
    its body can still be inspected."""
    async def run():
        transport = httpx.ASGITransport(
            app=app, raise_app_exceptions=raise_app_exceptions)
        cookies = {"pkm_session": cookie} if cookie else None
        async with httpx.AsyncClient(transport=transport, cookies=cookies,
                                     base_url="http://testserver") as c:
            return await c.request(method, path)
    return asyncio.run(run())


@pytest.fixture()
def local_root(tmp_path) -> Path:
    """A throwaway local_docs_root with one PDF, one zip, one nested
    folder, one evicted-file stub, and one filename containing a
    literal percent sign (double-decode regression coverage)."""
    root = tmp_path / "localdocs"
    (root / "Papers" / "ML").mkdir(parents=True)
    (root / "Papers" / "ML" / "Title one.pdf").write_bytes(b"%PDF-1.4\n%fake\n")
    (root / "Papers" / "ML" / "bundle.zip").write_bytes(b"PK\x03\x04zip")
    (root / "Papers" / ".Gone.pdf.icloud").write_bytes(b"stub")
    (root / "Papers" / "ML" / "50% draft.pdf").write_bytes(b"%PDF-1.4\n%fake\n")
    return root


@pytest.fixture()
def local_client(seeded_config, local_root) -> TestClient:
    from dataclasses import replace
    cfg = replace(seeded_config, local_docs_root=local_root)
    c = TestClient(create_app(cfg))
    r = c.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    return c


@pytest.fixture()
def local_pkm_client(local_client):
    """`pkm_client`, but against an app with `local_docs_root` set, so
    CLI tests can drive `pkm local check` in-process."""
    from pkm.client.api import PkmClient
    from pkm.client.core import CliConfig

    token = local_client.cookies["pkm_session"]
    local_client.cookies.clear()
    return PkmClient(CliConfig(url="http://testserver", token=token), http=local_client)


class FakeGoodlinks:
    """An in-memory GoodLinks library behind an httpx2.MockTransport. Tests
    seed `links` (id -> link dict) and `html` (id -> reader html), and read
    `requests` afterwards to assert what the routes asked for."""

    def __init__(self) -> None:
        self.links: dict[str, dict] = {}
        self.html: dict[str, str] = {}
        self.requests: list[tuple[str, str]] = []
        self.down = False
        self.reject_save: str | None = None
        self.unauthorized = False

    def handler(self, req):
        import json as _json
        import httpx2
        self.requests.append((req.method, str(req.url)))
        if self.down:
            raise httpx2.ConnectError("refused")
        if self.unauthorized:
            return httpx2.Response(401, json={"error": "Unauthorized"})
        path = req.url.path
        if path.endswith("/links") and req.method == "GET":
            url = req.url.params.get("url")
            if url is not None:
                for link in self.links.values():
                    if link["url"] == url:
                        return httpx2.Response(200, json=link)
                return httpx2.Response(404, json={"error": "Not Found"})
            q = req.url.params.get("search", "")
            hits = [link for link in self.links.values()
                    if q in link["url"] or q in link.get("title", "")]
            return httpx2.Response(200, json={"data": hits, "hasMore": False})
        if path.endswith("/links") and req.method == "POST":
            if self.reject_save:
                return httpx2.Response(400, json={"error": self.reject_save})
            body = _json.loads(req.content)
            new_id = ("f" * 32)
            link = {"id": new_id, "url": body["url"], "title": "Saved " + body["url"],
                    "addedAt": "2026-09-23T10:00:00Z", "readAt": "2026-09-23T10:00:00Z"}
            self.links[new_id] = link
            self.requests.append(("POST-BODY", _json.dumps(body, sort_keys=True)))
            return httpx2.Response(200, json=link)
        if path.endswith("/content"):
            link_id = path.rsplit("/", 2)[-2]
            if link_id in self.html:
                return httpx2.Response(200, text=self.html[link_id],
                                       headers={"content-type": "text/html"})
            return httpx2.Response(404, json={"error": "Not Found"})
        link_id = path.rsplit("/", 1)[-1]
        if link_id in self.links:
            return httpx2.Response(200, json=self.links[link_id])
        return httpx2.Response(404, json={"error": "Not Found"})


GL_ID = goodlinks_id_of("e4966bb2483b5c78f658398c0ae7b03f")


@pytest.fixture()
def fake_goodlinks() -> FakeGoodlinks:
    fake = FakeGoodlinks()
    fake.links[GL_ID] = {"id": GL_ID, "url": "https://tratt.net/uml.html", "title": "UML",
                         "addedAt": "2022-10-06T15:07:12Z"}
    fake.html[GL_ID] = '<div><p>Hello <script>alert(1)</script><a href="https://x.example">x</a></p></div>'
    return fake


@pytest.fixture()
def goodlinks_client(seeded_config, fake_goodlinks) -> TestClient:
    import httpx2
    from pkm.server.goodlinks_gateway import GoodlinksGateway

    http = httpx2.Client(transport=httpx2.MockTransport(fake_goodlinks.handler),
                         base_url="http://goodlinks.test/api/v1")
    gw = GoodlinksGateway("http://goodlinks.test/api/v1", "tok", http=http)
    c = TestClient(create_app(seeded_config, goodlinks_gateway=gw))
    r = c.post("/api/login", json={"password": TEST_PASSWORD})
    assert r.status_code == 200
    return c


@pytest.fixture()
def goodlinks_pkm_client(goodlinks_client):
    """`pkm_client`, but against an app with a GoodLinks gateway, so CLI
    tests can drive `pkm goodlinks check` in-process."""
    from pkm.client.api import PkmClient
    from pkm.client.core import CliConfig

    token = goodlinks_client.cookies["pkm_session"]
    goodlinks_client.cookies.clear()
    return PkmClient(CliConfig(url="http://testserver", token=token), http=goodlinks_client)


def tree_node(text: str, children: Sequence[BlockNode] = ()) -> BlockNode:
    """A build_tree() node for renderer tests that only care about text and
    nesting."""
    return BlockNode(
        uid=uid_of("tuid-node"), text=text, heading=None, view_type=None,
        collapsed=False, order_idx=order_idx_of(0), created_at=None,
        updated_at=None, children=list(children))
