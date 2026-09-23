from collections.abc import Iterator
from pathlib import Path

import pytest
from fake_engine import FakeEngine
from fastapi.testclient import TestClient

from pkm.server.app import create_app
from pkm.server.auth_core import hash_password
from pkm.server.config import Config
from pkm.server.db import init_db, open_db

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


@pytest.fixture()
def seeded_config(tmp_path) -> Config:
    db_path = tmp_path / "pkm.sqlite3"
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
    (tmp_path / "assets").mkdir()
    return Config(
        db_path=db_path,
        assets_dir=tmp_path / "assets",
        password_salt=TEST_SALT.hex(),
        password_hash=hash_password(TEST_PASSWORD, TEST_SALT),
        session_secret="cd" * 32,
        cookie_secure=False,
        openai_api_key_file=tmp_path / "openai_key",
        zai_api_key_file=tmp_path / "zai_key",
        goodlinks_api_key_file=tmp_path / "goodlinks_key",
    )


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
    backlink-pagination tests (pkm-3cyg) exceed the route's
    single-request group cap (100, routes_pages.py) without hand-rolling
    the DB inserts in every test file."""
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

    def handler(self, req):
        import json as _json
        import httpx2
        self.requests.append((req.method, str(req.url)))
        if self.down:
            raise httpx2.ConnectError("refused")
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


GL_ID = "e4966bb2483b5c78f658398c0ae7b03f"


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
